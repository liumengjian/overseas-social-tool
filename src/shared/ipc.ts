// 渲染进程 ↔ 主进程 的 IPC 通道与参数类型
import { AppConfig, HashtagStat, Platform, SocialAccount, SocialVideo, TrendTopic, VideoComment, AiTaskName } from './types';
import { EditMaterial, EditPlan } from '../analysis/ai-edit';
import type { TraceStep, Traced } from './trace';

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

export interface IpcApi {
  getConfig: () => Promise<AppConfig>;
  fetchAccount: (args: { platform: Platform; url: string; runId?: string }) => Promise<Traced<SocialAccount>>;
  fetchVideos: (args: { platform: Platform; url: string; limit?: number; runId?: string }) => Promise<Traced<SocialVideo[]>>;
  getVideoDb: () => Promise<SocialVideo[]>;
  fetchTrends: (args: { platform: Platform; runId?: string; accounts?: string[] }) => Promise<Traced<TrendTopic[]>>;
  fetchHashtags: (args: { platform: Platform; runId?: string; accounts?: string[] }) => Promise<Traced<HashtagStat[]>>;
  // 热点 / Tag 追踪：同平台一次拉取「趋势 + Hashtag」，合并为一个工作流（避免重复/串台）
  fetchTrendData: (args: { platform: Platform; runId?: string; accounts?: string[] }) => Promise<Traced<{ trends: TrendTopic[]; hashtags: HashtagStat[] }>>;
  // 单条视频详情（元数据 + 无水印直链 + 评论）：模块二/四/五多模态分析前的数据准备
  fetchVideoDetail: (args: { platform: Platform; videoId: string; runId?: string }) => Promise<Traced<{ video: SocialVideo | null; mediaUrl?: string; comments: VideoComment[] }>>;
  // 导入外部视频数据（CSV 等）到本地库（按 id 合并，不覆盖历史）
  importVideos: (videos: SocialVideo[]) => Promise<{ imported: number }>;
  // 批量把所有视频链接下载到本地，并将可播放地址替换为本地路径（localmedia://），永不过期
  replaceMediaWithLocal: (args: { runId?: string }) => Promise<Traced<{ downloaded: number; failed: number; skipped: number; total: number }>>;
  // 删除视频库中的视频（支持批量传入 id）；若为本地落盘视频，同时删除本地文件
  deleteVideos: (args: { ids: string[] }) => Promise<{ removed: number; localDeleted: number; error?: string }>;
  // 关键词搜索：模块三热点追踪辅助 / 跨平台兜底
  searchVideos: (args: { platform: Platform; keyword: string; runId?: string }) => Promise<Traced<SocialVideo[]>>;
  // 统一 AI 任务分发（模块一/二/三/四/五/六）：由 MiniMax-M3 多模态推理（流式输出）
  runAiTask: (args: { task: AiTaskName; payload: any; runId?: string }) => Promise<any>;
  // 视频内容解析（模块二）：内置「敏感内容自动脱敏恢复」——直连解析被判定敏感时，
  // 自动重新编码/抽帧脱敏后重试。脱敏编码通过审核后另存到 encoded 目录并写回 localEncodedMediaUrl，不替换原链接。
  analyzeVideoSafe: (args: { platform: Platform; videoId: string; runId?: string }) => Promise<Traced<{ analysis: any; method: 'direct' | 'sanitized' | 'frames'; sensitiveRecovered?: boolean }>>;
  generateEditPlan: (materials: EditMaterial[], runId?: string) => Promise<Traced<EditPlan[]>>;
  // 下载视频到本地（传入可直链 + 文件名，主进程落盘）
  downloadVideo: (args: { url: string; filename: string }) => Promise<{ saved: boolean; path?: string; error?: string }>;
  pickVideoFiles: () => Promise<string[]>;
  renderEditPlan: (args: { materials: EditMaterial[]; plans: EditPlan[]; burnCaptions: boolean }) => Promise<RenderResult[]>;
  openPath: (p: string) => Promise<void>;
  saveConfig: (cfg: AppConfig) => Promise<AppConfig>;
  resetConfig: () => Promise<AppConfig>;
  // 通用本地持久化（页面操作数据，跨重启保留）：key 仅允许字母数字/下划线/连字符
  getJson: (key: string) => Promise<any>;
  setJson: (key: string, value: any) => Promise<void>;
  // 订阅实时进度 / AI 流式输出（返回取消订阅函数）
  onProgress: (cb: (e: ProgressEvent) => void) => () => void;
  onAiChunk: (cb: (e: AiChunkEvent) => void) => () => void;
  // 订阅批量任务总进度（current/total，如「1/10」）
  onBatchProgress: (cb: (e: BatchProgressEvent) => void) => () => void;
  // 取消正在执行的任务（runId）：主进程中断在途网络请求（fetch abort）
  cancelRun: (runId: string) => Promise<boolean>;
}

export interface RenderResult {
  direction: EditPlan['direction'];
  platform: EditPlan['platform'];
  outputPath: string;
  error?: string;
}

export const IPC_CHANNELS = {
  getConfig: 'getConfig',
  fetchAccount: 'fetchAccount',
  fetchVideos: 'fetchVideos',
  getVideoDb: 'getVideoDb',
  fetchTrends: 'fetchTrends',
  fetchHashtags: 'fetchHashtags',
  fetchTrendData: 'fetchTrendData',
  fetchVideoDetail: 'fetchVideoDetail',
  searchVideos: 'searchVideos',
  importVideos: 'importVideos',
  replaceMediaWithLocal: 'replaceMediaWithLocal',
  deleteVideos: 'deleteVideos',
  runAiTask: 'runAiTask',
  analyzeVideoSafe: 'analyzeVideoSafe',
  generateEditPlan: 'generateEditPlan',
  downloadVideo: 'downloadVideo',
  pickVideoFiles: 'pickVideoFiles',
  renderEditPlan: 'renderEditPlan',
  openPath: 'openPath',
  saveConfig: 'saveConfig',
  resetConfig: 'resetConfig',
  getJson: 'getJson',
  setJson: 'setJson',
  cancelRun: 'cancelRun',
  // 事件通道（主进程 → 渲染进程 单向）
  progress: 'progress',
  aichunk: 'aichunk',
  batchProgress: 'batchProgress',
} as const;

// 渲染进程类型推导用
export type { TraceStep, Traced };
