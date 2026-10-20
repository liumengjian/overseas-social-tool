// YouTube (含 Shorts) 数据提供者（基于 TiKhub YouTube Web V2 API）
// 已实测可用的真实接口（2026-08）：
//   - 搜索：  /api/v1/youtube/web_v2/get_general_search_v2  (keyword, type=video)
//   - 频道视频：/api/v1/youtube/web_v2/get_channel_videos   (channel_id)
//   - 视频详情：/api/v1/youtube/web_v2/get_video_info        (video_id)
// 注意：TiKhub 的 YouTube 接口【没有】trending / top_hashtags / 频道资料(profile) 接口，
// 因此「热点 / Hashtag 排行」由搜索结果聚合派生；账号资料由频道视频结果回退推导。
// 切勿调用不存在的 /api/v1/youtube/web/fetch_trending 等接口（实测 404）。
import { TikHubClient, parseAccountUrl } from '../tikhub-client';
import { SocialProvider } from '../types';
import { AppConfig, Platform, SocialAccount, SocialVideo, TrendTopic, HashtagStat } from '../../shared/types';

export class YouTubeProvider implements SocialProvider {
  platform: Platform = 'youtube';
  private client: TikHubClient;

  constructor(cfg: AppConfig) {
    this.client = new TikHubClient(cfg);
  }


  async fetchAccount(accountUrl: string): Promise<SocialAccount> {
    const channelId = extractChannelId(accountUrl);
    if (!channelId) {
      throw new Error('TiKhub 未提供 YouTube 频道解析接口，请使用含 /channel/ 的频道链接（如 https://www.youtube.com/channel/UCxxxx）。');
    }
    const resp: any = await this.client.get('/api/v1/youtube/web_v2/get_channel_videos', {
      channel_id: channelId,
      type: 'video',
    });
    const data = resp?.data ?? resp ?? {};
    const channel = data?.channel ?? {};
    const name = channel?.name ?? channel?.title ?? channelId;
    return {
      id: `youtube_${channelId}`,
      platform: 'youtube',
      uniqueId: channelId,
      name,
      url: accountUrl,
      followers: Number(channel?.subscriber_count ?? channel?.subscribers ?? 0),
      likesTotal: Number(channel?.video_count ?? 0),
      videoCount: Number(channel?.video_count ?? 0),
      category: 'traffic',
      categoryReason: '待分类',
      bio: channel?.description ?? '',
    };
  }

  async fetchVideos(accountUrl: string, limit: number): Promise<SocialVideo[]> {
    const channelId = extractChannelId(accountUrl);
    if (!channelId) {
      throw new Error('TiKhub 未提供 YouTube 频道解析接口，请使用含 /channel/ 的频道链接（如 https://www.youtube.com/channel/UCxxxx）。');
    }
    const resp: any = await this.client.get('/api/v1/youtube/web_v2/get_channel_videos', {
      channel_id: channelId,
      type: 'video',
      count: '50', // 显式指定每页数量，覆盖 TiKhub 默认的 10 条
    });
    const items = resp?.data?.videos ?? resp?.videos ?? [];
    return (Array.isArray(items) ? items : []).slice(0, limit).map((v: any) => normalizeYtVideo(v));
  }

  /** 关键词搜索视频（真实接口 get_general_search_v2） */
  async searchVideos(keyword: string): Promise<SocialVideo[]> {
    try {
      const resp: any = await this.client.get('/api/v1/youtube/web_v2/get_general_search_v2', {
        keyword,
        type: 'video',
      });
      const items = resp?.data?.videos ?? resp?.data?.items ?? resp?.videos ?? resp?.items ?? [];
      return (Array.isArray(items) ? items : []).slice(0, 20).map((v: any) => normalizeYtVideo(v));
    } catch {
      return [];
    }
  }

  /** YouTube 暂无独立热点接口；热点词条仅在用户输入关键词后查询。 */
  async fetchTrends(_keyword?: string): Promise<TrendTopic[]> { return []; }

