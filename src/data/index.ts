// 数据服务：编排各平台 Provider，并负责本地持久化。
// 设计原则：无令牌 / 请求失败时返回空容器（真正的空状态），不填充任何示例/演示数据。
import { TikHubClient } from './tikhub-client';
import { SocialProvider } from './types';
import { TikTokProvider } from './providers/tiktok';
import { InstagramProvider } from './providers/instagram';
import { YouTubeProvider } from './providers/youtube';
import { FacebookProvider } from './providers/facebook';
import { TwitterProvider } from './providers/twitter';
import { readJson, writeJson } from './store';
import {
  AppConfig,
  HashtagStat,
  Platform,
  SocialAccount,
  SocialVideo,
  TrendTopic,
  VideoComment,
} from '../shared/types';

export class DataService {
  config: AppConfig;
  private providers: Record<Platform, SocialProvider>;

  constructor(config: AppConfig) {
    this.config = config;
    this.providers = {
      tiktok: new TikTokProvider(config),
      instagram: new InstagramProvider(config),
      youtube: new YouTubeProvider(config),
      facebook: new FacebookProvider(config),
      twitter: new TwitterProvider(config),
    };
  }

  get tokenConfigured(): boolean {
    return !!this.config.tikhubApiToken && this.config.tikhubApiToken.trim().length > 0;
  }

  // ---- 账号 ----
  async fetchAccount(platform: Platform, accountUrl: string): Promise<SocialAccount> {
    if (!this.tokenConfigured) {
      throw new Error('未配置 TiKhub 令牌（.env 的 TIKHUB_API_TOKEN），无法拉取账号数据。');
    }
    return this.providers[platform].fetchAccount(accountUrl);
  }

  // ---- 视频列表 ----
  async fetchVideos(platform: Platform, accountUrl: string, limit: number): Promise<SocialVideo[]> {
    if (!this.tokenConfigured) return [];
    const videos = await this.providers[platform].fetchVideos(accountUrl, limit);
    this.saveVideos(videos);
    // 返回合并后的本地库（含历史抓取数据），避免覆盖以前拉取的视频
    return this.getVideoDb();
  }

  // ---- 单条视频详情（元数据 + 无水印直链 + 评论）----
  async fetchVideoDetail(platform: Platform, videoId: string): Promise<{ video: SocialVideo | null; mediaUrl?: string; comments: VideoComment[] }> {
    if (!this.tokenConfigured) return { video: null, comments: [] };
    const provider = this.providers[platform];
    const [video, comments] = await Promise.all([
      provider.fetchOneVideo(videoId),
      provider.fetchVideoComments(videoId),
    ]);
    // 若 provider 不支持详情（非 TikTok），尝试从视频库取已有记录
    let base = video;
    if (!base) {
      base = this.getVideoDb().find((v) => v.id === videoId) ?? null;
    }
    return { video: base, mediaUrl: base?.mediaUrl, comments };
  }

  // ---- 趋势 + Hashtag 合并拉取（一次 IPC / 一个工作流）----
  async fetchTrendData(platform: Platform, accounts?: string[]): Promise<{ trends: TrendTopic[]; hashtags: HashtagStat[] }> {
    if (!this.tokenConfigured) return { trends: [], hashtags: [] };
    try {
      const provider = this.providers[platform];
      // 顺序调用同一平台的两个方法，确保工作流只涉及当前平台，不会误显示其它平台接口
      const trends = await provider.fetchTrends(accounts);
      const hashtags = await provider.fetchHashtags(accounts);
      return { trends: this.attachGrowth(platform, trends), hashtags };
    } catch (e) {
      console.warn('[DataService] fetchTrendData 失败:', (e as Error).message);
      return { trends: [], hashtags: [] };
    }
  }

  // ---- 趋势（基于多时段快照计算增长率）----
  async fetchTrends(platform: Platform, accounts?: string[]): Promise<TrendTopic[]> {
    if (!this.tokenConfigured) return [];
    try {
      const trends = await this.providers[platform].fetchTrends(accounts);
      return this.attachGrowth(platform, trends);
    } catch (e) {
      console.warn('[DataService] fetchTrends 失败:', (e as Error).message);
      return [];
    }
  }

  // ---- Hashtag 排行 ----
  async fetchHashtags(platform: Platform, accounts?: string[]): Promise<HashtagStat[]> {
    if (!this.tokenConfigured) return [];
    try {
      return await this.providers[platform].fetchHashtags(accounts);
    } catch (e) {
      console.warn('[DataService] fetchHashtags 失败:', (e as Error).message);
      return [];
    }
  }

  // ---- 关键词搜索（模块三辅助 / 跨平台兜底）----
  async searchVideos(platform: Platform, keyword: string): Promise<SocialVideo[]> {
    if (!this.tokenConfigured) return [];
    try {
      return await this.providers[platform].searchVideos(keyword);
    } catch (e) {
      console.warn('[DataService] searchVideos 失败:', (e as Error).message);
      return [];
    }
  }

