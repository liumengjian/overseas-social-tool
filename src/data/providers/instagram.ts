// Instagram 数据提供者（基于 TiKhub Instagram V2 API）
// 已实测可用的真实接口（2026-08）：
//   - 用户资料：/api/v1/instagram/v2/fetch_user_info   (username)
//   - Reels：   /api/v1/instagram/v2/fetch_user_reels  (username)
// 重要：TiKhub 的 Instagram 接口【没有】搜索 / hashtag / 热门 接口（fetch_general_search、
// fetch_hashtag_* 等均 404）。因此「热点 / Hashtag 排行」改为：聚合一组「参考账号」的 Reels，
// 从其 caption 的 hashtags 与互动数据派生（即「几个接口结合」的替代方案）。
// 切勿调用不存在的 /api/v1/instagram/web/fetch_trending 等接口。
import { TikHubClient, parseAccountUrl } from '../tikhub-client';
import { SocialProvider } from '../types';
import { AppConfig, Platform, SocialAccount, SocialVideo, TrendTopic, HashtagStat } from '../../shared/types';

export class InstagramProvider implements SocialProvider {
  platform: Platform = 'instagram';
  private client: TikHubClient;

  constructor(cfg: AppConfig) {
    this.client = new TikHubClient(cfg);
  }

  /**
   * 热点 / Tag 追踪的「参考账号」列表：TiKhub 无 Instagram 搜索/热门接口，
   * 故以这些账号的 Reels 作为热点样本聚合（已实测这些账号有较多带 hashtag 的 Reels）。
   * 可在热点与 Tag 追踪页面中实时修改为你的目标竞品 / 行业账号（逗号分隔）。
   */
  static readonly DEFAULT_ACCOUNTS = [
    'gotochinanow',
    'natgeotravel',
    'beautifuldestinations',
    'china.travel',
  ];
  private static readonly REFERENCE_ACCOUNTS = InstagramProvider.DEFAULT_ACCOUNTS;

  async fetchAccount(accountUrl: string): Promise<SocialAccount> {
    const { uniqueId } = parseAccountUrl('instagram', accountUrl);
    const resp: any = await this.client.get('/api/v1/instagram/v2/fetch_user_info', { username: uniqueId ?? '' });
    const data = resp?.data ?? resp;
    const user = data?.user ?? data;
    const name = user?.username ?? uniqueId ?? 'unknown';
    return {
      id: `instagram_${name}`,
      platform: 'instagram',
      uniqueId: name,
      name: user?.full_name ?? name,
      url: accountUrl,
      followers: Number(user?.follower_count ?? user?.edge_followed_by?.count ?? 0),
      likesTotal: Number(user?.media_count ?? 0),
      videoCount: Number(user?.media_count ?? 0),
      category: 'traffic',
      categoryReason: '待分类',
      bio: user?.biography ?? '',
    };
  }

  async fetchVideos(accountUrl: string, limit: number): Promise<SocialVideo[]> {
    const { uniqueId } = parseAccountUrl('instagram', accountUrl);
    const reels = await this.fetchUserReels(uniqueId ?? '');
    return reels.slice(0, limit).map((v: any) => normalizeIgReel(v, uniqueId));
  }

  /** 解析「参考账号」列表：传入则优先，否则用默认 REFERENCE_ACCOUNTS */
  private resolveAccounts(accounts?: string[]): string[] {
    const cleaned = (accounts ?? []).map((a) => a.trim()).filter(Boolean);
    return cleaned.length ? cleaned : InstagramProvider.REFERENCE_ACCOUNTS;
  }

  /** 聚合参考账号的 Reels（核心数据源） */
  private async fetchReferenceReels(accounts?: string[]): Promise<any[]> {
    const all: any[] = [];
    for (const acc of this.resolveAccounts(accounts)) {
      try {
        const reels = await this.fetchUserReels(acc);
        all.push(...reels);
      } catch {
        // 单个账号失败不中断
      }
    }
    return all;
  }

  private async fetchUserReels(username: string): Promise<any[]> {
    const resp: any = await this.client.get('/api/v1/instagram/v2/fetch_user_reels', { username, count: '50' });
    // 响应结构：resp.data.data.items
    const inner = resp?.data?.data ?? resp?.data ?? {};
    const items = inner?.items ?? inner ?? [];
    return Array.isArray(items) ? items : [];
  }

  /** 无原生搜索接口：扫描参考账号 Reels，按 caption 关键词过滤 */
  async searchVideos(keyword: string, accounts?: string[]): Promise<SocialVideo[]> {
    const reels = await this.fetchReferenceReels(accounts);
    const kw = keyword.trim().toLowerCase();
    return reels
      .filter((r: any) => {
        const text = `${r?.caption?.text ?? ''}`.toLowerCase();
        return !kw || text.includes(kw);
      })
      .slice(0, 20)
      .map((v: any) => normalizeIgReel(v));
  }

