// 平台枚举（整合平台：TikTok / Instagram / YouTube / Facebook / 小红书 / 微信视频号）
export type Platform =
  | "tiktok"
  | "instagram"
  | "youtube"
  | "facebook"
  | "xiaohongshu"
  | "wechat_channels";

// 已接入业务数据平台（Facebook 保留在 Platform 中仅用于兼容历史数据，不参与新分析）。
export const ALL_PLATFORMS: Platform[] = [
  "tiktok",
  "instagram",
  "youtube",
  "xiaohongshu",
  "wechat_channels",
];

// 账号分类
export type AccountCategory = "conversion" | "traffic";

// 视频/帖子基础数据结构（跨平台统一）
export interface SocialVideo {
  id: string;
  platform: Platform;
  authorId: string;
  authorName: string;
  url: string;
  publishTime: string; // ISO 字符串
  title: string;
  caption: string;
  hook: string; // 开头3秒 Hook（可抽取）
  views: number;
  viewsKnown?: boolean;
  likes: number;
  comments: number;
  shares: number;
  favorites: number;
  durationSec: number;
  structure: string; // 视频结构描述
  source: string; // 素材来源
  tags: string[];
  bgm: string;
  mediaUrl?: string; // 可直链播放的视频/图片地址（真实抓取时填充，供大模型做理解）。为 TiKhub 临时直链，约 7 天后过期。
  // 微信视频号媒体使用前 128KB 加密；该字段是与 mediaUrl 同次响应返回的解密种子。
  decodeKey?: string;
  // 本地落盘后的媒体地址（经 localmedia:// 协议访问，永不过期）。由「全部替换为本地路径」按钮填充，
  // 用于播放/预览/下载；MiniMax 分析时主进程会读取该本地文件并上传到 MiniMax，因此不依赖 mediaUrl 的临时直链。
  localMediaUrl?: string;
  // 运行时标记：localMediaUrl 指向的本地文件已不存在（被手动删除/清理），刷新时会重新校验并标记。
  // 此时列表按「临时」展示，再次点击「全部替换为本地路径」会重新下载。
  localMediaMissing?: boolean;
  // ffmpeg 脱敏重新编码后的本地文件（经 localmedia:// 协议访问，位于 video_files/encoded 子目录）。
  // 当某条视频被 MiniMax 判定为敏感、经重新编码脱敏后审核通过，会把编码文件另存到该目录并写回此字段；
  // 后续 MiniMax 分析优先使用本文件（不再替换原视频的 localMediaUrl / mediaUrl）。
  localEncodedMediaUrl?: string;
  isVideo?: boolean; // 是否为视频类型（false 表示图文/相册类帖子）
  // 媒体类型细分：video=视频, image=图文/相册帖, audio=纯音频, music=音乐类型。
  // 抓取时保留 video 与 image，剔除 audio / music（纯音频/音乐文件不入库）。
  mediaType?: "video" | "image" | "audio" | "music";
  // 业务衍生字段
  category?: AccountCategory;
  isConversionOriented?: boolean; // 是否转化导向（含产品/咨询引导）
}

// MiniMax-M3 对单个视频的语义/音视频分析结果（模块二：视频内容解析）
export interface VideoAnalysis {
  // 文档规定字段
  first3sHook: string; // 视频前3秒画面与文案钩子
  videoStructure: string; // 完整视频叙事结构
  mainSceneSubject: string; // 视频主要拍摄主体
  userConcern: string; // 吸引海外用户的关注点
  // 兼容字段
  reasons: string[];
  elements: string[];
  suggestions: string[];
  scriptOutline: string;
  titles: string[];
  isMultimodal: boolean; // 是否真正传入了视频/音频做多模态理解
  raw?: string; // 模型原始返回（解析失败时的兜底）
}

// 账号档案
export interface SocialAccount {
  id: string;
  platform: Platform;
  uniqueId: string; // 平台用户名 / secUid
  name: string;
  url: string;
  followers: number;
  // false 表示当前数据源未提供粉丝数；与真实粉丝为 0 区分，页面与 AI 均不可将其当作 0。
  followersKnown?: boolean;
  likesTotal?: number;
  videoCount?: number;
  category: AccountCategory; // 分类结果
  categoryReason: string; // 分类结论摘要
  categoryEvidence?: string[]; // 分类依据明细
  bio?: string;
  // 模块一：MiniMax-M3 衍生字段
  businessPosition?: string; // 账号业务定位
  targetAudience?: string; // 推测目标海外客群
  drainageMethod?: string; // 引流方式
  workInsight?: string; // 基于高赞/代表性作品样本得到的账号内容特征洞察
  worksSample?: {
    title: string;
    likes: number;
    views: number;
    viewsKnown?: boolean;
    url: string;
  }[]; // 实际用于分析的账号作品样本（高赞 Top N）
  // 转化型账号专项：什么内容带来客户咨询和订单
  conversionContentInsight?: string; // 带来咨询/订单的内容特征
  conversionTriggers?: string; // 转化触发点
  conversionFriction?: string; // 转化阻碍点
  contentOptimization?: string[]; // 提升咨询/订单的优化建议
  // 流量型账号专项：海外用户喜欢看的中国旅游内容
  audienceFavoriteContent?: string; // 海外用户爱看的内容类型
  popularContentPattern?: string; // 高播放作品共性模式
  contentOpportunity?: string[]; // 可复制的选题方向
}

