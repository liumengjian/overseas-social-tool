// 平台枚举
export type Platform = 'tiktok' | 'instagram' | 'youtube' | 'facebook' | 'twitter';

// 账号分类
export type AccountCategory = 'conversion' | 'traffic';

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
  likes: number;
  comments: number;
  shares: number;
  favorites: number;
  durationSec: number;
  structure: string; // 视频结构描述
  source: string; // 素材来源
  tags: string[];
  bgm: string;
  mediaUrl?: string; // 可直链播放的视频/图片地址（真实抓取时填充，供大模型做理解）
  isVideo?: boolean; // 是否为视频类型（false 表示图文/相册类帖子）
  // 媒体类型细分：video=视频, image=图文/相册帖, audio=纯音频, music=音乐类型。
  // 抓取时保留 video 与 image，剔除 audio / music（纯音频/音乐文件不入库）。
  mediaType?: 'video' | 'image' | 'audio' | 'music';
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
  potentialConversionLevel: '高' | '中' | '低'; // 潜在转化强度
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
  | 'analyzeAccount'
  | 'parseVideo'
  | 'analyzeConversionVideo'
  | 'breakdownViralVideo'
  | 'analyzeOwnAccount'
  | 'cleanTags';

export interface AppConfig {
  tikhubApiToken: string;
  tikhubBaseUrl: string;
  fetchVideoCount: number;
  // LLM（OpenAI 兼容，默认 MiniMax）：可在「设置」页修改，.env 提供默认值
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  tokenConfigured: boolean; // 是否已配置 TiKhub 令牌（未配置时无数据，呈现空状态）
  minimaxConfigured: boolean; // 是否已配置 LLM（llmApiKey 非空）
}