  /** 模块三：从搜索结果标题/描述中抽取 #hashtag 聚合排行（YouTube 无原生 hashtag 接口） */
  async fetchHashtags(keyword?: string): Promise<HashtagStat[]> {
    const kw = keyword?.trim();
    if (!kw) return [];
    const resp: any = await this.client.get('/api/v1/youtube/web_v2/get_search_suggestions', { keyword: kw });
    return digYtSuggestions(resp).slice(0, 30).map((suggestion) => ({
      tag: suggestion.text,
      platform: 'youtube' as Platform,
      posts: 0,
      // 接口不返回单个建议词的浏览量时保持为 0，不用排序伪造热度。
      views: suggestion.heat,
      growth: 0,
    }));
  }

  async fetchOneVideo(videoId: string): Promise<SocialVideo | null> {
    try {
      const resp: any = await this.client.get('/api/v1/youtube/web_v2/get_video_info', { video_id: videoId });
      const data = resp?.data ?? resp;
      if (!data || !data.video_id) return null;
      return normalizeYtVideo(data);
    } catch {
      return null;
    }
  }

  async fetchVideoComments(videoId: string): Promise<{ text: string; likes: number }[]> { return []; }
  async fetchHashtagDetail(keyword: string): Promise<HashtagStat | null> { return null; }
}

/** 解析 YouTube 链接中的频道 ID 或 @handle */
function extractChannelId(url: string): string | null {
  const ch = url.match(/youtube\.com\/channel\/([^\/\?\&]+)/);
  if (ch) return ch[1];
  const h = url.match(/youtube\.com\/@([^\/\?\&]+)/);
  if (h) return decodeURIComponent(h[1]);
  return null;
}

/** 解析形如 "97,593 views" / "1.2M" 的计数 */
function parseCount(v: any): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const raw = v.replace(/,/g, '');
    const m = raw.match(/[\d.]+/);
    if (!m) return 0;
    let n = parseFloat(m[0]);
    if (/k/i.test(v)) n *= 1e3;
    else if (/m/i.test(v)) n *= 1e6;
    else if (/b/i.test(v)) n *= 1e9;
    return Math.round(n);
  }
  return 0;
}

function parseDuration(d: string): number {
  const parts = String(d || '0:15').split(':').map(Number).reverse();
  return (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600;
}

function extractTags(text: string): string[] {
  const m = text.match(/#[\p{L}\p{N}_]+/gu);
  return m ? m.map((t) => t.slice(1)) : [];
}

function digYtSuggestions(resp: any): { text: string; heat: number }[] {
  const root = resp?.data ?? resp;
  const list = findYtArray(root) ?? [];
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list.map((item: any) => {
    const text = String(typeof item === 'string' ? item : item?.keyword ?? item?.query ?? item?.text ?? item?.title ?? item?.suggestion ?? '').trim();
    const heat = Number(item?.heat ?? item?.hot_score ?? item?.score ?? item?.view_count ?? item?.views ?? 0);
    return { text, heat };
  }).filter((item) => item.text && !seen.has(item.text) && (seen.add(item.text), true));
}

function findYtArray(value: any, depth = 0): any[] | null {
  if (!value || depth > 6) return null;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return null;
  for (const key of ['suggestions', 'items', 'results', 'data']) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findYtArray(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizeYtVideo(v: any): SocialVideo {
  const id = v?.video_id ?? v?.id ?? `yt_${Math.random()}`;
  const title: string = v?.title ?? '';
  const desc: string = v?.description ?? v?.description_snippet ?? '';
  const text = `${title} ${desc}`;
  return {
    id: `youtube_${id}`,
    platform: 'youtube',
    authorId: v?.channel_id ?? 'unknown',
    authorName: v?.author ?? v?.channel_title ?? 'unknown',
    url: v?.url ?? `https://www.youtube.com/watch?v=${id}`,
    publishTime: new Date().toISOString(),
    title,
    caption: desc,
    hook: '',
    views: parseCount(v?.view_count ?? v?.short_view_count),
    likes: parseCount(v?.like_count),
    comments: parseCount(v?.comment_count),
    shares: 0,
    favorites: 0,
    durationSec: parseDuration(v?.duration),
    structure: '',
    source: '',
    bgm: '',
    tags: extractTags(text),
    isVideo: true,
    mediaType: 'video',
    mediaUrl: v?.playback_url ?? undefined,
  };
}