// 热点话题 / 趋势
export interface TrendTopic {
  platform: Platform;
  keyword: string;
  heat: number; // 热度值
  growth: number; // 增长率（近两次快照差值），可正可负
  relatedTags: string[];
  snapshotTime?: number; // 本次快照时间戳
  isNew?: boolean; // 是否首次出现（上一快照中无此关键词）
  // 「搜索→提取→验证」即时热点发现算法新增字段：
  heatDesc?: string; // 热度描述文案，如「浏览量 128万 / 讨论数 3.2万」「帖子数 45.2万」「候选频次 N 次」
  topPosts?: {
    id: string;
    title: string;
    likes: number;
    cover?: string;
    url?: string;
  }[]; // 该话题下最热内容样本
}

// Hashtag 排行
export interface HashtagStat {
  tag: string;
  platform: Platform;
  posts: number;
  views: number;
  growth: number;
}

// 爆款拆解结果（模块四，文档规定字段）
export interface ViralBreakdown {
  videoId: string;
  first3sHookSummary: string; // 前3秒钩子
  fullVideoStructure: string; // 完整视频内容结构
  hitReasonTags: string[]; // 爆款核心原因标签（固定集合）
  coreHitLogic: string; // 爆款核心逻辑
  reproducibleTopics: string[]; // 可复制选题
  score: number; // 综合爆款评分 0-100
}

// 高转化分析结果（模块五，文档规定字段）
export interface ConversionInsight {
  videoId: string;
  title: string;
  platform: Platform;
  engagementRate: number;
  productImplantMethod: string; // 产品植入方式
  conversionPath?: string; // 用户从看到内容到咨询/下单的转化路径
  potentialConversionLevel: "高" | "中" | "低"; // 潜在转化强度
  userConsultDemands: string[]; // 用户咨询诉求
  summary: string; // 引发/不引发咨询的核心原因
  score: number; // 转化潜力评分
}

// 视频评论（用于多模态分析的 Top N 评论样本）
export interface VideoComment {
  text: string;
  likes: number;
}

// 自身账号分析输入（模块六）
export interface OwnAccountInput {
  platform: Platform;
  uniqueId: string;
  name: string;
  followers: number;
  avgViews: number;
  topVideoIds: string[];
}

// 统一抓取请求
export interface FetchVideosRequest {
  platform: Platform;
  accountUrl: string; // 账号链接
  limit?: number;
}

// AI 任务名称（统一通过 runAiTask 分发到 MiniMax-M3）
export type AiTaskName =
  | "analyzeAccount"
  | "parseVideo"
  | "analyzeConversionVideo"
  | "breakdownViralVideo"
  | "analyzeOwnAccount"
  | "cleanTags"
  | "analyzeImage"
  | "inferImageSize";
  

export interface AppConfig {
  tikhubApiToken: string;
  tikhubBaseUrl: string;
  fetchVideoCount: number;
  // LLM（OpenAI 兼容，默认 MiniMax）：可在「设置」页修改，.env 提供默认值
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  llmFileUploadPath: string;
  sopApiKey: string;
  sopBaseUrl: string;
  sopModel: string;
  // 图片生成模型：兼容 Seedream、OpenAI Images API 与自定义兼容接口
  imageApiFormat: "seedream" | "openai" | "custom";
  imageBaseUrl: string;
  imageApiKey: string;
  imageGeneratePath: string;
  imageEditPath: string;
  imageModel: string;
  imageModels: ImageModelConfig[];
  /** 生图推断允许使用的最大分辨率档位（如 1k / 2k / 4k）。 */
  imageMaxResolution: string;
  imageBodyMode: "json" | "form";
  imageEditStyle: "auto" | "string" | "images";
  imageAdvancedParams: string;
  tokenConfigured: boolean; // 是否已配置 TiKhub 令牌（未配置时无数据，呈现空状态）
  minimaxConfigured: boolean; // 是否已配置 LLM（llmApiKey 非空）
  imageConfigured: boolean; // 是否已配置图片模型（imageApiKey 非空）
  // MySQL 云端缓存：热点 / 账号分析 / 爆款拆解 的结果缓存（配置后跨重启、跨设备共享）
  mysqlHost: string; // MySQL 服务器地址（留空 = 不启用云端缓存）
  mysqlPort: number; // MySQL 端口（默认 3306）
  mysqlUser: string; // MySQL 用户名
  mysqlPassword: string; // MySQL 密码
  mysqlDatabase: string; // MySQL 数据库名
  mysqlEnabled: boolean; // 派生：host + password + database 均非空
  // 腾讯云 COS：模板原图上传至 bucket 的 bt/tools/ 前缀；密钥只供主进程上传时使用。
  cosSecretId: string;
  cosSecretKey: string;
  cosBucket: string;
  cosRegion: string;
  cosCdnDomain: string;
  cosConfigured: boolean;
  // 缓存过期天数（0 = 禁用该类型的缓存逻辑）
  hotspotCacheDays: number; // 热点与 Tag 追踪结果缓存天数（默认 1，当天有效）
  accountCacheDays: number; // 竞对 / 自身账号分析结果缓存天数（默认 7）
  // yt-dlp 可执行文件路径（默认 'yt-dlp'，从系统 PATH 查找；用于在线链接 → 视频直链解析）
  ytdlpPath: string;
}

export interface ImageModelConfig {
  name: string;
  apiKey: string;
  resolution: string;
  description: string;
}

/**
 * 按平台判断是否已配置对应的数据接口密钥。
 * - Facebook 当前不支持业务数据分析。
 * - 其余平台走 TiKhub，看 tikhubApiToken。
 */
export function platformConfigured(
  config: AppConfig | null | undefined,
  platform: Platform,
): boolean {
  if (!config) return false;
  if (platform === "facebook") return false;
  return !!(config.tikhubApiToken ?? "").trim();
}
