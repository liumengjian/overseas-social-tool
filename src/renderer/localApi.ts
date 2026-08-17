// 浏览器 / 开发态兜底实现。
// 当渲染端检测到没有 Electron 注入的 window.api（例如直接用 Vite 在浏览器里
// `npm run dev` 预览，或 Electron 尚未加载 preload）时，提供一个与 IpcApi 完全一致的
// 内存接口，使页面可正常挂载并呈现「空状态」。所有列表返回空数组，不填充任何示例数据。
// 真实桌面端由 preload 注入 window.api（经 IPC 调用主进程，可接真实数据 / 大模型）。

import { IpcApi, RenderResult } from '../shared/ipc';
import { AppConfig, AiTaskName, SocialVideo, TrendTopic, HashtagStat, VideoComment } from '../shared/types';
import { EditMaterial, EditPlan } from '../analysis/ai-edit';

// 由 vite.config 的 define 在构建期注入的布尔开关（仅表示 .env 是否配置了对应令牌，不含密钥值）。
const tokenConfigured: boolean = __TIKHUB_CONFIGURED__;
const minimaxConfigured: boolean = __MINIMAX_CONFIGURED__;

const delay = <T,>(val: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(val), 100));

export function createLocalApi(): IpcApi {
  return {
    getConfig: () =>
      delay<AppConfig>({
        tikhubApiToken: '',
        tikhubBaseUrl: 'https://api.tikhub.io',
        fetchVideoCount: 30,
        llmApiKey: '',
        llmBaseUrl: '',
        llmModel: '',
        tokenConfigured,
        minimaxConfigured,
      }),

    saveConfig: () => {
      throw new Error('浏览器预览模式不支持保存配置，请在桌面端运行。');
    },
    resetConfig: () => {
      throw new Error('浏览器预览模式不支持重置配置，请在桌面端运行。');
    },

    fetchAccount: () => {
      if (tokenConfigured) {
        throw new Error('已在 .env 检测到 TiKhub 令牌，但浏览器预览模式无法真正调用接口。请使用 Electron 桌面端（npm run electron:dev）运行以拉取真实竞对数据。');
      }
      throw new Error('未配置 TiKhub 令牌，请在 .env 填写 TIKHUB_API_TOKEN 后用桌面端运行。');
    },

    fetchVideos: () => delay<SocialVideo[]>([]),
    getVideoDb: () => delay<SocialVideo[]>([]),
    fetchTrends: () => delay<TrendTopic[]>([]),
    fetchHashtags: () => delay<HashtagStat[]>([]),
    fetchTrendData: () => delay<{ trends: TrendTopic[]; hashtags: HashtagStat[] }>({ trends: [], hashtags: [] }),
    fetchVideoDetail: () => delay<{ video: SocialVideo | null; mediaUrl?: string; comments: VideoComment[] }>({ video: null, comments: [] }),
    searchVideos: () => delay<SocialVideo[]>([]),
    importVideos: () => delay<{ imported: number }>({ imported: 0 }),
    uploadVideosToMiniMax: () => {
      throw new Error('浏览器预览模式不支持上传视频到 MiniMax，请在桌面端运行。');
    },

    runAiTask: (_args: { task: AiTaskName; payload: any }) => {
      if (minimaxConfigured) {
        throw new Error('已在 .env 检测到 MiniMax 令牌，但浏览器预览模式无法调用大模型。请用 Electron 桌面端（npm run electron:dev）运行以执行真实 AI 分析。');
      }
      throw new Error('未配置 MiniMax 令牌，请在 .env 填写 MINIMAX_API_KEY 后用桌面端运行。');
    },

    analyzeVideoSafe: (_args: { platform: any; videoId: string; runId?: string }) => {
      if (minimaxConfigured) {
        throw new Error('已在 .env 检测到 MiniMax 令牌，但浏览器预览模式无法调用大模型。请用 Electron 桌面端（npm run electron:dev）运行以执行真实 AI 分析。');
      }
      throw new Error('未配置 MiniMax 令牌，请在 .env 填写 MINIMAX_API_KEY 后用桌面端运行。');
    },

    generateEditPlan: (_materials: EditMaterial[]) => {
      if (minimaxConfigured) {
        throw new Error('已在 .env 检测到 MiniMax 令牌，但浏览器预览模式无法调用大模型。请用 Electron 桌面端（npm run electron:dev）运行以生成真实剪辑方案。');
      }
      throw new Error('未配置 MiniMax 令牌，请在 .env 填写 MINIMAX_API_KEY 后用桌面端运行。');
    },

    downloadVideo: () => {
      throw new Error('浏览器预览模式不支持下载视频，请在桌面端运行。');
    },

    pickVideoFiles: () => {
      throw new Error('浏览器预览模式不支持选择本地文件，请在桌面端运行。');
    },
    renderEditPlan: (_args: { materials: EditMaterial[]; plans: EditPlan[]; burnCaptions: boolean }): Promise<RenderResult[]> => {
      throw new Error('浏览器预览模式无 ffmpeg 与本地文件能力，请在桌面端运行以执行真实剪辑。');
    },
    openPath: (_p: string) => {
      throw new Error('浏览器预览模式不支持打开本地文件夹，请在桌面端运行。');
    },

    onProgress: () => () => {},
    onAiChunk: () => () => {},
  };
}
