// 渲染进程 ↔ 主进程 的 IPC 通道与参数类型
import {
  AppConfig,
  ImageModelConfig,
  HashtagStat,
  Platform,
  SocialAccount,
  SocialVideo,
  TrendTopic,
  VideoComment,
  AiTaskName,
} from "./types";
import {
  EditMaterial,
  EditPlan,
  EditGenerationOptions,
  EditSubtitleStyle,
} from "../analysis/ai-edit";
import type { TraceStep, Traced } from "./trace";

/** 实时进度事件：主进程每完成一步（TiKhub 接口 / MiniMax 推理）就推送一条 */
export interface ProgressEvent {
  runId: string;
  step: TraceStep;
}

/** 批量任务总进度事件：例如「全部替换为本地路径」逐条处理时推送 current/total，用于弹窗展示 1/10 */
export interface BatchProgressEvent {
  runId: string;
  current: number;
  total: number;
  label?: string;
}

/** AI 流式输出事件：MiniMax 一边生成一边推送 token */
export interface AiChunkEvent {
  runId: string;
  text: string;
}

export interface ImageInput {
  url?: string;
  dataUrl?: string;
}

export interface GeneratedImage {
  url?: string;
  b64?: string;
  contentType: string;
}

export interface ImageTemplateCategory {
  id: string;
  name: string;
  createdAt: string;
}

export interface SopReply {
  id: string;
  label: string;
  content: string;
  createdAt: string;
}

export interface ImageTemplate {
  id: string;
  title: string;
  description: string;
  categoryId: string;
  category: string;
  imageDataUrl: string;
  aspectRatio: string;
  createdAt: string;
}