  /**
   * 计算增长率：与「同平台最近一次快照」的同关键词热度做差；
   * 首次出现则 growth=0 并标记 isNew=true。
   * 注意：必须按「同平台」比较，否则切换平台后上一快照是别的平台 → prevMap 为空 → 永远 growth=0（这是此前「上升话题恒为空」的根因）。
   */
  private attachGrowth(platform: Platform, trends: TrendTopic[]): TrendTopic[] {
    const now = Date.now();
    const snapshots = this.getTrendSnapshots();
    // 从后往前找「包含本平台数据」的最近快照
    const prevMap = new Map<string, number>();
    for (let i = snapshots.length - 1; i >= 0; i--) {
      const entries = snapshots[i].data.filter((t) => t.platform === platform);
      if (entries.length) {
        entries.forEach((t) => prevMap.set(t.keyword, t.heat));
        break;
      }
    }

    const newData = trends.map((t) => ({ platform: t.platform, keyword: t.keyword, heat: t.heat }));
    snapshots.push({ ts: now, data: newData });
    // 仅保留最近 30 个快照
    while (snapshots.length > 30) snapshots.shift();
    writeJson('trend_snapshots', snapshots);

    return trends.map((t) => {
      const had = prevMap.has(t.keyword);
      return {
        ...t,
        growth: had ? t.heat - (prevMap.get(t.keyword) ?? 0) : 0,
        isNew: !had,
        snapshotTime: now,
      };
    });
  }

  private getTrendSnapshots(): { ts: number; data: { platform: Platform; keyword: string; heat: number }[] }[] {
    return readJson('trend_snapshots', []);
  }

  // ---- 视频库持久化 ----
  private saveVideos(videos: SocialVideo[]): void {
    this.mergeVideos(videos);
  }

  /** 合并写入：以 id 去重，已存在则覆盖同字段（用于抓取/导入时与历史数据累加，不覆盖） */
  mergeVideos(videos: SocialVideo[]): void {
    const db = this.getVideoDb();
    const map = new Map(db.map((v) => [v.id, v]));
    videos.forEach((v) => {
      const prev = map.get(v.id);
      map.set(v.id, prev ? { ...prev, ...v, id: v.id } : v);
    });
    writeJson('video_db', Array.from(map.values()));
  }

  /** 导入 CSV/外部数据（按 id 合并到本地库） */
  importVideos(videos: SocialVideo[]): { imported: number } {
    this.mergeVideos(videos);
    return { imported: videos.length };
  }

  /** 更新单条视频的媒体地址（如把 TiKhub 临时直链替换为 MiniMax mm_file:// 引用） */
  updateVideoMediaUrl(id: string, mediaUrl: string): void {
    const db = this.getVideoDb();
    const map = new Map(db.map((v) => [v.id, v]));
    const cur = map.get(id);
    if (cur) {
      cur.mediaUrl = mediaUrl;
      writeJson('video_db', Array.from(map.values()));
    }
  }

  getVideoDb(): SocialVideo[] {
    return readJson<SocialVideo[]>('video_db', []);
  }
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv): AppConfig {
  const token = env.TIKHUB_API_TOKEN ?? '';
  const llmKey = env.MINIMAX_API_KEY ?? '';
  return {
    tikhubApiToken: token,
    tikhubBaseUrl: env.TIKHUB_BASE_URL ?? 'https://api.tikhub.io',
    fetchVideoCount: Number(env.FETCH_VIDEO_COUNT ?? 30),
    llmApiKey: llmKey,
    llmBaseUrl: env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/v1',
    llmModel: env.MINIMAX_MODEL ?? 'MiniMax-M3',
    tokenConfigured: token.trim().length > 0,
    minimaxConfigured: llmKey.trim().length > 0,
  };
}

// 设置页可覆盖的字段（不含派生布尔）。持久化时只存这些，保证 .env 始终是默认值来源。
const EDITABLE_CONFIG_KEYS = [
  'tikhubApiToken',
  'tikhubBaseUrl',
  'fetchVideoCount',
  'llmApiKey',
  'llmBaseUrl',
  'llmModel',
] as const;

function pickEditable(cfg: Partial<AppConfig>): Partial<AppConfig> {
  const out: Partial<AppConfig> = {};
  for (const k of EDITABLE_CONFIG_KEYS) {
    if (cfg[k] !== undefined) out[k] = cfg[k] as never;
  }
  return out;
}

/** 有效配置 = .env 默认值 ∪ 用户保存的覆盖值（用户值优先）。 */
export function loadEffectiveConfig(): AppConfig {
  const envCfg = loadConfigFromEnv(process.env);
  const saved = readJson<Partial<AppConfig>>('app-config', {});
  const merged = { ...envCfg, ...pickEditable(saved) };
  merged.tokenConfigured = (merged.tikhubApiToken ?? '').trim().length > 0;
  merged.minimaxConfigured = (merged.llmApiKey ?? '').trim().length > 0;
  return merged;
}

/** 保存用户配置（仅覆盖可编辑字段），返回合并后的有效配置。 */
export function saveUserConfig(cfg: AppConfig): AppConfig {
  writeJson('app-config', pickEditable(cfg));
  return loadEffectiveConfig();
}

/** 清除用户覆盖项，回到 .env 默认配置。 */
export function resetUserConfig(): AppConfig {
  writeJson('app-config', {});
  return loadEffectiveConfig();
}

// 暴露 TiKhubClient 以便调试
export { TikHubClient };
