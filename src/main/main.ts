// Electron 主进程
import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } from 'electron';
import { join, resolve, sep } from 'path';
import { writeFileSync, existsSync, copyFileSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import * as dotenv from 'dotenv';
import { DataService, loadEffectiveConfig, resetUserConfig, saveUserConfig } from '../data';
import { mediaDir, readJson, writeJson } from '../data/store';
import { MiniMaxClient } from '../data/minimax';
import { TikHubClient } from '../data/tikhub-client';
import { runAiTask } from '../analysis/ai-tasks';
import { analyzeVideoWithRecovery, generateEditPlansSafe, breakdownViralVideoWithRecovery } from './sensitive-recovery';
import { renderPlans } from './ffmpeg';
import { EditMaterial, EditPlan } from '../analysis/ai-edit';
import { AppConfig, SocialVideo } from '../shared/types';
import { IPC_CHANNELS, IpcApi } from '../shared/ipc';
import { trace, Traced, setTraceSink } from '../shared/trace';

// 加载 .env：开发态用项目根目录；打包后用 resources/.env；最后兜底从 cwd 加载。
// 多重路径确保不同启动方式（npm run electron:dev / electron . / 打包后）都能读到令牌。
const envPath = app.isPackaged
  ? join(process.resourcesPath, '.env')
  : join(app.getAppPath(), '.env');
dotenv.config({ path: envPath });
dotenv.config();

let mainWindow: BrowserWindow | null = null;
const dataService = new DataService(loadEffectiveConfig());

/**
 * 用 Electron 网络栈（net.fetch，Chromium 通道）下载媒体字节，带浏览器 UA/Referer。
 * 规避 TikTok CDN 对 Node 原生 fetch（无浏览器指纹、不走系统代理）的连接重置/403 问题。
 */
async function downloadBufferWithBrowser(url: string, cancelSignal?: AbortSignal): Promise<Buffer> {
  // 60s 超时：避免单条媒体下载挂起导致「全部替换为本地路径」进度卡住；
  // 同时合并工作流取消信号（用户点「取消」时 abort 进行中的下载）
  const signal = cancelSignal
    ? AbortSignal.any([cancelSignal, AbortSignal.timeout(60_000)])
    : AbortSignal.timeout(60_000);
  const res = await net.fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Referer: 'https://www.tiktok.com/',
      Accept: 'video/mp4,video/*,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 处理流程追踪包装：每次调用前清空收集器，并通过 IPC 把每一步实时推给渲染进程
 * （实现「流式工作流」）。成功时把步骤挂到返回值，异常时挂到错误对象。
 */
function withTrace<T>(data: T): Traced<T> {
  if (data && typeof data === 'object') (data as any).trace = trace.snapshot();
  return data as Traced<T>;
}

/** 正在执行的任务注册表：runId → AbortController，供「取消」中断在途请求 */
const runningTasks = new Map<string, AbortController>();

async function withProgress<T>(
  sender: Electron.WebContents,
  runId: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<Traced<T>> {
  trace.reset();
  setTraceSink((step) => {
    try { sender.send(IPC_CHANNELS.progress, { runId, step }); } catch { /* 窗口已关闭 */ }
  });
  const ctrl = new AbortController();
  runningTasks.set(runId, ctrl);
  TikHubClient.activeSignal = ctrl.signal;
  try {
    const data = await fn(ctrl.signal);
    if (ctrl.signal.aborted) throw new Error('任务已取消');
    return withTrace(data);
  } catch (e: any) {
    if (ctrl.signal.aborted) {
      // 用户主动取消：统一抛「任务已取消」，避免底层 abort 错误透传
      const err = new Error('任务已取消');
      (err as any).canceled = true;
      (err as any).trace = trace.snapshot();
      throw err;
    }
    e.trace = trace.snapshot();
    throw e;
  } finally {
    runningTasks.delete(runId);
    TikHubClient.activeSignal = undefined;
    setTraceSink(null);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: '海外社媒智能运营工具',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 是多文件 tsc 产物（require('../shared/ipc')），Electron 默认沙箱
      // 只允许 require 白名单内置模块，会导致 preload 加载失败、window.api 缺失。
      // 渲染页仅加载本地内容且已启用 contextIsolation，关闭沙箱是安全的。
      sandbox: false,
    },
  });

  if (!app.isPackaged) {
    // 开发态：优先连接 Vite 开发服务器；若未启动则回退到已构建的 dist
    mainWindow.loadURL('http://localhost:5173').catch(() => {});
    mainWindow.webContents.on('did-fail-load', () => {
      mainWindow?.loadFile(join(__dirname, '../../dist/index.html'));
    });
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(__dirname, '../../dist/index.html'));
  }
}

