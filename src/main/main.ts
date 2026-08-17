// Electron 主进程
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import * as dotenv from 'dotenv';
import { DataService, loadEffectiveConfig, resetUserConfig, saveUserConfig } from '../data';
import { MiniMaxClient } from '../data/minimax';
import { runAiTask } from '../analysis/ai-tasks';
import { analyzeVideoWithRecovery, generateEditPlansSafe } from './sensitive-recovery';
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
 * 处理流程追踪包装：每次调用前清空收集器，并通过 IPC 把每一步实时推给渲染进程
 * （实现「流式工作流」）。成功时把步骤挂到返回值，异常时挂到错误对象。
 */
function withTrace<T>(data: T): Traced<T> {
  if (data && typeof data === 'object') (data as any).trace = trace.snapshot();
  return data as Traced<T>;
}

async function withProgress<T>(sender: Electron.WebContents, runId: string, fn: () => Promise<T>): Promise<Traced<T>> {
  trace.reset();
  setTraceSink((step) => {
    try { sender.send(IPC_CHANNELS.progress, { runId, step }); } catch { /* 窗口已关闭 */ }
  });
  try {
    const data = await fn();
    return withTrace(data);
  } catch (e: any) {
    e.trace = trace.snapshot();
    throw e;
  } finally {
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
  ipcMain.handle(IPC_CHANNELS.fetchAccount, (e, args) => withProgress(e.sender, args.runId ?? randomUUID(), () => dataService.fetchAccount(args.platform, args.url)));
  ipcMain.handle(IPC_CHANNELS.fetchVideos, (e, args) => withProgress(e.sender, args.runId ?? randomUUID(), () => dataService.fetchVideos(args.platform, args.url, args.limit)));
  ipcMain.handle(IPC_CHANNELS.getVideoDb, () => dataService.getVideoDb());
  ipcMain.handle(IPC_CHANNELS.fetchTrends, (e, args) => withProgress(e.sender, args.runId ?? randomUUID(), () => dataService.fetchTrends(args.platform, args.accounts)));
  ipcMain.handle(IPC_CHANNELS.fetchHashtags, (e, args) => withProgress(e.sender, args.runId ?? randomUUID(), () => dataService.fetchHashtags(args.platform, args.accounts)));
  ipcMain.handle(IPC_CHANNELS.fetchTrendData, (e, args) => withProgress(e.sender, args.runId ?? randomUUID(), () => dataService.fetchTrendData(args.platform, args.accounts)));
  ipcMain.handle(IPC_CHANNELS.fetchVideoDetail, (e, args) => withProgress(e.sender, args.runId ?? randomUUID(), () => dataService.fetchVideoDetail(args.platform, args.videoId)));
  ipcMain.handle(IPC_CHANNELS.searchVideos, (e, args) => withProgress(e.sender, args.runId ?? randomUUID(), () => dataService.searchVideos(args.platform, args.keyword)));
  ipcMain.handle(IPC_CHANNELS.importVideos, (_e, videos: SocialVideo[]) => {
    const res = dataService.importVideos(videos ?? []);
    return res;
  });

  // 把视频库里的临时直链（TiKhub CDN）批量上传到 MiniMax，并将 mediaUrl 切换为 mm_file:// 引用，
  // 解决 MiniMax 拉取不到临时直链（下载失败/500）的问题。上传过程经 progress 实时展示进度。
  ipcMain.handle(IPC_CHANNELS.uploadVideosToMiniMax, (e, args) =>
    withProgress(e.sender, args.runId ?? randomUUID(), async () => {
      const client = new MiniMaxClient(dataService.config);
      const db = dataService.getVideoDb();
      const targets = db.filter((v) => v.mediaUrl && !v.mediaUrl.startsWith('mm_file://'));
      let uploaded = 0;
      let failed = 0;
      for (const v of targets) {
        try {
          const res = await fetch(v.mediaUrl!);
          if (!res.ok) { failed++; continue; }
          const buf = Buffer.from(await res.arrayBuffer());
          const ref = await client.uploadVideo(buf, `${v.id}.mp4`);
          dataService.updateVideoMediaUrl(v.id, ref);
          uploaded++;
          trace.add({
            kind: 'minimax',
            title: `上传视频到 MiniMax（${v.title || v.id}）`,
            endpoint: `${client.baseUrl}/files/upload`,
            method: 'POST',
            model: dataService.config.llmModel || 'MiniMax-M3',
            status: 200,
            ok: true,
            durationMs: 0,
            summary: `已上传并切换为 ${ref}`,
          });
        } catch {
          failed++;
        }
      }
      trace.add({
        kind: 'minimax',
        title: `批量同步到 MiniMax 完成`,
        endpoint: `${client.baseUrl}/files/upload`,
        method: 'POST',
        model: dataService.config.llmModel || 'MiniMax-M3',
        status: failed > 0 && uploaded === 0 ? 500 : 200,
        ok: uploaded > 0,
        durationMs: 0,
        summary: `共 ${targets.length} 个待上传：成功 ${uploaded}，失败 ${failed}`,
      });
      return { uploaded, failed, total: targets.length };
    }));
  ipcMain.handle(IPC_CHANNELS.runAiTask, (e, args) =>
    withProgress(e.sender, args.runId ?? randomUUID(), async () => {
      const client = new MiniMaxClient(dataService.config, {
        onToken: (text) => {
          try { e.sender.send(IPC_CHANNELS.aichunk, { runId: args.runId ?? '', text }); } catch { /* ignore */ }
        },
      });
      return runAiTask(client, args.task, args.payload);
    }));

  // 模块二：视频内容解析（内置「敏感内容自动脱敏恢复」流程）
  ipcMain.handle(IPC_CHANNELS.analyzeVideoSafe, (e, args) =>
    withProgress(e.sender, args.runId ?? randomUUID(), async () => {
      const client = new MiniMaxClient(dataService.config, {
        onToken: (text) => {
          try { e.sender.send(IPC_CHANNELS.aichunk, { runId: args.runId ?? '', text }); } catch { /* ignore */ }
        },
      });
      return analyzeVideoWithRecovery(client, dataService, { platform: args.platform, videoId: args.videoId });
    }));
  ipcMain.handle(IPC_CHANNELS.generateEditPlan, (e, materials, runId) =>
    withProgress(e.sender, runId ?? randomUUID(), async () => {
      const client = new MiniMaxClient(dataService.config, {
        onToken: (text) => {
          try { e.sender.send(IPC_CHANNELS.aichunk, { runId: runId ?? '', text }); } catch { /* ignore */ }
        },
      });
      // 视频被判敏感时自动 ffmpeg 脱敏恢复（仅用于生成方案，最终渲染仍用原始素材）
      const result = await generateEditPlansSafe(client, materials);
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
            : `经${result.method === 'sanitized' ? '重新编码脱敏' : '抽帧图片集'}后成功生成方案（最终渲染仍使用原始素材）`,
      });
      return result.plans;
    }));

  // 下载视频到本地（传入可直链 + 文件名，主进程落盘到用户选择路径）
  ipcMain.handle(IPC_CHANNELS.downloadVideo, async (_e, args: { url: string; filename: string }) => {
    try {
      if (!args.url || !/^https?:\/\//.test(args.url)) return { saved: false, error: '无效的视频直链' };
      const res = await fetch(args.url);
      if (!res.ok) return { saved: false, error: `下载失败 HTTP ${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow!, {
        title: '保存视频',
        defaultPath: args.filename || 'video.mp4',
        filters: [{ name: '视频', extensions: ['mp4', 'mov', 'webm', 'mkv'] }],
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
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 便于类型推导
export type { IpcApi };