export interface IpcApi {
  getConfig: () => Promise<AppConfig>;
  generateImage: (args: {
    prompt: string;
    size?: string;
    runId?: string;
    model?: ImageModelConfig;
  }) => Promise<GeneratedImage[]>;
  editImage: (args: {
    prompt: string;
    size?: string;
    images: ImageInput[];
    mask?: ImageInput;
    runId?: string;
    model?: ImageModelConfig;
  }) => Promise<GeneratedImage[]>;
  fetchAccount: (args: {
    platform: Platform;
    url: string;
    runId?: string;
  }) => Promise<Traced<SocialAccount>>;
  fetchVideos: (args: {
    platform: Platform;
    url: string;
    limit?: number;
    runId?: string;
  }) => Promise<Traced<SocialVideo[]>>;
  fetchAccountVideos: (args: {
    platform: Platform;
    url: string;
    limit?: number;
    runId?: string;
  }) => Promise<Traced<SocialVideo[]>>;
  getVideoDb: () => Promise<SocialVideo[]>;
  updateVideoHook: (args: { id: string; hook: string }) => Promise<void>;
  fetchTrends: (args: {
    platform: Platform;
    runId?: string;
    keyword?: string;
  }) => Promise<Traced<TrendTopic[]>>;
  fetchHashtags: (args: {
    platform: Platform;
    runId?: string;
    keyword?: string;
  }) => Promise<Traced<HashtagStat[]>>;
  // 热点 / Tag 追踪：同平台一次拉取「趋势 + Hashtag」，合并为一个工作流（避免重复/串台）
  // bypassCache=true 时忽略 MySQL 云端缓存强制刷新（热点页「重新获取数据」按钮）
  fetchTrendData: (args: {
    platform: Platform;
    runId?: string;
    keyword?: string;
    bypassCache?: boolean;
  }) => Promise<
    Traced<{
      trends: TrendTopic[];
      hashtags: HashtagStat[];
      fromCache?: boolean;
    }>
  >;
  // 单条视频详情（元数据 + 无水印直链 + 评论）：模块二/四/五多模态分析前的数据准备
  fetchVideoDetail: (args: {
    platform: Platform;
    videoId: string;
    url?: string;
    runId?: string;
  }) => Promise<
    Traced<{
      video: SocialVideo | null;
      mediaUrl?: string;
      comments: VideoComment[];
    }>
  >;
  // 导入外部视频数据（CSV 等）到本地库（按 id 合并，不覆盖历史）
  importVideos: (videos: SocialVideo[]) => Promise<{ imported: number }>;
  // 批量把所有视频链接下载到本地，并将可播放地址替换为本地路径（localmedia://），永不过期
  replaceMediaWithLocal: (args: {
    runId?: string;
  }) => Promise<
    Traced<{
      downloaded: number;
      failed: number;
      skipped: number;
      total: number;
    }>
  >;
  // 删除视频库中的视频（支持批量传入 id）；若为本地落盘视频，同时删除本地文件
  deleteVideos: (args: {
    ids: string[];
  }) => Promise<{ removed: number; localDeleted: number; error?: string }>;
  // 关键词搜索：模块三热点追踪辅助 / 跨平台兜底
  searchVideos: (args: {
    platform: Platform;
    keyword: string;
    runId?: string;
  }) => Promise<Traced<SocialVideo[]>>;
  // 统一 AI 任务分发（模块一/二/三/四/五/六）：由 MiniMax-M3 多模态推理（流式输出）
  runAiTask: (args: {
    task: AiTaskName;
    payload: any;
    runId?: string;
  }) => Promise<any>;
  // 视频内容解析（模块二）：内置「敏感内容自动脱敏恢复」——直连解析被判定敏感时，
  // 自动重新编码/抽帧脱敏后重试。脱敏编码通过审核后另存到 encoded 目录并写回 localEncodedMediaUrl，不替换原链接。
  analyzeVideoSafe: (args: {
    platform: Platform;
    videoId: string;
    runId?: string;
  }) => Promise<
    Traced<{
      analysis: any;
      method: "direct" | "sanitized" | "frames";
      sensitiveRecovered?: boolean;
    }>
  >;
  generateEditPlan: (
    materials: EditMaterial[],
    options?: EditGenerationOptions,
    runId?: string,
  ) => Promise<Traced<EditPlan[]>>;
  uploadVideoToCos: (args: { filePath: string }) => Promise<{ url: string }>;
  // 下载视频到本地（传入可直链 + 文件名，主进程落盘）
  downloadVideo: (args: {
    url: string;
    filename: string;
    platform?: Platform;
    decodeKey?: string;
  }) => Promise<{ saved: boolean; path?: string; error?: string }>;
  pickVideoFiles: () => Promise<string[]>;
  listFonts: () => Promise<Array<{ name: string; path: string; builtIn: boolean }>>;
  pickFontFile: () => Promise<string | null>;
  uploadFont: (args: { sourcePath: string }) => Promise<{ name?: string; error?: string }>;
  deleteFont: (args: { name: string }) => Promise<{ deleted: boolean; error?: string }>;
  renderEditPlan: (args: {
    materials: EditMaterial[];
    plans: EditPlan[];
    runId?: string;
    burnCaptions: boolean;
    subtitle?: {
      position?: "top" | "center" | "bottom";
      color?: string;
      fontSize?: number;
      font?: string;
      x?: number;
      y?: number;
      width?: number;
      fontWeight?: "normal" | "bold" | number;
      outlineColor?: string;
      outlineWidth?: number;
    };
    titleSubtitle?: EditSubtitleStyle;
    voiceoverText?: string;
    voiceoverSegments?: Array<{
      text: string;
      startSec: number;
      endSec: number;
    }>;
    voiceoverVoice?: string;
    voiceoverRate?: number;
    voiceoverLocale?: string;
    videoType?: 'landscape'|'portrait';
  }) => Promise<RenderResult[]>;
  previewTts: (args: { text: string; voice?: string; locale?: string; rate?: number }) => Promise<{ audioDataUrl?: string; error?: string }>;
  generateSpeechAudio: (args: {
    text: string;
    format: "mp3" | "wav" | "m4a" | "ogg";
    voice?: string;
    locale?: string;
    rate?: number;
  }) => Promise<{ outputPath: string }>;
  openPath: (p: string) => Promise<void>;
  showItemInFolder: (p: string) => Promise<void>;
  saveConfig: (cfg: AppConfig) => Promise<AppConfig>;
  resetConfig: () => Promise<AppConfig>;
  // 通用本地持久化（页面操作数据，跨重启保留）：key 仅允许字母数字/下划线/连字符
  getJson: (key: string) => Promise<any>;
  setJson: (key: string, value: any) => Promise<void>;
  // AI 生图模板是业务数据，统一保存至 MySQL；未配置/连接失败会明确返回错误，不回退本地 JSON。
  listImageTemplateCategories: () => Promise<ImageTemplateCategory[]>;
  createImageTemplateCategory: (args: {
    name: string;
  }) => Promise<ImageTemplateCategory>;
  updateImageTemplateCategory: (args: {
    id: string;
    name: string;
  }) => Promise<ImageTemplateCategory>;
  reorderImageTemplateCategories: (args: { ids: string[] }) => Promise<void>;
  deleteImageTemplateCategory: (args: {
    id: string;
  }) => Promise<{ deleted: boolean }>;
  listImageTemplates: () => Promise<ImageTemplate[]>;
  // 图片上传由主进程完成，COS 密钥绝不暴露给 renderer / preload。
  uploadTemplateImage: (args: {
    dataUrl: string;
    fileName?: string;
    contentType?: string;
  }) => Promise<{ url: string }>;
  createImageTemplate: (args: {
    title: string;
    description: string;
    categoryId: string;
    imageDataUrl: string;
    imageFileName?: string;
    aspectRatio: string;
  }) => Promise<ImageTemplate>;
  updateImageTemplate: (args: {
    id: string;
    title: string;
    description: string;
    categoryId: string;
    imageDataUrl?: string;
    imageFileName?: string;
    aspectRatio?: string;
  }) => Promise<ImageTemplate>;
  deleteImageTemplate: (args: { id: string }) => Promise<{ deleted: boolean }>;
  generateSopReply: (args: {
    question: string;
    systemPrompt?: string;
    runId?: string;
  }) => Promise<string>;
  listSopReplies: () => Promise<SopReply[]>;
  createSopReply: (args: {
    label: string;
    content: string;
  }) => Promise<SopReply>;
  updateSopReply: (args: {
    id: string;
    label: string;
    content: string;
  }) => Promise<SopReply>;
  deleteSopReply: (args: { id: string }) => Promise<{ deleted: boolean }>;
  // 订阅实时进度 / AI 流式输出（返回取消订阅函数）
  onProgress: (cb: (e: ProgressEvent) => void) => () => void;
  onAiChunk: (cb: (e: AiChunkEvent) => void) => () => void;
  // 订阅批量任务总进度（current/total，如「1/10」）
  onBatchProgress: (cb: (e: BatchProgressEvent) => void) => () => void;
  // 取消正在执行的任务（runId）：主进程中断在途网络请求（fetch abort）
  cancelRun: (runId: string) => Promise<boolean>;
  // MySQL 云端缓存：查询（maxDays 为 0/缺省 = 永久；热点按当天日期判断）
  queryCache: (args: {
    key: string;
    type:
      | "hotspot"
      | "own_account"
      | "competitor_account"
      | "viral"
      | "voiceover";
    maxDays?: number;
    runId?: string;
  }) => Promise<Traced<{ hit: boolean; data?: any; cachedAt?: string }>>;
  // MySQL 云端缓存：写入（覆盖同 key）
  saveCache: (args: {
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
  }) => Promise<{ saved: boolean }>;
  extractVoiceover: (args: {
    sourceUrl: string;
    pageUrl?: string;
    videoId?: string;
    mediaUrls?: string[];
    platform?: Platform;
    runId?: string;
  }) => Promise<{
    transcript: {
      text: string;
      segments: { start: number; end: number; text: string }[];
    };
    analysis: {
      keyPoints: string[];
      hook: string;
      closingCta: string;
      opening: string;
      middle: string;
      ending: string;
    };
  }>;
  // 用 yt-dlp 把在线视频链接解析为可播放直链（爆款拆解「链接直连」入口使用）
  resolveMediaUrl: (args: {
    url: string;
    runId?: string;
  }) => Promise<
    Traced<{
      mediaUrl?: string;
      title?: string;
      thumbnail?: string;
      uploader?: string;
      error?: string;
    }>
  >;
  // 获取node-edge-tts在线音色列表（从数据库读取）
  getTtsLocales: () => Promise<Array<{ locale: string; label: string }>>;
  getTtsVoicesByLocale: (args: { locale: string }) => Promise<Array<{
    name: string;
    shortName: string;
    gender: string;
    locale: string;
    friendlyName: string;
    voiceType: string;
  }>>;
  syncTtsVoices: () => Promise<{ synced: boolean; count: number }>;
}