  /** 模块三：以参考账号 Reels 的 hashtag 频率派生热点话题（替代不存在的 trending 接口） */
  async fetchTrends(accounts?: string[]): Promise<TrendTopic[]> {
    const reels = await this.fetchReferenceReels(accounts);
    const freq = new Map<string, { count: number; engagement: number }>();
    for (const r of reels) {
      const tags = extractIgHashtags(r);
      const eng = Number(r?.like_count ?? 0) + Number(r?.comment_count ?? 0);
      for (const t of tags) {
        const cur = freq.get(t) ?? { count: 0, engagement: 0 };
        cur.count += 1;
        cur.engagement += eng;
        freq.set(t, cur);
      }
    }
    return Array.from(freq.entries())
      .map(([tag, st]) => ({
        platform: 'instagram' as Platform,
        keyword: `#${tag}`,
        heat: Math.min(100, 20 + st.count * 10 + Math.round(st.engagement / 1000)),
        growth: 0,
        relatedTags: [],
      }))
      .sort((a, b) => b.heat - a.heat)
      .slice(0, 20);
  }

  /** 模块三：聚合参考账号 Reels 的 hashtag 排行 */
  async fetchHashtags(accounts?: string[]): Promise<HashtagStat[]> {
    const reels = await this.fetchReferenceReels(accounts);
    const map = new Map<string, { posts: number; views: number }>();
    for (const r of reels) {
      const eng = Number(r?.like_count ?? 0) + Number(r?.comment_count ?? 0);
      for (const t of extractIgHashtags(r)) {
        const cur = map.get(t) ?? { posts: 0, views: 0 };
        cur.posts += 1;
        cur.views += eng;
        map.set(t, cur);
      }
    }
    return Array.from(map.entries())
      .map(([tag, st]) => ({
        tag: `#${tag}`,
        platform: 'instagram' as Platform,
        posts: st.posts,
        views: st.views,
        growth: 0,
      }))
      .sort((a, b) => b.views - a.views || b.posts - a.posts)
      .slice(0, 10);
  }

  async fetchOneVideo(videoId: string): Promise<SocialVideo | null> { return null; }
  async fetchVideoComments(videoId: string): Promise<{ text: string; likes: number }[]> { return []; }
  async fetchHashtagDetail(keyword: string): Promise<HashtagStat | null> { return null; }
}

/** 从 Instagram Reels 条目中抽取 hashtag（caption.hashtags 经常为空，故同时用正则从 caption.text 提取） */
function extractIgHashtags(v: any): string[] {
  const raw = v?.caption?.hashtags ?? [];
  const fromField = (Array.isArray(raw) ? raw : [])
    .map((h: any) => (typeof h === 'string' ? h : (h?.name ?? h?.hashtag ?? '')))
    .map((t: string) => t.replace(/^#/, '').trim())
    .filter(Boolean);
  const text = v?.caption?.text ?? '';
  const fromText = extractTags(text);
  return Array.from(new Set([...fromField, ...fromText]));
}

function extractTags(text: string): string[] {
  const m = text.match(/#[\p{L}\p{N}_]+/gu);
  return m ? m.map((t) => t.slice(1)) : [];
}

function normalizeIgReel(v: any, owner?: string): SocialVideo {
  const cap: string = v?.caption?.text ?? '';
  const hashtags = extractIgHashtags(v);
  const id = v?.id ?? v?.code ?? `ig_${Math.random()}`;
  const taken = typeof v?.taken_at_ts === 'number' ? v.taken_at_ts : undefined;
  const author = v?.user?.username ?? owner ?? 'unknown';
  const text = `${cap}`;
  return {
    id: `instagram_${id}`,
    platform: 'instagram',
    authorId: author,
    authorName: author,
    url: `https://www.instagram.com/reel/${id}`,
    publishTime: taken ? new Date(Number(taken) * 1000).toISOString() : new Date().toISOString(),
    title: cap.slice(0, 40),
    caption: cap,
    hook: cap.slice(0, 60),
    views: Number(v?.view_count ?? v?.play_count ?? 0),
    likes: Number(v?.like_count ?? 0),
    comments: Number(v?.comment_count ?? 0),
    shares: Number(v?.share_count ?? 0),
    favorites: 0,
    durationSec: Number(v?.video_duration ?? v?.duration ?? 15),
    structure: '',
    source: '',
    bgm: '',
    tags: [...hashtags, ...extractTags(text)],
    isVideo: true,
    mediaType: 'video',
    mediaUrl: v?.video_url ?? v?.thumbnail_url ?? undefined,
  };
}
