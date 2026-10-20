// 浏览器 / 开发态兜底实现。
// 当渲染端检测到没有 Electron 注入的 window.api（例如直接用 Vite 在浏览器里
// `npm run dev` 预览，或 Electron 尚未加载 preload）时，提供一个与 IpcApi 完全一致的
// 内存接口，使页面可正常挂载并呈现「空状态」。所有列表返回空数组，不填充任何示例数据。
// 真实桌面端由 preload 注入 window.api（经 IPC 调用主进程，可接真实数据 / 大模型）。

import { IpcApi, RenderResult } from '../shared/ipc';
import { AppConfig, AiTaskName, SocialVideo, TrendTopic, HashtagStat, VideoComment } from '../shared/types';
import { EditMaterial, EditPlan, EditGenerationOptions } from '../analysis/ai-edit';

// 由 vite.config 的 define 在构建期注入的布尔开关（仅表示 .env 是否配置了对应令牌，不含密钥值）。
const tokenConfigured: boolean = __TIKHUB_CONFIGURED__;
const videoConfigured: boolean = __VIDEO_CONFIGURED__;

const delay = <T,>(val: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(val), 100));

export function createLocalApi(): IpcApi {
  return {
    getConfig: () =>
      delay<AppConfig>({
        tikhubApiToken: '',
        tikhubBaseUrl: 'https://api.tikhub.io',
        fetchVideoCount: 50,
        llmApiKey: '',
        llmBaseUrl: 'https://api.new.bi/v1',
        llmModel: 'gemini-3.1-pro-preview',
        llmFileUploadPath: '/files/upload',
        sopApiKey: '',
        sopBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        sopModel: 'doubao-seed-2-0-lite-260215',
        imageApiFormat: 'openai',
        imageBaseUrl: 'https://api.new.bi/v1',
        imageApiKey: '',
        imageGeneratePath: '/images/generations',
        imageEditPath: '/images/edits',
        imageModel: 'gpt-image-2-1k',
        imageModels: [
          { name: 'gpt-image-2-1k', apiKey: 'sk-3i6qAAtSyDLZ48qlDULWVUvDCWSpS8tBpLTehnIIc9fPnkC3', resolution: '1k', description: '0.03/次' },
          { name: 'gpt-image-2-d', apiKey: 'sk-oLS9NhGMcE8i16Tg9jk9EaKHXKVHSHHvYhqxpdFGv12u3MAz', resolution: '2k', description: '0.07/次' },
          { name: 'gpt-image-2-c', apiKey: 'sk-po7x9RRzbBAAXfuMYjtl79xAYKl8pNO94KUxon3K4E5NDzP9', resolution: '4k', description: '0.15/次' },
        ],
        imageMaxResolution: '1k',
        imageBodyMode: 'json',
        imageEditStyle: 'auto',
        imageAdvancedParams: '',
        tokenConfigured,
        minimaxConfigured: videoConfigured,
        imageConfigured: false,
        mysqlHost: '',
        mysqlPort: 3306,
        mysqlUser: '',
        mysqlPassword: '',
        mysqlDatabase: '',
        mysqlEnabled: false,
        cosSecretId: '',
        cosSecretKey: '',
        cosBucket: '',
        cosRegion: '',
        cosCdnDomain: '',
        cosConfigured: false,
        hotspotCacheDays: 1,
        accountCacheDays: 7,
        ytdlpPath: 'yt-dlp',
      }),

    generateImage: () => {
      throw new Error('浏览器预览模式不支持调用图片模型，请在 Electron 桌面端运行。');
    },
    editImage: () => {
      throw new Error('浏览器预览模式不支持调用图片模型，请在 Electron 桌面端运行。');
    },
    generateSopReply: () => { throw new Error('浏览器预览模式不支持调用客服对话模型，请在 Electron 桌面端运行。'); },
    listSopReplies: () => delay([]),
    createSopReply: () => { throw new Error('浏览器预览模式不支持数据库，请在 Electron 桌面端运行。'); },
    updateSopReply: () => { throw new Error('浏览器预览模式不支持数据库，请在 Electron 桌面端运行。'); },
    deleteSopReply: () => { throw new Error('浏览器预览模式不支持数据库，请在 Electron 桌面端运行。'); },

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
    fetchAccountVideos: () => delay<SocialVideo[]>([]),
    getVideoDb: () => delay<SocialVideo[]>([]),
    updateVideoHook: () => delay<void>(undefined),
    fetchTrends: () => delay<TrendTopic[]>([]),
    fetchHashtags: () => delay<HashtagStat[]>([]),
    fetchTrendData: () => delay<{ trends: TrendTopic[]; hashtags: HashtagStat[] }>({ trends: [], hashtags: [] }),
    fetchVideoDetail: () => delay<{ video: SocialVideo | null; mediaUrl?: string; comments: VideoComment[] }>({ video: null, comments: [] }),
    searchVideos: () => delay<SocialVideo[]>([]),
    importVideos: () => delay<{ imported: number }>({ imported: 0 }),
    replaceMediaWithLocal: () => {
      throw new Error('浏览器预览模式不支持下载视频到本地，请在桌面端运行。');
    },
    deleteVideos: () => {
      throw new Error('浏览器预览模式不支持删除视频，请在桌面端运行。');
    },

    runAiTask: (_args: { task: AiTaskName; payload: any }) => {
      if (videoConfigured) {
        throw new Error('已在 .env 检测到模型令牌，但浏览器预览模式无法调用大模型。请用 Electron 桌面端（npm run electron:dev）运行以执行真实 AI 分析。');
      }
      throw new Error('未配置视频解析大模型令牌，请在 .env 配置模型 API Key 后用桌面端运行。');
    },

    analyzeVideoSafe: (_args: { platform: any; videoId: string; runId?: string }) => {
      if (videoConfigured) {
        throw new Error('已在 .env 检测到模型令牌，但浏览器预览模式无法调用大模型。请用 Electron 桌面端（npm run electron:dev）运行以执行真实 AI 分析。');
      }
      throw new Error('未配置视频解析大模型令牌，请在 .env 配置模型 API Key 后用桌面端运行。');
    },

    generateEditPlan: (_materials: EditMaterial[], _options?: EditGenerationOptions, _runId?: string) => {
      if (videoConfigured) {
        throw new Error('已在 .env 检测到模型令牌，但浏览器预览模式无法调用大模型。请用 Electron 桌面端（npm run electron:dev）运行以生成真实剪辑方案。');
      }
      throw new Error('未配置视频解析大模型令牌，请在 .env 配置模型 API Key 后用桌面端运行。');
    },

    uploadVideoToCos: () => {
      throw new Error('浏览器预览模式不支持上传视频到 COS，请在 Electron 桌面端运行。');
    },
    downloadVideo: () => {
      throw new Error('浏览器预览模式不支持下载视频，请在桌面端运行。');
    },

    pickVideoFiles: () => {
      throw new Error('浏览器预览模式不支持选择本地文件，请在桌面端运行。');
    },
    listFonts: () => delay([
      'BubblegumSans-Regular.ttf', 'CabinSketch-Regular.ttf', 'Fredoka-Regular.ttf',
      'Montserrat-Regular.ttf', 'NotoSans-Regular.ttf', 'Outfit-Regular.ttf',
      'Quicksand-Bold.ttf', 'Roboto-Medium.ttf',
    ].map((name) => ({ name, path: name, builtIn: true }))),
    pickFontFile: () => delay<string | null>(null),
    uploadFont: async () => ({ error: '浏览器预览模式不支持上传字体，请在 Electron 桌面端运行。' }),
    deleteFont: async () => ({ deleted: false, error: '浏览器预览模式不支持删除字体，请在 Electron 桌面端运行。' }),
    renderEditPlan: (_args: { materials: EditMaterial[]; plans: EditPlan[]; burnCaptions: boolean; subtitle?: any; voiceoverRate?: number }): Promise<RenderResult[]> => {
      throw new Error('浏览器预览模式无 ffmpeg 与本地文件能力，请在桌面端运行以执行真实剪辑。');
    },
    previewTts: async () => ({ error: '浏览器预览模式不支持音色试听，请在 Electron 桌面端运行。' }),
    generateSpeechAudio: async () => {
      throw new Error('浏览器预览模式不支持生成音频，请在 Electron 桌面端运行。');
    },
    openPath: (_p: string) => {
      throw new Error('浏览器预览模式不支持打开本地文件夹，请在桌面端运行。');
    },
    showItemInFolder: (_p: string) => {
      throw new Error('浏览器预览模式不支持定位本地文件，请在桌面端运行。');
    },

    onProgress: () => () => {},
    onAiChunk: () => () => {},
    onBatchProgress: () => () => {},

    // 浏览器预览模式：内存兜底，不持久化（真实持久化由桌面端 preload 经 IPC 完成）
    getJson: () => delay<any>(null),
    setJson: () => delay<void>(undefined),
    listImageTemplateCategories: () => {
      throw new Error('浏览器预览模式不支持数据库模板库，请在 Electron 桌面端运行。');
    },
    createImageTemplateCategory: () => {
      throw new Error('浏览器预览模式不支持数据库模板库，请在 Electron 桌面端运行。');
    },
    updateImageTemplateCategory: () => {
      throw new Error('浏览器预览模式不支持数据库模板库，请在 Electron 桌面端运行。');
    },
    reorderImageTemplateCategories: () => {
      throw new Error('浏览器预览模式不支持数据库模板库，请在 Electron 桌面端运行。');
    },
    deleteImageTemplateCategory: () => {
      throw new Error('浏览器预览模式不支持数据库模板库，请在 Electron 桌面端运行。');
    },
    listImageTemplates: () => {
      throw new Error('浏览器预览模式不支持数据库模板库，请在 Electron 桌面端运行。');
    },
    uploadTemplateImage: () => {
      throw new Error('浏览器预览模式不支持上传模板图片到 COS，请在 Electron 桌面端运行。');
    },
    createImageTemplate: () => {
      throw new Error('浏览器预览模式不支持数据库模板库，请在 Electron 桌面端运行。');
    },
    updateImageTemplate: () => {
      throw new Error('浏览器预览模式不支持数据库模板库，请在 Electron 桌面端运行。');
    },
    deleteImageTemplate: () => {
      throw new Error('浏览器预览模式不支持数据库模板库，请在 Electron 桌面端运行。');
    },
    cancelRun: () => delay<boolean>(true),
    queryCache: () => delay<{ hit: boolean }>({ hit: false }),
    saveCache: () => delay<{ saved: boolean }>({ saved: false }),
    extractVoiceover: () => {
      throw new Error('浏览器预览模式不支持音频提取与大模型转写，请在 Electron 桌面端运行。');
    },
    resolveMediaUrl: () =>
      delay<{ mediaUrl?: string; error?: string }>({
        error: '浏览器预览模式不支持 yt-dlp 解析，请在桌面端运行。',
      }),
    getTtsLocales: () => delay([]),
    getTtsVoicesByLocale: () => delay([]),
    syncTtsVoices: () => delay({ synced: false, count: 0 }),
  };
}