export interface RenderResult {
  direction: EditPlan["direction"];
  platform: EditPlan["platform"];
  outputPath: string;
  error?: string;
}

export const IPC_CHANNELS = {
  getConfig: "getConfig",
  generateImage: "generateImage",
  editImage: "editImage",
  fetchAccount: "fetchAccount",
  fetchVideos: "fetchVideos",
  fetchAccountVideos: "fetchAccountVideos",
  getVideoDb: "getVideoDb",
  updateVideoHook: "updateVideoHook",
  fetchTrends: "fetchTrends",
  fetchHashtags: "fetchHashtags",
  fetchTrendData: "fetchTrendData",
  fetchVideoDetail: "fetchVideoDetail",
  searchVideos: "searchVideos",
  importVideos: "importVideos",
  replaceMediaWithLocal: "replaceMediaWithLocal",
  deleteVideos: "deleteVideos",
  runAiTask: "runAiTask",
  analyzeVideoSafe: "analyzeVideoSafe",
  generateEditPlan: "generateEditPlan",
  uploadVideoToCos: "uploadVideoToCos",
  downloadVideo: "downloadVideo",
  pickVideoFiles: "pickVideoFiles",
  listFonts: "listFonts",
  pickFontFile: "pickFontFile",
  uploadFont: "uploadFont",
  deleteFont: "deleteFont",
  renderEditPlan: "renderEditPlan",
  previewTts: "previewTts",
  generateSpeechAudio: "generateSpeechAudio",
  openPath: "openPath",
  showItemInFolder: "showItemInFolder",
  saveConfig: "saveConfig",
  resetConfig: "resetConfig",
  getJson: "getJson",
  setJson: "setJson",
  listImageTemplateCategories: "listImageTemplateCategories",
  createImageTemplateCategory: "createImageTemplateCategory",
  updateImageTemplateCategory: "updateImageTemplateCategory",
  reorderImageTemplateCategories: "reorderImageTemplateCategories",
  deleteImageTemplateCategory: "deleteImageTemplateCategory",
  listImageTemplates: "listImageTemplates",
  uploadTemplateImage: "uploadTemplateImage",
  createImageTemplate: "createImageTemplate",
  updateImageTemplate: "updateImageTemplate",
  deleteImageTemplate: "deleteImageTemplate",
  generateSopReply: "generateSopReply",
  listSopReplies: "listSopReplies",
  createSopReply: "createSopReply",
  updateSopReply: "updateSopReply",
  deleteSopReply: "deleteSopReply",
  cancelRun: "cancelRun",
  queryCache: "queryCache",
  saveCache: "saveCache",
  resolveMediaUrl: "resolveMediaUrl",
  extractVoiceover: "extractVoiceover",
  getTtsLocales: "getTtsLocales",
  getTtsVoicesByLocale: "getTtsVoicesByLocale",
  syncTtsVoices: "syncTtsVoices",
  // 事件通道（主进程 → 渲染进程 单向）
  progress: "progress",
  aichunk: "aichunk",
  batchProgress: "batchProgress",
} as const;

// 渲染进程类型推导用
export type { TraceStep, Traced };
