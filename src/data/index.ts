// 数据服务：编排各平台 Provider，并负责本地持久化。
// 设计原则：无令牌 / 请求失败时返回空容器（真正的空状态），不填充任何示例/演示数据。
import { TikHubClient } from './tikhub-client';
import { SocialProvider } from './types';
import { TikTokProvider } from './providers/tiktok';
import { InstagramProvider } from './providers/instagram';
import { YouTubeProvider } from './providers/youtube';
import { XiaohongshuProvider } from './providers/xiaohongshu';
import { WechatChannelsProvider } from './providers/wechat_channels';
import { UnsupportedFacebookProvider } from './providers/unsupported';
import { readJson, writeJson, mediaDir } from './store';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
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
      facebook: new UnsupportedFacebookProvider(),
      xiaohongshu: new XiaohongshuProvider(config),
      wechat_channels: new WechatChannelsProvider(config),
    };
  }

  get tokenConfigured(): boolean {
    return !!this.config.tikhubApiToken && this.config.tikhubApiToken.trim().length > 0;
  }

  /** 按平台判断是否已配置数据接口密钥（Facebook 当前不支持，其余走 TiKhub）。 */
  isPlatformConfigured(platform: Platform): boolean {
    if (platform === 'facebook') return false;
    return this.tokenConfigured;
  }

  // ---- 账号 ----
  async fetchAccount(platform: Platform, accountUrl: string): Promise<SocialAccount> {
    if (!this.isPlatformConfigured(platform)) {
      throw new Error(
        platform === 'facebook'
          ? '暂不支持 Facebook 平台的数据抓取与业务分析。'
          : '未配置 TiKhub 令牌（.env 的 TIKHUB_API_TOKEN），无法拉取账号数据。',
      );
    }
    return this.providers[platform].fetchAccount(accountUrl);
  }

  // ---- 视频列表 ----
  async fetchVideos(platform: Platform, accountUrl: string, limit: number): Promise<SocialVideo[]> {
    if (!this.isPlatformConfigured(platform)) return [];
    const videos = await this.providers[platform].fetchVideos(accountUrl, limit);
    this.saveVideos(videos);
    // 返回合并后的本地库（含历史抓取数据），避免覆盖以前拉取的视频
    return this.getVideoDb();
  }

  /** 账号分析专用：仅返回本次从该账号拉取的作品，避免历史视频库串入统计。 */
  async fetchAccountVideos(platform: Platform, accountUrl: string, limit: number): Promise<SocialVideo[]> {
    if (!this.isPlatformConfigured(platform)) return [];
    const videos = await this.providers[platform].fetchVideos(accountUrl, limit);
    this.saveVideos(videos);
    return videos;
  }

  // ---- 单条视频详情（元数据 + 无水印直链 + 评论）----
  async fetchVideoDetail(platform: Platform, videoId: string, sourceUrl?: string): Promise<{ video: SocialVideo | null; mediaUrl?: string; comments: VideoComment[] }> {
    if (!this.isPlatformConfigured(platform)) return { video: null, comments: [] };
    const provider = this.providers[platform];
    const detailKey = sourceUrl && platform === 'xiaohongshu' ? sourceUrl : videoId;
    const video = await provider.fetchOneVideo(detailKey);
    // 小红书链接详情会把 share_text 标准化成 xiaohongshu_<note_id>；
    // 评论必须使用该 note_id，不能把原始分享 URL 直接传给 comments 接口。
    const comments = await provider.fetchVideoComments(video?.id || videoId);
    // 若 provider 不支持详情（非 TikTok），尝试从视频库取已有记录
    let base = video;
    if (!base) {
      base = this.getVideoDb().find((v) => v.id === videoId || (sourceUrl && v.url === sourceUrl)) ?? null;
    }
    return { video: base, mediaUrl: base?.mediaUrl, comments };
  }

  // ---- 趋势 + Hashtag 合并拉取（一次 IPC / 一个工作流）----
  async fetchTrendData(platform: Platform, keyword?: string, bypassCache = false): Promise<{ trends: TrendTopic[]; hashtags: HashtagStat[] }> {
    if (!this.isPlatformConfigured(platform)) return { trends: [], hashtags: [] };
    const provider = this.providers[platform];
    if (bypassCache) provider.clearTrendCache?.();
    // 顺序调用让 Instagram / 小红书的短时发现缓存可复用；两个结果彼此独立，
    // 一个聚合分支失败时保留另一个结果，避免某平台显示成整体空白。
    let trends: TrendTopic[] = [];
    let hashtags: HashtagStat[] = [];
    try {
      trends = await provider.fetchTrends(keyword);
    } catch (e) {
      console.warn('[DataService] fetchTrends 失败:', String(e));
    }
    try {
      hashtags = await provider.fetchHashtags(keyword);
    } catch (e) {
      console.warn('[DataService] fetchHashtags 失败:', String(e));
    }
    return { trends: this.attachGrowth(platform, trends), hashtags };
  }

  // ---- 趋势（基于多时段快照计算增长率）----
  async fetchTrends(platform: Platform, keyword?: string): Promise<TrendTopic[]> {
    if (!this.isPlatformConfigured(platform)) return [];
    try {
      const trends = await this.providers[platform].fetchTrends(keyword);
      return this.attachGrowth(platform, trends);
    } catch (e) {
      return [];
    }
  }

  // ---- Hashtag 排行 ----
  async fetchHashtags(platform: Platform, keyword?: string): Promise<HashtagStat[]> {
    if (!this.isPlatformConfigured(platform)) return [];
    try {
      return await this.providers[platform].fetchHashtags(keyword);
    } catch (e) {
      return [];
    }
  }

  // ---- 关键词搜索（模块三辅助 / 跨平台兜底）----
  async searchVideos(platform: Platform, keyword: string): Promise<SocialVideo[]> {
    if (!this.isPlatformConfigured(platform)) return [];
    try {
      return await this.providers[platform].searchVideos(keyword);
    } catch (e) {
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

  /** 持久化 AI 解析得到的真实视频 Hook，供视频库长期展示。 */
  updateVideoHook(id: string, hook: string): void {
    const db = this.getVideoDb();
    const map = new Map(db.map((v) => [v.id, v]));
    const cur = map.get(id);
    if (cur) {
      cur.hook = hook;
      writeJson('video_db', Array.from(map.values()));
    }
  }

  /** 写入本地落盘地址（localmedia:// 协议地址），用于「全部替换为本地路径」后播放/预览（不影响 mediaUrl 的远程分析链接） */
  setVideoLocalMediaUrl(id: string, localMediaUrl: string): void {
    const db = this.getVideoDb();
    const map = new Map(db.map((v) => [v.id, v]));
    const cur = map.get(id);
    if (cur) {
      cur.localMediaUrl = localMediaUrl;
      writeJson('video_db', Array.from(map.values()));
    }
  }

  /** 写入 ffmpeg 脱敏重新编码后的本地文件地址（localmedia:// 协议，位于 encoded 目录）；不替换原始链接 */
  setVideoEncodedMediaUrl(id: string, localEncodedMediaUrl: string): void {
    const db = this.getVideoDb();
    const map = new Map(db.map((v) => [v.id, v]));
    const cur = map.get(id);
    if (cur) {
      cur.localEncodedMediaUrl = localEncodedMediaUrl;
      writeJson('video_db', Array.from(map.values()));
    }
  }

  getVideoDb(): SocialVideo[] {
    this.migrateLegacyHooks();
    return readJson<SocialVideo[]>('video_db', []);
  }

  /** 旧版本把文案片段误写入 hook；首次升级时清空，之后只接受 AI 解析结果。 */
  private migrateLegacyHooks(): void {
    if (readJson<boolean>('video_hook_ai_v1', false)) return;
    const db = readJson<SocialVideo[]>('video_db', []);
    if (db.some((v) => v.hook)) {
      writeJson('video_db', db.map((v) => ({ ...v, hook: '' })));
    }
    writeJson('video_hook_ai_v1', true);
  }

  /** 删除视频库中的视频（支持批量传入 id 数组）；若该视频为本地落盘（localmedia://），同时删除本地文件，避免残留 */
  deleteVideos(ids: string[]): { removed: number; localDeleted: number } {
    if (!ids.length) return { removed: 0, localDeleted: 0 };
    const idSet = new Set(ids);
    const db = this.getVideoDb();
    let localDeleted = 0;
    const remaining = db.filter((v) => {
      if (!idSet.has(v.id)) return true;
      // 本地落盘的视频：尝试删除本地文件（原始落盘 + 脱敏编码后另存的编码文件）
      for (const ref of [v.localMediaUrl, v.localEncodedMediaUrl]) {
        const name = ref?.startsWith('localmedia://')
          ? decodeURIComponent(ref.slice('localmedia://'.length))
          : null;
        if (name) {
          try {
            const fp = join(mediaDir(), name);
            if (existsSync(fp)) { unlinkSync(fp); localDeleted++; }
          } catch { /* 忽略个别文件删除失败 */ }
        }
      }
      return false;
    });
    const removed = db.length - remaining.length;
    if (removed > 0) writeJson('video_db', remaining);
    return { removed, localDeleted };
  }
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv): AppConfig {
  const token = env.TIKHUB_API_TOKEN ?? '';
  const llmKey = env.VIDEO_API_KEY ?? '';
  const llmBaseUrl = env.VIDEO_BASE_URL ?? 'https://api.new.bi/v1';
  const llmModel = env.VIDEO_MODEL ?? 'gemini-3.1-pro-preview';
  const imageModels = [
    { name: 'gpt-image-2-1k', apiKey: 'sk-3i6qAAtSyDLZ48qlDULWVUvDCWSpS8tBpLTehnIIc9fPnkC3', resolution: '1k', description: '0.03/次' },
    { name: 'gpt-image-2-d', apiKey: 'sk-oLS9NhGMcE8i16Tg9jk9EaKHXKVHSHHvYhqxpdFGv12u3MAz', resolution: '2k', description: '0.07/次' },
    { name: 'gpt-image-2-c', apiKey: 'sk-po7x9RRzbBAAXfuMYjtl79xAYKl8pNO94KUxon3K4E5NDzP9', resolution: '4k', description: '0.15/次' },
  ];
  return {
    tikhubApiToken: token,
    tikhubBaseUrl: env.TIKHUB_BASE_URL ?? 'https://api.tikhub.io',
    fetchVideoCount: Number(env.FETCH_VIDEO_COUNT ?? 50),
    llmApiKey: llmKey,
    llmBaseUrl,
    llmModel,
    llmFileUploadPath: env.LLM_FILE_UPLOAD_PATH ?? '/files/upload',
    sopApiKey: env.SOP_API_KEY ?? '',
    sopBaseUrl: env.SOP_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3',
    sopModel: env.SOP_MODEL ?? 'doubao-seed-2-0-lite-260215',
    imageApiFormat: (env.IMAGE_API_FORMAT ?? 'openai') as AppConfig['imageApiFormat'],
    imageBaseUrl: env.IMAGE_BASE_URL ?? 'https://api.new.bi/v1',
    imageApiKey: env.IMAGE_API_KEY ?? '',
    imageGeneratePath: env.IMAGE_GENERATE_PATH ?? '/images/generations',
    imageEditPath: env.IMAGE_EDIT_PATH ?? '/images/edits',
    imageModel: env.IMAGE_MODEL ?? 'gpt-image-2-1k',
    imageModels,
    imageMaxResolution: env.IMAGE_MAX_RESOLUTION ?? '1k',
    imageBodyMode: (env.IMAGE_BODY_MODE ?? 'json') as AppConfig['imageBodyMode'],
    imageEditStyle: (env.IMAGE_EDIT_STYLE ?? 'auto') as AppConfig['imageEditStyle'],
    imageAdvancedParams: env.IMAGE_ADVANCED_PARAMS ?? '',
    tokenConfigured: token.trim().length > 0,
    minimaxConfigured: llmKey.trim().length > 0,
    imageConfigured: (env.IMAGE_API_KEY ?? '').trim().length > 0,
    mysqlHost: env.MYSQL_HOST ?? '',
    mysqlPort: Number(env.MYSQL_PORT ?? 3306) || 3306,
    mysqlUser: env.MYSQL_USER ?? '',
    mysqlPassword: env.MYSQL_PASSWORD ?? '',
    mysqlDatabase: env.MYSQL_DATABASE ?? '',
    cosSecretId: env.COS_SECRET_ID ?? '',
    cosSecretKey: env.COS_SECRET_KEY ?? '',
    cosBucket: env.COS_BUCKET ?? '',
    cosRegion: env.COS_REGION ?? '',
    cosCdnDomain: env.COS_CDN_DOMAIN ?? '',
    cosConfigured: !!((env.COS_SECRET_ID ?? '').trim() && (env.COS_SECRET_KEY ?? '').trim() && (env.COS_BUCKET ?? '').trim() && (env.COS_REGION ?? '').trim()),
    hotspotCacheDays: Number(env.HOTSPOT_CACHE_DAYS ?? 1),
    accountCacheDays: Number(env.ACCOUNT_CACHE_DAYS ?? 7),
    ytdlpPath: env.YTDLP_PATH ?? 'yt-dlp',
    mysqlEnabled: !!((env.MYSQL_HOST ?? '').trim() && (env.MYSQL_PASSWORD ?? '').trim() && (env.MYSQL_DATABASE ?? '').trim()),
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
  'llmFileUploadPath',
  'sopApiKey',
  'sopBaseUrl',
  'sopModel',
  'imageApiFormat',
  'imageBaseUrl',
  'imageApiKey',
  'imageGeneratePath',
  'imageEditPath',
  'imageModel',
  'imageModels',
  'imageMaxResolution',
  'imageBodyMode',
  'imageEditStyle',
  'imageAdvancedParams',
  'mysqlHost',
  'mysqlPort',
  'mysqlUser',
  'mysqlPassword',
  'mysqlDatabase',
  'cosSecretId',
  'cosSecretKey',
  'cosBucket',
  'cosRegion',
  'cosCdnDomain',
  'hotspotCacheDays',
  'accountCacheDays',
  'ytdlpPath',
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
  merged.imageConfigured = (merged.imageApiKey ?? '').trim().length > 0;
  merged.mysqlEnabled = !!((merged.mysqlHost ?? '').trim() && (merged.mysqlPassword ?? '').trim() && (merged.mysqlDatabase ?? '').trim());
  merged.cosConfigured = !!((merged.cosSecretId ?? '').trim() && (merged.cosSecretKey ?? '').trim() && (merged.cosBucket ?? '').trim() && (merged.cosRegion ?? '').trim());
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