function registerIpc() {
  ipcMain.handle(IPC_CHANNELS.getConfig, () => dataService.config);
  ipcMain.handle(IPC_CHANNELS.saveConfig, (_e, cfg: AppConfig) => {
    const merged = saveUserConfig(cfg);
    // 原地更新同一 config 对象引用，provider 与 MiniMaxClient 立即读到新值
    Object.assign(dataService.config, merged);
    return dataService.config;
  });
  ipcMain.handle(IPC_CHANNELS.resetConfig, () => {
    const merged = resetUserConfig();
    Object.assign(dataService.config, merged);
    return dataService.config;
  });
  // 通用本地持久化：用于保存各页面操作数据，跨重启保留（key 做白名单校验，防路径穿越）
  ipcMain.handle(IPC_CHANNELS.getJson, (_e, key: string) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) return null;
    return readJson(key, null);
  });
  ipcMain.handle(IPC_CHANNELS.setJson, (_e, key: string, value: any) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) return;
    writeJson(key, value);
  });
  // 取消正在执行的任务：中断主进程在途网络请求（MiniMax / TiKhub / 下载），渲染层也会立即反馈「已取消」
  ipcMain.handle(IPC_CHANNELS.cancelRun, (_e, runId: string) => {
    runningTasks.get(runId)?.abort();
    return true;
  });
  ipcMain.handle(IPC_CHANNELS.fetchAccount, (e, args) => withProgress(e.sender, args.runId ?? randomUUID(), () => dataService.fetchAccount(args.platform, args.url)));
  ipcMain.handle(IPC_CHANNELS.fetchVideos, (e, args) => withProgress(e.sender, args.runId ?? randomUUID(), () => dataService.fetchVideos(args.platform, args.url, args.limit)));
  // 读取视频库；对带 localMediaUrl 的条目实时校验本地文件是否仍在：
  // 文件已丢失（被删除/清理）时返回 localMediaMissing=true，前端据此显示「临时」并允许重新替换。
  ipcMain.handle(IPC_CHANNELS.getVideoDb, () => {
    const base = resolve(mediaDir());
    return dataService.getVideoDb().map((v) => {
      if (!v.localMediaUrl) return v;
      try {
        const rel = decodeURIComponent(v.localMediaUrl.replace('localmedia://', ''));
        const p = resolve(mediaDir(), rel);
        if (p !== base && !p.startsWith(base + sep)) return v; // 非法路径不处理
        return existsSync(p) ? v : { ...v, localMediaMissing: true };
      } catch {
        return { ...v, localMediaMissing: true };
      }
    });
  });
  ipcMain.handle(IPC_CHANNELS.fetchTrends, (e, args) => withProgress(e.sender, args.runId ?? randomUUID(), () => dataService.fetchTrends(args.platform, args.accounts)));
  ipcMain.handle(IPC_CHANNELS.fetchHashtags, (e, args) => withProgress(e.sender, args.runId ?? randomUUID(), () => dataService.fetchHashtags(args.platform, args.accounts)));
  ipcMain.handle(IPC_CHANNELS.fetchTrendData, (e, args) => withProgress(e.sender, args.runId ?? randomUUID(), () => dataService.fetchTrendData(args.platform, args.accounts)));
  ipcMain.handle(IPC_CHANNELS.fetchVideoDetail, (e, args) => withProgress(e.sender, args.runId ?? randomUUID(), () => dataService.fetchVideoDetail(args.platform, args.videoId)));
  ipcMain.handle(IPC_CHANNELS.searchVideos, (e, args) => withProgress(e.sender, args.runId ?? randomUUID(), () => dataService.searchVideos(args.platform, args.keyword)));
  ipcMain.handle(IPC_CHANNELS.importVideos, (_e, videos: SocialVideo[]) => {
    const res = dataService.importVideos(videos ?? []);
    return res;
  });

  // 批量把所有视频的链接下载到本地，并把可播放地址替换为 localmedia:// 本地路径（永不过期）。
  // 仅替换「播放用」地址（localMediaUrl），不动 mediaUrl 的远程/MiniMax 分析链接，AI 分析仍照常可用。
  ipcMain.handle(IPC_CHANNELS.replaceMediaWithLocal, (e, args) =>
    withProgress(e.sender, args.runId ?? randomUUID(), async (signal) => {
      const db = dataService.getVideoDb();
      // 待处理：有可下载远程直链（http/https）且「未本地化 或 本地文件已缺失（需重新下载）」
      const targets = db.filter((v) => {
        if (!v.mediaUrl || !/^https?:\/\//.test(v.mediaUrl)) return false;
        if (!v.localMediaUrl) return true;
        try {
          const rel = decodeURIComponent(v.localMediaUrl.replace('localmedia://', ''));
          const p = resolve(mediaDir(), rel);
          const base = resolve(mediaDir());
          if (p !== base && !p.startsWith(base + sep)) return false; // 非法路径，跳过
          return !existsSync(p); // 文件缺失 → 重新下载
        } catch {
          return true;
        }
      });
      const total = targets.length;
      const rid = args.runId ?? randomUUID();
      let downloaded = 0;
      let failed = 0;
      let done = 0;
      for (const v of targets) {
        if (signal.aborted) break; // 用户取消：立即停止后续下载
        try {
          const buf = await downloadBufferWithBrowser(v.mediaUrl!, signal);
          if (buf.length < 1024) throw new Error('下载内容过小，可能不是有效媒体');
          // 按媒体类型选扩展名：图文用真实图片格式，视频用 mp4（避免图文被存成 .mp4 导致 <img> 无法渲染）
          const ext = v.mediaType === 'image'
            ? (v.mediaUrl!.match(/\.(jpg|jpeg|png|webp|gif)(?:\?|$)/i)?.[1] || 'jpg')
            : 'mp4';
          const fileName = `${v.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`;
          // 清理旧扩展名的残留文件（如图文曾存成 .mp4），避免垃圾文件
          try {
            const oldRel = decodeURIComponent((v.localMediaUrl ?? '').replace('localmedia://', ''));
            if (oldRel && oldRel !== fileName) {
              const oldP = resolve(mediaDir(), oldRel);
              const base = resolve(mediaDir());
              if ((oldP === base || oldP.startsWith(base + sep)) && existsSync(oldP)) rmSync(oldP);
            }
          } catch { /* 忽略清理失败 */ }
          writeFileSync(join(mediaDir(), fileName), buf);
          dataService.setVideoLocalMediaUrl(v.id, `localmedia://${fileName}`);
          downloaded++;
        } catch {
          failed++;
        } finally {
          done++;
          // 实时推送「第 N / 共 M 个」总进度，供「实时工作流」面板展示 1/10；
          // label 同时带上成功/失败统计，避免「已处理 10 个」被误读为「已成功替换 10 个」
          try {
            e.sender.send(IPC_CHANNELS.batchProgress, {
              runId: rid,
              current: done,
              total,
              label: `成功 ${downloaded} · 失败 ${failed} · ${v.title || v.id}`,
            });
          } catch { /* 窗口已关闭 */ }
        }
      }
      const skipped = db.length - targets.length;
      trace.add({
        kind: 'tikhub',
        title: `批量替换为本地路径完成`,
        endpoint: '',
        method: 'GET',
        model: '',
        status: failed > 0 && downloaded === 0 ? 500 : 200,
        ok: downloaded > 0,
        durationMs: 0,
        summary: `共 ${db.length} 条：新下载 ${downloaded}，已本地/无直链跳过 ${skipped}，失败 ${failed}`,
      });
      return { downloaded, failed, skipped, total: db.length };
    }));

  // 删除视频库中的视频（支持批量）；若为本地落盘（localmedia://）视频，同时删除本地文件，避免残留
  ipcMain.handle(IPC_CHANNELS.deleteVideos, (_e, args: { ids: string[] }) => {
    try {
      return dataService.deleteVideos(args?.ids ?? []);
    } catch (e: any) {
      return { removed: 0, localDeleted: 0, error: e?.message ?? String(e) };
    }
  });
  ipcMain.handle(IPC_CHANNELS.runAiTask, (e, args) =>
    withProgress(e.sender, args.runId ?? randomUUID(), async (signal) => {
      const client = new MiniMaxClient(dataService.config, {
        onToken: (text) => {
          try { e.sender.send(IPC_CHANNELS.aichunk, { runId: args.runId ?? '', text }); } catch { /* ignore */ }
        },
        signal,
      });
      // 爆款视频拆解：接入「降级恢复」流程（先上传 → ffmpeg 重编码 → 抽帧 → 纯文本，含完整卡片）
      if (args.task === 'breakdownViralVideo') {
        const p = args.payload ?? {};
        const rec = await breakdownViralVideoWithRecovery(client, dataService, {
          videoId: p.videoId ?? '',
          platform: p.platform ?? 'tiktok',
          title: p.title ?? '',
          comments: p.comments ?? [],
          url: p.url,
        });
        return rec.result;
      }
      return runAiTask(client, args.task, args.payload);
    }));

  // 模块二：视频内容解析（内置「敏感内容自动脱敏恢复」流程）
  ipcMain.handle(IPC_CHANNELS.analyzeVideoSafe, (e, args) =>
    withProgress(e.sender, args.runId ?? randomUUID(), async (signal) => {
      const client = new MiniMaxClient(dataService.config, {
        onToken: (text) => {
          try { e.sender.send(IPC_CHANNELS.aichunk, { runId: args.runId ?? '', text }); } catch { /* ignore */ }
        },
        signal,
      });
      return analyzeVideoWithRecovery(client, dataService, { platform: args.platform, videoId: args.videoId });
    }));
  ipcMain.handle(IPC_CHANNELS.generateEditPlan, (e, materials, runId) =>
    withProgress(e.sender, runId ?? randomUUID(), async (signal) => {
      const client = new MiniMaxClient(dataService.config, {
        onToken: (text) => {
          try { e.sender.send(IPC_CHANNELS.aichunk, { runId: runId ?? '', text }); } catch { /* ignore */ }
        },
        signal,
      });
      // 视频被判敏感/媒体不可达时自动 ffmpeg 降级恢复（仅用于生成方案，最终渲染仍用原始素材）
      const result = await generateEditPlansSafe(client, dataService, materials);
      trace.add({
        kind: 'minimax',
        title: `剪辑方案生成完成（脱敏方式：${result.method}）`,
        endpoint: `${client.baseUrl}/chat/completions`,
        method: 'POST',
        model: client.model,
        status: 200,
        ok: true,
        durationMs: 0,
        summary:
          result.method === 'direct'
            ? '视频直连分析成功，已生成方案'
            : result.method === 'text'
              ? '视频画面不可用，已基于素材元数据（纯文本）生成方案'
              : `经${result.method === 'sanitized' ? '重新编码脱敏' : '抽帧图片集'}后成功生成方案（最终渲染仍使用原始素材）`,
      });
      return result.plans;
    }));

  // 下载视频到本地（传入可直链 + 文件名，主进程落盘到用户选择路径）
  ipcMain.handle(IPC_CHANNELS.downloadVideo, async (_e, args: { url: string; filename: string }) => {
    try {
      // 已下载到本地的媒体（localmedia://）：直接从本地文件复制，无需再联网
      if (args.url?.startsWith('localmedia://')) {
        const fileName = decodeURIComponent(args.url.slice('localmedia://'.length));
        const filePath = join(mediaDir(), fileName);
        const resolved = resolve(filePath);
        const base = resolve(mediaDir());
        if (resolved !== base && !resolved.startsWith(base + sep)) return { saved: false, error: '非法路径' };
        if (!existsSync(filePath)) return { saved: false, error: '本地媒体文件不存在' };
        const { canceled, filePath: out } = await dialog.showSaveDialog(mainWindow!, {
          title: '保存媒体',
          defaultPath: args.filename || 'media',
          filters: [{ name: '媒体文件', extensions: ['mp4', 'mov', 'webm', 'mkv', 'jpg', 'jpeg', 'png', 'webp', 'gif'] }],
        });
        if (canceled || !out) return { saved: false };
        copyFileSync(filePath, out);
        return { saved: true, path: out };
      }
      if (!args.url || !/^https?:\/\//.test(args.url)) return { saved: false, error: '无效的媒体直链' };
      const buf = await downloadBufferWithBrowser(args.url);
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow!, {
        title: '保存媒体',
        defaultPath: args.filename || 'media',
        filters: [{ name: '媒体文件', extensions: ['mp4', 'mov', 'webm', 'mkv', 'jpg', 'jpeg', 'png', 'webp', 'gif'] }],
      });
      if (canceled || !filePath) return { saved: false };
      writeFileSync(filePath, buf);
      return { saved: true, path: filePath };
    } catch (e: any) {
      return { saved: false, error: e?.message ?? String(e) };
    }
  });

  // 模块七：选择本地视频文件（返回绝对路径，供真实剪辑使用）
  ipcMain.handle(IPC_CHANNELS.pickVideoFiles, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: '选择视频素材',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'] }],
    });
    return res.canceled ? [] : res.filePaths;
  });

  // 模块七：调用 ffmpeg 按 AI 方案渲染成片
  ipcMain.handle(IPC_CHANNELS.renderEditPlan, (_e, args: { materials: EditMaterial[]; plans: EditPlan[]; burnCaptions: boolean }) => {
    const outDir = join(app.getPath('userData'), 'edits');
    return renderPlans(args.materials, args.plans, { burnCaptions: args.burnCaptions, outDir });
  });

  // 在文件管理器中打开（成片所在目录 / 已下载的视频）
  ipcMain.handle(IPC_CHANNELS.openPath, (_e, p: string) => {
    shell.openPath(p);
  });
}

app.whenReady().then(() => {
  registerLocalProtocol();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * 注册本地媒体协议 localmedia://：将 localmedia://<file> 映射到本地视频落盘目录，
 * 使渲染进程能直接播放已下载到本地的视频（永不过期）。带目录穿越防护。
 */
function registerLocalProtocol() {
  if (protocol.isProtocolRegistered('localmedia')) return;
  protocol.registerFileProtocol('localmedia', (request, callback) => {
    try {
      const fileName = decodeURIComponent(request.url.replace('localmedia://', ''));
      const base = resolve(mediaDir());
      const filePath = resolve(base, fileName);
      // 仅允许访问 mediaDir 内部文件，禁止 ../ 穿越
      if (filePath !== base && !filePath.startsWith(base + sep)) {
        return callback({ error: -2 } as any);
      }
      callback({ path: filePath });
    } catch {
      callback({ error: -2 } as any);
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 便于类型推导
export type { IpcApi };
