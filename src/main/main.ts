// Electron 主进程
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  protocol,
  net,
} from "electron";
import { join, resolve, sep } from "path";
import {
  writeFileSync,
  existsSync,
  copyFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  mkdtempSync,
  readFileSync,
} from "fs";
import * as os from "os";
import { randomUUID } from "crypto";
import * as dotenv from "dotenv";
import {
  DataService,
  loadEffectiveConfig,
  resetUserConfig,
  saveUserConfig,
} from "../data";
import { mediaDir, readJson, writeJson } from "../data/store";
import { MiniMaxClient } from "../data/minimax";
import { TikHubClient } from "../data/tikhub-client";
import { MysqlCache } from "../data/mysql-cache";
import { downloadWithYtDlp, resolveWithYtDlp } from "../data/ytdlp";
import { hotspotCacheKey, toDateKey } from "../shared/cache-keys";
import { runAiTask } from "../analysis/ai-tasks";
import {
  analyzeVideoWithRecovery,
  generateEditPlansSafe,
  breakdownViralVideoWithRecovery,
} from "./sensitive-recovery";
import { renderPlans, extractAudio, synthesizeVoiceover, generateSpeechAudio } from "./ffmpeg";
import { editImage, generateImage } from "./image-generation";
import { uploadTemplateImage, uploadVideoToCos, uploadImageDataUrl } from "./cos-storage";
import { analyzeVoiceover, generateSopReply } from "./customer-sop";
import { transcribeLocally } from "./whisper";
import { EditMaterial, EditPlan } from "../analysis/ai-edit";
import { AppConfig, SocialVideo } from "../shared/types";
import { IPC_CHANNELS, IpcApi } from "../shared/ipc";
import { trace, Traced, setTraceSink } from "../shared/trace";
import { closeWechatDecryptWindow, decryptWechatVideo } from "./wechat-decrypt";

// 加载 .env：开发态用项目根目录；打包后用 resources/.env；最后兜底从 cwd 加载。
// 多重路径确保不同启动方式（npm run electron:dev / electron . / 打包后）都能读到令牌。
const envPath = app.isPackaged
  ? join(process.resourcesPath, ".env")
  : join(app.getAppPath(), ".env");
dotenv.config({ path: envPath });
dotenv.config();

let mainWindow: BrowserWindow | null = null;
const dataService = new DataService(loadEffectiveConfig());
// MySQL 云端缓存：懒连接 + 失败静默降级；配置保存后 applyConfig 使新配置即时生效
const mysqlCache = new MysqlCache(dataService.config);

const EDGE_TTS_TRUSTED_CLIENT_TOKEN =
  "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

/** node-edge-tts 只负责合成，不提供音色目录；目录从 Edge TTS 官方接口读取。 */
async function fetchEdgeTtsVoices(): Promise<any[]> {
  const url =
    "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list" +
    `?trustedclienttoken=${EDGE_TTS_TRUSTED_CLIENT_TOKEN}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
  });
  if (!response.ok) {
    throw new Error(`Edge TTS 音色列表请求失败：HTTP ${response.status}`);
  }
  const data = await response.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Edge TTS 音色列表为空");
  }
  return data;
}

/**
 * 用 Electron 网络栈（net.fetch，Chromium 通道）下载媒体字节，带浏览器 UA/Referer。
 * 规避 TikTok CDN 对 Node 原生 fetch（无浏览器指纹、不走系统代理）的连接重置/403 问题。
 */
function mediaReferer(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("tiktok")) return "https://www.tiktok.com/";
    if (host.includes("instagram")) return "https://www.instagram.com/";
    if (host.includes("youtube") || host.includes("googlevideo"))
      return "https://www.youtube.com/";
    if (host.includes("facebook") || host.includes("fbcdn"))
      return "https://www.facebook.com/";
    if (host.includes("xiaohongshu") || host.includes("xhscdn"))
      return "https://www.xiaohongshu.com/";
  } catch {
    /* URL 校验由调用方处理 */
  }
  return undefined;
}

async function downloadBufferWithBrowser(
  url: string,
  cancelSignal?: AbortSignal,
): Promise<Buffer> {
  // 60s 超时：避免单条媒体下载挂起导致「全部替换为本地路径」进度卡住；
  // 同时合并工作流取消信号（用户点「取消」时 abort 进行中的下载）
  const signal = cancelSignal
    ? AbortSignal.any([cancelSignal, AbortSignal.timeout(60_000)])
    : AbortSignal.timeout(60_000);
  const baseHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "video/mp4,video/*,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  const referer = mediaReferer(url);
  const request = (withReferer: boolean) =>
    net.fetch(url, {
      redirect: "follow",
      headers:
        withReferer && referer
          ? { ...baseHeaders, Referer: referer }
          : baseHeaders,
      signal,
    });
  let res = await request(true);
  // 部分 CDN 拒绝带 Referer，部分 CDN 又要求 Referer；两种请求各尝试一次。
  if (res.status === 403 && referer) res = await request(false);
  if (!res.ok) {
    const detail = (await res.text().catch(() => ""))
      .replace(/\s+/g, " ")
      .slice(0, 180);
    throw new Error(
      `视频下载失败（HTTP ${res.status}）：视频直链已失效或被来源站拒绝${detail ? `，服务端返回：${detail}` : ""}。请刷新视频直链或先在视频库下载到本地后再抓取`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

/** 返回随应用分发的 yt-dlp；开发态从项目 resources 读取，打包态从 extraResources 读取。 */
function bundledYtDlpPath(): string | null {
  const candidates = app.isPackaged
    ? [
        join(
          process.resourcesPath,
          "yt-dlp",
          process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
        ),
      ]
    : [
        join(
          app.getAppPath(),
          "resources",
          "yt-dlp",
          process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
        ),
      ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * 处理流程追踪包装：每次调用前清空收集器，并通过 IPC 把每一步实时推给渲染进程
 * （实现「流式工作流」）。成功时把步骤挂到返回值，异常时挂到错误对象。
 */
function withTrace<T>(data: T): Traced<T> {
  if (data && typeof data === "object") (data as any).trace = trace.snapshot();
  return data as Traced<T>;
}

/** 正在执行的任务注册表：runId → AbortController，供「取消」中断在途请求 */
const runningTasks = new Map<string, AbortController>();

/** 两个日期相隔的天数（不足 1 天按 0 计，用于账号缓存过期判断） */
function daysBetween(a: Date, b: Date): number {
  if (Number.isNaN(a.getTime())) return 9999;
  const ms = b.getTime() - a.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

async function withProgress<T>(
  sender: Electron.WebContents,
  runId: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<Traced<T>> {
  trace.reset();
  setTraceSink((step) => {
    try {
      sender.send(IPC_CHANNELS.progress, { runId, step });
    } catch {
      /* 窗口已关闭 */
    }
  });
  const ctrl = new AbortController();
  runningTasks.set(runId, ctrl);
  TikHubClient.activeSignal = ctrl.signal;
  try {
    const data = await fn(ctrl.signal);
    if (ctrl.signal.aborted) throw new Error("任务已取消");
    return withTrace(data);
  } catch (e: any) {
    if (ctrl.signal.aborted) {
      // 用户主动取消：统一抛「任务已取消」，避免底层 abort 错误透传
      const err = new Error("任务已取消");
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
    title: "海外社媒智能运营工具",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
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
    mainWindow.loadURL("http://localhost:5173").catch(() => {});
    mainWindow.webContents.on("did-fail-load", () => {
      mainWindow?.loadFile(join(__dirname, "../../dist/index.html"));
    });
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(join(__dirname, "../../dist/index.html"));
  }
}

function registerIpc() {
  ipcMain.handle(IPC_CHANNELS.getConfig, () => dataService.config);
  ipcMain.handle(
    IPC_CHANNELS.generateImage,
    (e, args: { prompt: string; runId?: string; size?: string; model?: any }) =>
      withProgress(e.sender, args?.runId ?? randomUUID(), async (signal) => {
        const startedAt = Date.now();
        trace.add({
          kind: "image",
          title: "图片模型生成",
          endpoint: dataService.config.imageGeneratePath,
          method: "POST",
          status: 102,
          ok: true,
          durationMs: 0,
          summary: "正在提交图片生成请求",
        });
        const requestConfig = args?.model ? { ...dataService.config, imageModel: args.model.name, ...(args.model.apiKey ? { imageApiKey: args.model.apiKey } : {}) } : dataService.config;
        const images = await generateImage(
          requestConfig,
          args?.prompt ?? "",
          args?.size,
          signal,
        );
        trace.add({
          kind: "image",
          title: "图片生成完成",
          endpoint: dataService.config.imageGeneratePath,
          method: "POST",
          status: 200,
          ok: true,
          durationMs: Date.now() - startedAt,
          summary: `已生成 ${images.length} 张图片`,
        });
        void Promise.all(images.map(async (image) => {
          try {
            const dataUrl = image.b64
              ? `data:${image.contentType || "image/png"};base64,${image.b64}`
              : image.url
                ? `data:image/png;base64,${Buffer.from(await (await fetch(image.url)).arrayBuffer()).toString("base64")}`
                : "";
            if (dataUrl) await uploadImageDataUrl(dataService.config, { dataUrl }, "bt/tools/image_temp");
          } catch {
            // 生成结果归档失败不影响图片生成结果，静默处理。
          }
        }));
        return images;
      }),
  );
  ipcMain.handle(IPC_CHANNELS.editImage, (e, args) =>
    withProgress(e.sender, args?.runId ?? randomUUID(), async (signal) => {
      const startedAt = Date.now();
      trace.add({
        kind: "image",
        title: "参考图编辑",
        endpoint: dataService.config.imageEditPath,
        method: "POST",
        status: 102,
        ok: true,
        durationMs: 0,
        summary: "正在提交参考图编辑请求",
      });
      const requestConfig = args?.model ? { ...dataService.config, imageModel: args.model.name, ...(args.model.apiKey ? { imageApiKey: args.model.apiKey } : {}) } : dataService.config;
      const images = await editImage(
        requestConfig,
        {
          prompt: args?.prompt ?? "",
          images: args?.images ?? [],
          mask: args?.mask,
          size: args?.size,
        },
        signal,
      );
      trace.add({
        kind: "image",
        title: "参考图编辑完成",
        endpoint: dataService.config.imageEditPath,
        method: "POST",
        status: 200,
        ok: true,
        durationMs: Date.now() - startedAt,
        summary: `已生成 ${images.length} 张图片`,
      });
      void Promise.all(images.map(async (image) => {
        try {
          const dataUrl = image.b64
            ? `data:${image.contentType || "image/png"};base64,${image.b64}`
            : image.url
              ? `data:image/png;base64,${Buffer.from(await (await fetch(image.url)).arrayBuffer()).toString("base64")}`
              : "";
          if (dataUrl) await uploadImageDataUrl(dataService.config, { dataUrl }, "bt/tools/image_temp");
        } catch {
          // 归档失败静默处理，不阻断局部编辑。
        }
      }));
      return images;
    }),
  );
  ipcMain.handle(IPC_CHANNELS.saveConfig, (_e, cfg: AppConfig) => {
    const merged = saveUserConfig(cfg);
    // 原地更新同一 config 对象引用，provider 与 MiniMaxClient 立即读到新值
    Object.assign(dataService.config, merged);
    mysqlCache.applyConfig(dataService.config);
    return dataService.config;
  });
  ipcMain.handle(IPC_CHANNELS.resetConfig, () => {
    const merged = resetUserConfig();
    Object.assign(dataService.config, merged);
    mysqlCache.applyConfig(dataService.config);
    return dataService.config;
  });
  // 通用本地持久化：用于保存各页面操作数据，跨重启保留（key 做白名单校验，防路径穿越）
  ipcMain.handle(IPC_CHANNELS.getJson, async (_e, key: string) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) return null;
    if (key === "ai_edit_settings") {
      if (!mysqlCache.enabled) throw new Error("未配置数据库，剪辑设置无法跨设备保存。");
      return (await mysqlCache.get(key))?.data ?? null;
    }
    return readJson(key, null);
  });
  ipcMain.handle(IPC_CHANNELS.setJson, async (_e, key: string, value: any) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) return;
    if (key === "ai_edit_settings") {
      const saved = mysqlCache.enabled && await mysqlCache.set(key, "settings", value);
      if (!saved) throw new Error("数据库不可用，剪辑设置未保存。");
      return;
    }
    writeJson(key, value);
  });
  // AI 生图模板与分类是可共享的业务数据，仅保存至 MySQL；MysqlCache 的模板方法
  // 会在数据库未配置或不可用时抛出明确错误，禁止降级写入本地 JSON。
  ipcMain.handle(IPC_CHANNELS.listImageTemplateCategories, () =>
    mysqlCache.listImageTemplateCategories(),
  );
  ipcMain.handle(
    IPC_CHANNELS.createImageTemplateCategory,
    (_e, args: { name?: string }) =>
      mysqlCache.createImageTemplateCategory(randomUUID(), args?.name ?? ""),
  );
  ipcMain.handle(
    IPC_CHANNELS.updateImageTemplateCategory,
    (_e, args: { id?: string; name?: string }) =>
      mysqlCache.updateImageTemplateCategory(args?.id ?? "", args?.name ?? ""),
  );
  ipcMain.handle(
    IPC_CHANNELS.reorderImageTemplateCategories,
    (_e, args: { ids?: string[] }) =>
      mysqlCache.reorderImageTemplateCategories(args?.ids ?? []),
  );
  ipcMain.handle(
    IPC_CHANNELS.deleteImageTemplateCategory,
    (_e, args: { id?: string }) =>
      mysqlCache.deleteImageTemplateCategory(args?.id ?? ""),
  );
  ipcMain.handle(IPC_CHANNELS.listImageTemplates, () =>
    mysqlCache.listImageTemplates(),
  );
  ipcMain.handle(IPC_CHANNELS.uploadTemplateImage, async (_e, args) => ({
    url: await uploadTemplateImage(dataService.config, {
      dataUrl: args?.dataUrl ?? "",
      fileName: args?.fileName,
      contentType: args?.contentType,
    }),
  }));
  ipcMain.handle(IPC_CHANNELS.uploadVideoToCos, async (_e, args) => ({
    url: await uploadVideoToCos(dataService.config, {
      filePath: args?.filePath ?? args?.sourcePath ?? "",
    }),
  }));
  ipcMain.handle(IPC_CHANNELS.createImageTemplate, async (_e, args) => {
    const imageDataUrl = args?.imageDataUrl ?? "";
    // 兼容旧前端：若仍直接提交 Data URL，主进程先上传，数据库只保存 CDN URL。
    const imageUrl = imageDataUrl.startsWith("data:")
      ? await uploadTemplateImage(dataService.config, {
          dataUrl: imageDataUrl,
          fileName: args?.imageFileName,
        })
      : imageDataUrl;
    return mysqlCache.createImageTemplate({
      id: randomUUID(),
      title: args?.title ?? "",
      description: args?.description ?? "",
      categoryId: args?.categoryId ?? "",
      imageDataUrl: imageUrl,
      aspectRatio: args?.aspectRatio ?? "",
    });
  });
  ipcMain.handle(IPC_CHANNELS.updateImageTemplate, async (_e, args) => {
    const imageDataUrl = args?.imageDataUrl?.trim() ?? "";
    const imageUrl = imageDataUrl.startsWith("data:")
      ? await uploadTemplateImage(dataService.config, {
          dataUrl: imageDataUrl,
          fileName: args?.imageFileName,
        })
      : imageDataUrl || undefined;
    return mysqlCache.updateImageTemplate({
      id: args?.id ?? "",
      title: args?.title ?? "",
      description: args?.description ?? "",
      categoryId: args?.categoryId ?? "",
      imageDataUrl: imageUrl,
      aspectRatio: args?.aspectRatio,
    });
  });
  ipcMain.handle(
    IPC_CHANNELS.deleteImageTemplate,
    async (_e, args: { id?: string }) => ({
      deleted: await mysqlCache.deleteImageTemplate(args?.id ?? ""),
    }),
  );
  ipcMain.handle(IPC_CHANNELS.generateSopReply, (e, args) =>
    withProgress(e.sender, args?.runId ?? randomUUID(), async (signal) => {
      trace.add({
        kind: "image",
        title: "客服 SOP 对话模型",
        endpoint: `${dataService.config.sopBaseUrl}/chat/completions`,
        method: "POST",
        status: 102,
        ok: true,
        durationMs: 0,
        summary: "正在生成客服回复语",
      });
      return generateSopReply(
        dataService.config,
        args?.question ?? "",
        args?.systemPrompt,
        signal,
      );
    }),
  );
  ipcMain.handle(IPC_CHANNELS.listSopReplies, () =>
    mysqlCache.listSopReplies(),
  );
  ipcMain.handle(
    IPC_CHANNELS.createSopReply,
    (_e, args: { label?: string; content?: string }) =>
      mysqlCache.createSopReply(
        randomUUID(),
        args?.label ?? "",
        args?.content ?? "",
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.updateSopReply,
    (_e, args: { id?: string; label?: string; content?: string }) =>
      mysqlCache.updateSopReply(
        args?.id ?? "",
        args?.label ?? "",
        args?.content ?? "",
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.deleteSopReply,
    async (_e, args: { id?: string }) => ({
      deleted: await mysqlCache.deleteSopReply(args?.id ?? ""),
    }),
  );
  // 取消正在执行的任务：中断主进程在途网络请求（MiniMax / TiKhub / 下载），渲染层也会立即反馈「已取消」
  ipcMain.handle(IPC_CHANNELS.cancelRun, (_e, runId: string) => {
    runningTasks.get(runId)?.abort();
    return true;
  });

  // ---- MySQL 云端缓存（热点 / 账号分析 / 爆款拆解 结果缓存）----
  // 查询：type 决定过期口径——hotspot 按 key 内日期 == 今天；账号分析按 created_at 距今 ≤ maxDays；viral 永久
  ipcMain.handle(
    IPC_CHANNELS.queryCache,
    (
      e,
      args: {
        key: string;
        type:
          | "hotspot"
          | "own_account"
          | "competitor_account"
          | "viral"
          | "voiceover";
        maxDays?: number;
        runId?: string;
      },
    ) =>
      // 缓存查询本身也建立 trace sink，否则它虽然写入 trace，却不会以当前 runId 推送到工作流面板。
      withProgress(e.sender, args.runId ?? randomUUID(), async () => {
        if (!mysqlCache.enabled) return { hit: false };
        if (
          (args.type === "own_account" || args.type === "competitor_account") &&
          (!args.maxDays || args.maxDays <= 0)
        )
          return { hit: false };
        try {
          const hit = await mysqlCache.get(args.key);
          if (!hit) return { hit: false };
          if (args.type === "hotspot") {
            // 新键格式末段始终是日期；旧键也可被读取，但仍必须校验缓存日期。
            const keyDate = String(args.key).split(":").pop() ?? "";
            if (hit.date !== keyDate || keyDate !== toDateKey())
              return { hit: false };
          } else if (
            (args.type === "own_account" ||
              args.type === "competitor_account") &&
            args.maxDays &&
            args.maxDays > 0
          ) {
            const ageDays = daysBetween(
              new Date(String(hit.createdAt).replace(" ", "T")),
              new Date(),
            );
            if (ageDays > args.maxDays) return { hit: false };
          }
          trace.add({
            kind: "cache",
            title: "云端缓存命中",
            endpoint: "",
            method: "GET",
            params: { key: args.key, type: args.type },
            status: 200,
            ok: true,
            durationMs: 0,
            summary: `已读取 ${args.type} 缓存，跳过后续数据接口与分析请求`,
          });
          return { hit: true, data: hit.data, cachedAt: hit.createdAt };
        } catch {
          return { hit: false };
        }
      }),
  );
  ipcMain.handle(
    IPC_CHANNELS.saveCache,
    async (
      _e,
      args: {
        key: string;
        type:
          | "hotspot"
          | "own_account"
          | "competitor_account"
          | "viral"
          | "voiceover";
        data: any;
        refUrl?: string;
        date?: string;
      },
    ) => {
      if (!mysqlCache.enabled) return { saved: false };
      const ok = await mysqlCache.set(args.key, args.type, args.data, {
        date: args.date,
        refUrl: args.refUrl,
      });
      return { saved: ok };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.extractVoiceover,
    (
      e,
      args: {
        sourceUrl: string;
        pageUrl?: string;
        videoId?: string;
        runId?: string;
      },
    ) =>
      withProgress(e.sender, args.runId ?? randomUUID(), async (signal) => {
        if (!dataService.config.sopApiKey?.trim())
          throw new Error("未配置客服 SOP 对话模型 API Key，请先在设置页配置");
        const tmp = mkdtempSync(join(os.tmpdir(), "oss-voiceover-"));
        const input = join(tmp, "input.mp4");
        const audio = join(tmp, "audio.wav");
        try {
          let videoBytes: Buffer | undefined;
          if (args.sourceUrl?.startsWith("localmedia://")) {
            const rel = decodeURIComponent(
              args.sourceUrl.slice("localmedia://".length),
            );
            const p = resolve(mediaDir(), rel);
            const base = resolve(mediaDir());
            if (p !== base && !p.startsWith(base + sep))
              throw new Error("非法本地媒体路径");
            if (!existsSync(p))
              throw new Error("本地视频文件不存在，请先重新下载视频");
            videoBytes = readFileSync(p);
          } else if (args.sourceUrl && /^https?:\/\//.test(args.sourceUrl)) {
            const pageUrl = args.pageUrl?.trim();
            const bundled = bundledYtDlpPath();
            const ytdlpBin =
              bundled || dataService.config.ytdlpPath || "yt-dlp";
            let downloadedByYtDlp = false;
            if (pageUrl && /^https?:\/\//.test(pageUrl)) {
              try {
                await downloadWithYtDlp(
                  pageUrl,
                  input,
                  ytdlpBin,
                  90_000,
                  signal,
                );
                videoBytes = readFileSync(input);
                downloadedByYtDlp = true;
                trace.add({
                  kind: "ytdlp",
                  title: "yt-dlp 已下载原始视频",
                  endpoint: pageUrl,
                  method: "GET",
                  status: 200,
                  ok: true,
                  durationMs: 0,
                  summary: "已绕过视频 CDN 防盗链并准备本地视频",
                });
              } catch (e: any) {
                trace.add({
                  kind: "ytdlp",
                  title: "yt-dlp 下载原始视频失败，回退直链",
                  endpoint: pageUrl,
                  method: "GET",
                  status: 403,
                  ok: false,
                  durationMs: 0,
                  error: e?.message ?? String(e),
                });
              }
            }
            if (!downloadedByYtDlp)
              videoBytes = await downloadBufferWithBrowser(
                args.sourceUrl,
                signal,
              );
          } else {
            throw new Error("没有可用的视频地址，请先下载视频或刷新视频库");
          }
          if (!videoBytes)
            throw new Error(
              "未获取到视频文件，请刷新视频直链或先下载视频到本地",
            );
          if (videoBytes.length < 1024)
            throw new Error("下载内容过小，可能不是有效视频");
          writeFileSync(input, videoBytes);
          trace.add({
            kind: "tikhub",
            title: "视频已下载到本地",
            endpoint: "",
            method: "GET",
            status: 200,
            ok: true,
            durationMs: 0,
            summary: `已准备 ${(videoBytes.length / 1024 / 1024).toFixed(1)} MB 视频`,
          });
          await extractAudio(input, audio);
          trace.add({
            kind: "ffmpeg",
            title: "ffmpeg 已提取音频",
            endpoint: "",
            method: "POST",
            status: 200,
            ok: true,
            durationMs: 0,
            summary: "已生成 Whisper 所需的 16kHz WAV 音频文件",
          });
          // Whisper 运行时随 resources 一起分发；没有内置文件时兼容本机 openai-whisper。
          const modelUrl =
            (process.env.WHISPER_MODEL_URL ?? "").trim() ||
            (dataService.config.cosCdnDomain.trim()
              ? `${dataService.config.cosCdnDomain.replace(/\/+$/, "")}/tools/ggml-base.bin`
              : "");
          const transcript = await transcribeLocally(
            audio,
            app.isPackaged ? process.resourcesPath : app.getAppPath(),
            join(app.getPath("userData"), "whisper"),
            modelUrl,
            signal,
          );
          trace.add({
            kind: "whisper",
            title: "本地 Whisper 已完成口播转写",
            endpoint: "",
            method: "POST",
            status: 200,
            ok: true,
            durationMs: 0,
            summary: `已识别 ${transcript.text.length} 个字符`,
          });
          const analysisStartedAt = Date.now();
          trace.add({
            kind: "text",
            title: "文本分析",
            endpoint: `${dataService.config.sopBaseUrl}/chat/completions`,
            method: "POST",
            model: dataService.config.sopModel,
            status: 102,
            ok: true,
            durationMs: 0,
            summary: "正在使用客服 SOP 文本模型分析完整口播文案",
          });
          let analysis;
          try {
            analysis = await analyzeVoiceover(
              dataService.config,
              transcript.text,
              signal,
            );
            trace.add({
              kind: "text",
              title: "文本分析完成",
              endpoint: `${dataService.config.sopBaseUrl}/chat/completions`,
              method: "POST",
              model: dataService.config.sopModel,
              status: 200,
              ok: true,
              durationMs: Date.now() - analysisStartedAt,
              summary: "已提炼视频卖点、开头钩子、结尾 CTA 和脚本结构",
            });
          } catch (error: any) {
            trace.add({
              kind: "text",
              title: "文本分析失败",
              endpoint: `${dataService.config.sopBaseUrl}/chat/completions`,
              method: "POST",
              model: dataService.config.sopModel,
              status: 500,
              ok: false,
              durationMs: Date.now() - analysisStartedAt,
              error: error?.message ?? String(error),
            });
            throw error;
          }
          return { transcript, analysis };
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      }),
  );

  // ---- yt-dlp：在线视频链接 → 视频直链（爆款拆解「链接直连」入口）----
  ipcMain.handle(IPC_CHANNELS.resolveMediaUrl, (e, args) =>
    withProgress(e.sender, args.runId ?? randomUUID(), async (signal) => {
      const start = Date.now();
      const bundled = bundledYtDlpPath();
      const ytdlpBin = bundled || dataService.config.ytdlpPath || "yt-dlp";
      const r = await resolveWithYtDlp(args.url, ytdlpBin, 90_000, signal);
      trace.add({
        kind: "ytdlp",
        title: "yt-dlp 解析视频直链",
        endpoint: args.url,
        method: "GET",
        // yt-dlp 是可选的直链解析器；失败后会回退 TiKhub/平台接口，不代表拆解流程失败。
        status: r.mediaUrl ? 200 : 200,
        ok: true,
        durationMs: Date.now() - start,
        summary: r.mediaUrl
          ? `已使用${bundled ? "应用内置 " : ""}yt-dlp 解析可播放直链${r.title ? `（标题：${r.title.slice(0, 40)}）` : ""}`
          : undefined,
        error: r.error,
      });
      return r;
    }),
  );
  ipcMain.handle(IPC_CHANNELS.fetchAccount, (e, args) =>
    withProgress(e.sender, args.runId ?? randomUUID(), () =>
      dataService.fetchAccount(args.platform, args.url),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.fetchVideos, (e, args) =>
    withProgress(e.sender, args.runId ?? randomUUID(), () =>
      dataService.fetchVideos(args.platform, args.url, args.limit),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.fetchAccountVideos, (e, args) =>
    withProgress(e.sender, args.runId ?? randomUUID(), () =>
      dataService.fetchAccountVideos(args.platform, args.url, args.limit),
    ),
  );
  // 读取视频库；对带 localMediaUrl 的条目实时校验本地文件是否仍在：
  // 文件已丢失（被删除/清理）时返回 localMediaMissing=true，前端据此显示「临时」并允许重新替换。
  ipcMain.handle(IPC_CHANNELS.getVideoDb, () => {
    const base = resolve(mediaDir());
    return dataService.getVideoDb().map((v) => {
      if (!v.localMediaUrl) return v;
      try {
        const rel = decodeURIComponent(
          v.localMediaUrl.replace("localmedia://", ""),
        );
        const p = resolve(mediaDir(), rel);
        if (p !== base && !p.startsWith(base + sep)) return v; // 非法路径不处理
        return existsSync(p) ? v : { ...v, localMediaMissing: true };
      } catch {
        return { ...v, localMediaMissing: true };
      }
    });
  });
  ipcMain.handle(
    IPC_CHANNELS.updateVideoHook,
    (_e, args: { id: string; hook: string }) => {
      dataService.updateVideoHook(
        String(args?.id ?? ""),
        String(args?.hook ?? ""),
      );
    },
  );
  ipcMain.handle(IPC_CHANNELS.fetchTrends, (e, args) =>
    withProgress(e.sender, args.runId ?? randomUUID(), () =>
      dataService.fetchTrends(args.platform, args.keyword),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.fetchHashtags, (e, args) =>
    withProgress(e.sender, args.runId ?? randomUUID(), () =>
      dataService.fetchHashtags(args.platform, args.keyword),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.fetchTrendData, (e, args) =>
    withProgress(e.sender, args.runId ?? randomUUID(), async () => {
      const days = dataService.config.hotspotCacheDays;
      const cacheOn = !args.bypassCache && days > 0 && mysqlCache.enabled;
      if (cacheOn) {
        // 命中当天缓存：直接返回（不再调用三方接口 + MiniMax 清洗），并在工作流面板展示「缓存命中」卡片
        const key = hotspotCacheKey(args.platform, toDateKey(), args.keyword);
        const hit = await mysqlCache.get(key);
        // 空数组缓存不算有效命中：避免之前接口失败留下的空缓存长期遮蔽后续修复后的真实数据。
        if (
          hit &&
          hit.date === toDateKey() &&
          Array.isArray(hit.data?.trends) &&
          (hit.data.trends.length > 0 ||
            (Array.isArray(hit.data?.hashtags) && hit.data.hashtags.length > 0))
        ) {
          trace.add({
            kind: "cache",
            title: "热点数据缓存命中（当天）",
            endpoint: "",
            method: "GET",
            params: { platform: args.platform, date: toDateKey() },
            status: 200,
            ok: true,
            durationMs: 0,
            summary: `直接使用 ${hit.date} 已保存的 ${args.platform} 热点数据（趋势 ${hit.data.trends.length} 条 / Hashtag ${hit.data.hashtags?.length ?? 0} 条），未调用三方接口`,
          });
          return {
            trends: hit.data.trends ?? [],
            hashtags: hit.data.hashtags ?? [],
            fromCache: true,
          };
        }
      }
      // 禁用热点缓存时也绕过 provider 的短时内存缓存，确保每次实时查询。
      const res = await dataService.fetchTrendData(
        args.platform,
        args.keyword,
        !!args.bypassCache || days <= 0,
      );
      // 拉取成功后写当天缓存（下次同一天不再扣费）
      if (
        days > 0 &&
        mysqlCache.enabled &&
        (res.trends.length > 0 || res.hashtags.length > 0)
      ) {
        const key = hotspotCacheKey(args.platform, toDateKey(), args.keyword);
        await mysqlCache.set(key, "hotspot", res, { date: toDateKey() });
        trace.add({
          kind: "cache",
          title: "热点数据已写入云端缓存",
          endpoint: "",
          method: "POST",
          params: { platform: args.platform, date: toDateKey() },
          status: 200,
          ok: true,
          durationMs: 0,
          summary: `当天内再次查询该平台将直接命中缓存，不再调用三方接口`,
        });
      }
      return res;
    }),
  );
  ipcMain.handle(IPC_CHANNELS.fetchVideoDetail, (e, args) =>
    withProgress(e.sender, args.runId ?? randomUUID(), () =>
      dataService.fetchVideoDetail(args.platform, args.videoId, args.url),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.searchVideos, (e, args) =>
    withProgress(e.sender, args.runId ?? randomUUID(), () =>
      dataService.searchVideos(args.platform, args.keyword),
    ),
  );
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
          const rel = decodeURIComponent(
            v.localMediaUrl.replace("localmedia://", ""),
          );
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
          let buf = await downloadBufferWithBrowser(v.mediaUrl!, signal);
          if (buf.length < 1024)
            throw new Error("下载内容过小，可能不是有效媒体");
          if (v.platform === "wechat_channels" && v.decodeKey) {
            buf = await decryptWechatVideo(buf, v.decodeKey);
          }
          // 按媒体类型选扩展名：图文用真实图片格式，视频用 mp4（避免图文被存成 .mp4 导致 <img> 无法渲染）
          const ext =
            v.mediaType === "image"
              ? v.mediaUrl!.match(/\.(jpg|jpeg|png|webp|gif)(?:\?|$)/i)?.[1] ||
                "jpg"
              : "mp4";
          const fileName = `${v.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.${ext}`;
          // 清理旧扩展名的残留文件（如图文曾存成 .mp4），避免垃圾文件
          try {
            const oldRel = decodeURIComponent(
              (v.localMediaUrl ?? "").replace("localmedia://", ""),
            );
            if (oldRel && oldRel !== fileName) {
              const oldP = resolve(mediaDir(), oldRel);
              const base = resolve(mediaDir());
              if (
                (oldP === base || oldP.startsWith(base + sep)) &&
                existsSync(oldP)
              )
                rmSync(oldP);
            }
          } catch {
            /* 忽略清理失败 */
          }
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
          } catch {
            /* 窗口已关闭 */
          }
        }
      }
      const skipped = db.length - targets.length;
      trace.add({
        kind: "tikhub",
        title: `批量替换为本地路径完成`,
        endpoint: "",
        method: "GET",
        model: "",
        status: failed > 0 && downloaded === 0 ? 500 : 200,
        ok: downloaded > 0,
        durationMs: 0,
        summary: `共 ${db.length} 条：新下载 ${downloaded}，已本地/无直链跳过 ${skipped}，失败 ${failed}`,
      });
      return { downloaded, failed, skipped, total: db.length };
    }),
  );

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
      const aiConfig = args.task === "inferImageSize"
        ? {
            ...dataService.config,
            llmApiKey: dataService.config.sopApiKey,
            llmBaseUrl: dataService.config.sopBaseUrl,
            llmModel: dataService.config.sopModel,
          }
        : dataService.config;
      const client = new MiniMaxClient(aiConfig, {
        onToken: (text) => {
          try {
            e.sender.send(IPC_CHANNELS.aichunk, {
              runId: args.runId ?? "",
              text,
            });
          } catch {
            /* ignore */
          }
        },
        signal,
      });
      // 爆款视频拆解：接入「降级恢复」流程（先上传 → ffmpeg 重编码 → 抽帧 → 纯文本，含完整卡片）
      if (args.task === "breakdownViralVideo") {
        const p = args.payload ?? {};
        const rec = await breakdownViralVideoWithRecovery(client, dataService, {
          videoId: p.videoId ?? "",
          platform: p.platform ?? "tiktok",
          title: p.title ?? "",
          comments: p.comments ?? [],
          url: p.url,
        });
        return rec.result;
      }
      return runAiTask(client, args.task, args.payload);
    }),
  );

  // 模块二：视频内容解析（内置「敏感内容自动脱敏恢复」流程）
  ipcMain.handle(IPC_CHANNELS.analyzeVideoSafe, (e, args) =>
    withProgress(e.sender, args.runId ?? randomUUID(), async (signal) => {
      const client = new MiniMaxClient(dataService.config, {
        onToken: (text) => {
          try {
            e.sender.send(IPC_CHANNELS.aichunk, {
              runId: args.runId ?? "",
              text,
            });
          } catch {
            /* ignore */
          }
        },
        signal,
      });
      return analyzeVideoWithRecovery(client, dataService, {
        platform: args.platform,
        videoId: args.videoId,
      });
    }),
  );
  ipcMain.handle(
    IPC_CHANNELS.generateEditPlan,
    (e, materials: EditMaterial[], options: any, runId) =>
      withProgress(e.sender, runId ?? randomUUID(), async (signal) => {
        if (!Array.isArray(materials) || !materials.length)
          throw new Error("请先选择本地视频素材");
        // AI 剪辑仅接受用户选择的本地文件，禁止链接/视频库素材混入，避免模型访问失败及越权下载。
        for (const m of materials) {
          if (!m?.filePath || !existsSync(m.filePath))
            throw new Error(
              `本地素材不存在：${m?.name ?? m?.filePath ?? "未知文件"}`,
            );
          if (
            !resolve(m.filePath)
              .toLowerCase()
              .match(/\.(mp4|mov|mkv|webm|avi|m4v|jpg|jpeg|png|webp|gif|bmp)$/)
          )
            throw new Error(`不支持的素材格式：${m.filePath}`);
        }
        const client = new MiniMaxClient(dataService.config, {
          onToken: (text) => {
            try {
              e.sender.send(IPC_CHANNELS.aichunk, { runId: runId ?? "", text });
            } catch {
              /* ignore */
            }
          },
          signal,
        });
        // 直接将 HTTPS 视频作为 video_url 交给大模型生成剪辑方案，最终由本地 FFmpeg 执行脚本成片。
        const result = await generateEditPlansSafe(
          client,
          dataService,
          materials,
          options,
        );
        const platformLabels: Record<string, string> = {
          tiktok: "TikTok",
          instagram: "Instagram",
          youtube: "YouTube",
          xiaohongshu: "小红书",
          wechat_channels: "视频号",
        };
        for (const plan of result.plans) {
          trace.add({
            kind: "text",
            title: `${platformLabels[plan.platform] ?? plan.platform} 平台方案`,
            endpoint: "",
            method: "POST",
            status: 200,
            ok: true,
            durationMs: 0,
            params: {
              platform: platformLabels[plan.platform] ?? plan.platform,
              direction: plan.direction,
            },
            summary: plan.hook
              ? `已生成平台 Hook：${plan.hook}`
              : "已生成该平台剪辑方案",
          });
        }
        trace.add({
          kind: "minimax",
          title: `剪辑方案生成完成（${result.method === "direct" ? "视频直连" : result.method === "frames" ? "本地抽帧" : "素材元数据"}）`,
          endpoint: `${client.baseUrl}/chat/completions`,
          method: "POST",
          model: client.model,
          status: 200,
          ok: true,
          durationMs: 0,
          summary:
            result.method === "direct"
              ? "视频直连分析成功，已生成方案"
              : result.method === "text"
                ? "视频画面不可用，已基于素材元数据（纯文本）生成方案"
                : result.method === "frames"
                  ? "已基于本地视频抽帧识别内容并生成方案，最终渲染由本地 FFmpeg 执行"
                  : "已基于素材元数据生成方案（最终渲染由本地 FFmpeg 执行）",
        });
        return result.plans;
      }),
  );

  // 下载视频到本地（传入可直链 + 文件名，主进程落盘到用户选择路径）
  ipcMain.handle(
    IPC_CHANNELS.downloadVideo,
    async (
      _e,
      args: {
        url: string;
        filename: string;
        platform?: SocialVideo["platform"];
        decodeKey?: string;
      },
    ) => {
      try {
        // 已下载到本地的媒体（localmedia://）：直接从本地文件复制，无需再联网
        if (args.url?.startsWith("localmedia://")) {
          const fileName = decodeURIComponent(
            args.url.slice("localmedia://".length),
          );
          const filePath = join(mediaDir(), fileName);
          const resolved = resolve(filePath);
          const base = resolve(mediaDir());
          if (resolved !== base && !resolved.startsWith(base + sep))
            return { saved: false, error: "非法路径" };
          if (!existsSync(filePath))
            return { saved: false, error: "本地媒体文件不存在" };
          const { canceled, filePath: out } = await dialog.showSaveDialog(
            mainWindow!,
            {
              title: "保存媒体",
              defaultPath: args.filename || "media",
              filters: [
                {
                  name: "媒体文件",
                  extensions: [
                    "mp4",
                    "mov",
                    "webm",
                    "mkv",
                    "jpg",
                    "jpeg",
                    "png",
                    "webp",
                    "gif",
                  ],
                },
              ],
            },
          );
          if (canceled || !out) return { saved: false };
          copyFileSync(filePath, out);
          return { saved: true, path: out };
        }
        if (!args.url || !/^https?:\/\//.test(args.url))
          return { saved: false, error: "无效的媒体直链" };
        let buf = await downloadBufferWithBrowser(args.url);
        if (args.platform === "wechat_channels") {
          if (!args.decodeKey)
            return {
              saved: false,
              error: "微信视频缺少 decode_key，请重新抓取后再下载",
            };
          buf = await decryptWechatVideo(buf, args.decodeKey);
        }
        const { canceled, filePath } = await dialog.showSaveDialog(
          mainWindow!,
          {
            title: "保存媒体",
            defaultPath: args.filename || "media",
            filters: [
              {
                name: "媒体文件",
                extensions: [
                  "mp4",
                  "mov",
                  "webm",
                  "mkv",
                  "jpg",
                  "jpeg",
                  "png",
                  "webp",
                  "gif",
                ],
              },
            ],
          },
        );
        if (canceled || !filePath) return { saved: false };
        writeFileSync(filePath, buf);
        return { saved: true, path: filePath };
      } catch (e: any) {
        return { saved: false, error: e?.message ?? String(e) };
      }
    },
  );

  // 模块七：选择本地视频文件（返回绝对路径，供真实剪辑使用）
  ipcMain.handle(IPC_CHANNELS.pickVideoFiles, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: "选择视频或图片素材",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "视频和图片",
          extensions: [
            "mp4",
            "mov",
            "mkv",
            "webm",
            "avi",
            "m4v",
            "jpg",
            "jpeg",
            "png",
            "webp",
            "gif",
            "bmp",
          ],
        },
      ],
    });
    return res.canceled ? [] : res.filePaths;
  });

  // 模块七：调用 ffmpeg 按 AI 方案渲染成片
  ipcMain.handle(
    IPC_CHANNELS.renderEditPlan,
    (
      e,
      args: {
        materials: EditMaterial[];
        plans: EditPlan[];
        runId?: string;
        burnCaptions: boolean;
        subtitle?: any;
        titleSubtitle?: any;
        voiceoverText?: string;
        voiceoverSegments?: Array<{ text: string; startSec: number; endSec: number }>;
        voiceoverVoice?: string;
        voiceoverRate?: number;
        voiceoverLocale?: string;
        videoType?: 'landscape'|'portrait';
      },
    ) => {
      if (!args?.materials?.length) throw new Error("请先选择本地视频素材");
      for (const m of args.materials) {
        if (!m?.filePath || !existsSync(m.filePath))
          throw new Error(`本地素材不存在：${m?.name ?? "未知文件"}`);
        if (m.url) delete m.url;
      }
      const outDir = join(app.getPath("userData"), "edits");
      // 仅生成一个通用底片，平台 Hook 不再分别渲染成片
      const runId = args.runId ?? randomUUID();
      return withProgress(e.sender, runId, async () => {
        const activePlan = args.plans?.[0];
        const platformLabels: Record<string, string> = {
          tiktok: "TikTok",
          instagram: "Instagram",
          youtube: "YouTube",
          xiaohongshu: "小红书",
          wechat_channels: "视频号",
        };
        const platform = activePlan
          ? platformLabels[activePlan.platform] ?? activePlan.platform
          : undefined;
        trace.add({ kind: 'ffmpeg', title: 'AI剪辑：开始本地 FFmpeg 合成', endpoint: '', method: 'POST', status: 102, ok: true, durationMs: 0, params: platform ? { platform } : undefined, summary: platform ? `${platform}：正在执行裁剪、拼接、字幕和音频混合` : '正在执行裁剪、拼接、字幕和音频混合' });
        const result = await renderPlans(args.materials, (args.plans ?? []).slice(0, 1), {
        burnCaptions: args.burnCaptions,
        subtitle: args.subtitle,
        titleSubtitle: args.titleSubtitle,
        voiceoverText: args.voiceoverText,
        voiceoverSegments: args.voiceoverSegments,
        voiceoverVoice: args.voiceoverVoice,
        voiceoverRate: args.voiceoverRate,
        voiceoverLocale: args.voiceoverLocale,
        fontDir: userFontDir(),
        videoType: args.videoType,
        outDir,
        });
        trace.add({ kind: 'ffmpeg', title: 'AI剪辑：FFmpeg 合成完成', endpoint: '', method: 'POST', status: 200, ok: true, durationMs: 0, params: platform ? { platform } : undefined, summary: platform ? `${platform}：通用底片已生成` : '通用底片已生成' });
        return result;
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.previewTts, async (_e, args: { text: string; voice?: string; locale?: string; rate?: number }) => {
    const tmp = mkdtempSync(join(os.tmpdir(), "ost-tts-preview-"));
    const output = join(tmp, "preview.mp3");
    try {
      await synthesizeVoiceover(args?.text || "", output, args?.voice, args?.rate, args?.locale);
      if (!existsSync(output)) throw new Error("试听音频生成失败");
      return { audioDataUrl: `data:audio/mpeg;base64,${readFileSync(output).toString("base64")}` };
    } catch (error: any) {
      return { error: error?.message || String(error) };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  ipcMain.handle(IPC_CHANNELS.generateSpeechAudio, async (_e, args) => {
    const text = String(args?.text || "").trim();
    if (!text) throw new Error("请输入口播文案");
    const format = ["mp3", "wav", "m4a", "ogg"].includes(args?.format)
      ? args.format
      : "mp3";
    const outDir = join(app.getPath("userData"), "audio");
    mkdirSync(outDir, { recursive: true });
    const outputPath = join(outDir, `voiceover-${Date.now()}.${format}`);
    await generateSpeechAudio(
      text,
      outputPath,
      format,
      args?.voice,
      Number(args?.rate ?? 1),
      args?.locale,
    );
    return { outputPath };
  });

  const userFontDir = () => join(app.getPath("userData"), "fonts");
  const bundledFontDirs = () => [
    join(process.cwd(), "static", "font"),
    join(app.getAppPath(), "static", "font"),
    join(process.resourcesPath, "static", "font"),
    join(__dirname, "../../static/font"),
  ];
  ipcMain.handle(IPC_CHANNELS.listFonts, async () => {
    const result = new Map<string, { name: string; path: string; builtIn: boolean }>();
    for (const dir of [userFontDir(), ...bundledFontDirs()]) {
      try {
        for (const name of readdirSync(dir).filter((f) => /\.(ttf|otf|ttc)$/i.test(f))) {
          if (!result.has(name)) result.set(name, { name, path: join(dir, name), builtIn: dir !== userFontDir() });
        }
      } catch { /* missing font directory */ }
    }
    return Array.from(result.values()).sort((a, b) => a.name.localeCompare(b.name));
  });
  ipcMain.handle(IPC_CHANNELS.pickFontFile, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: "选择字体文件",
      properties: ["openFile"],
      filters: [{ name: "字体文件", extensions: ["ttf", "otf", "ttc"] }],
    });
    return res.canceled ? null : (res.filePaths[0] || null);
  });
  ipcMain.handle(IPC_CHANNELS.uploadFont, async (_e, args: { sourcePath: string }) => {
    try {
      const source = args?.sourcePath;
      if (!source || !existsSync(source) || !/\.(ttf|otf|ttc)$/i.test(source)) throw new Error("请选择有效的字体文件");
      const name = source.split(/[\\/]/).pop()!;
      const dir = userFontDir();
      mkdirSync(dir, { recursive: true });
      copyFileSync(source, join(dir, name));
      return { name };
    } catch (error: any) {
      return { error: error?.message || String(error) };
    }
  });
  ipcMain.handle(IPC_CHANNELS.deleteFont, async (_e, args: { name: string }) => {
    try {
      const name = String(args?.name || "");
      if (!name || name !== name.split(/[\\/]/).pop() || !/\.(ttf|otf|ttc)$/i.test(name)) throw new Error("字体名称无效");
      const settings: any = mysqlCache.enabled
        ? ((await mysqlCache.get("ai_edit_settings"))?.data ?? {})
        : readJson("ai_edit_settings", {} as any);
      const usedFonts = ["captionStyle", "titleStyle", "landscapeCaptionStyle", "portraitCaptionStyle", "landscapeTitleStyle", "portraitTitleStyle"]
        .map((key) => settings?.[key]?.font)
        .filter(Boolean)
        .map((font: string) => font.split(/[\\/]/).pop());
      if (usedFonts.includes(name)) {
        throw new Error("该字体正在设置页使用，无法删除");
      }
      const target = join(userFontDir(), name);
      if (!existsSync(target)) throw new Error("内置字体或字体文件不存在");
      rmSync(target, { force: true });
      return { deleted: true };
    } catch (error: any) {
      return { deleted: false, error: error?.message || String(error) };
    }
  });

  // 在文件管理器中打开（成片所在目录 / 已下载的视频）
  ipcMain.handle(IPC_CHANNELS.openPath, (_e, p: string) => {
    shell.openPath(p);
  });
  ipcMain.handle(IPC_CHANNELS.showItemInFolder, (_e, p: string) => {
    if (typeof p === "string" && p.trim()) shell.showItemInFolder(p);
  });

  // 获取node-edge-tts音色列表，按国籍分类
  // 1. 首次使用时从在线获取并存入数据库
  // 2. 后续从数据库读取
  ipcMain.handle(IPC_CHANNELS.getTtsLocales, async () => {
    console.log('[Main] getTtsLocales 被调用');
    try {
      // 检查数据库是否为空，如果为空则自动同步
      console.log('[Main] 检查数据库是否为空...');
      const isEmpty = await mysqlCache.isTtsVoicesEmpty();
      console.log('[Main] 数据库是否为空:', isEmpty);
      let locales = await mysqlCache.listTtsLocales();
      if (isEmpty || locales.length === 0) {
        console.log('TTS 音色数据库为空，开始在线同步...');
        console.log('[Main] 开始调用 Edge TTS voices/list...');
        const voices = await fetchEdgeTtsVoices();
        console.log('[Main] 获取到在线音色数量:', voices.length);
        await mysqlCache.syncTtsVoices(voices);
        console.log('TTS 音色同步完成');
        locales = await mysqlCache.listTtsLocales();
      }
      console.log('[Main] 返回 locales 数量:', locales.length);
      return locales;
    } catch (error) {
      console.error('获取 TTS locales 失败:', error);
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.getTtsVoicesByLocale, async (_e, args: { locale: string }) => {
    try {
      return await mysqlCache.listTtsVoicesByLocale(args?.locale || '');
    } catch (error) {
      console.error('获取 TTS voices 失败:', error);
      return [];
    }
  });

  // 手动同步音色数据（从在线获取最新数据）
  ipcMain.handle(IPC_CHANNELS.syncTtsVoices, async () => {
    try {
      const voices = await fetchEdgeTtsVoices();
      await mysqlCache.syncTtsVoices(voices);
      return { synced: true, count: voices.length };
    } catch (error) {
      console.error('同步 TTS 音色失败:', error);
      return { synced: false, count: 0 };
    }
  });
}

app.whenReady().then(() => {
  registerLocalProtocol();
  registerIpc();
  createWindow();
  // 提前初始化 MySQL 云端缓存：连接池预热 + 确保 api_cache 表存在（数据库为空 / 不可达时静默跳过，不影响启动）
  mysqlCache.init().catch(() => {});
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * 注册本地媒体协议 localmedia://：将 localmedia://<file> 映射到本地视频落盘目录，
 * 使渲染进程能直接播放已下载到本地的视频（永不过期）。带目录穿越防护。
 */
function registerLocalProtocol() {
  if (protocol.isProtocolRegistered("localmedia")) return;
  protocol.registerFileProtocol("localmedia", (request, callback) => {
    try {
      const fileName = decodeURIComponent(
        request.url.replace("localmedia://", ""),
      );
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

app.on("window-all-closed", () => {
  closeWechatDecryptWindow();
  if (process.platform !== "darwin") app.quit();
});

// 便于类型推导
export type { IpcApi };
