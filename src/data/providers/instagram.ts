// Instagram 数据提供者（账号数据基于 V2 API，热点推荐流基于 V3 API，单条帖子用 V1 API）
// 已实测可用的真实接口（2026-08）：
//   - 用户资料：/api/v1/instagram/v2/fetch_user_info   (username)
//   - Reels：   /api/v1/instagram/v2/fetch_user_reels  (username)
//   - 热点 / Hashtag：/api/v1/instagram/v3/get_recommended_reels + get_explore
//   - 单条帖子（链接直连拆解）：/api/v1/instagram/v1/fetch_post_by_url (post_url)
//                           /api/v1/instagram/v1/fetch_post_by_id   (post_id)
//                           /api/v1/instagram/v1/shortcode_to_media_id (shortcode，兜底)
// 热点 / Hashtag 排行使用两个平台推荐流合并后在本地聚合，避免用关键词搜索制造“假热点”。
import { TikHubClient, parseAccountUrl } from '../tikhub-client';
import { SocialProvider } from '../types';
import { DiscoveredTopic, fmtCount, isGenericTag } from '../trend-utils';
import { AppConfig, Platform, SocialAccount, SocialVideo, TrendTopic, HashtagStat } from '../../shared/types';

export class InstagramProvider implements SocialProvider {
  platform: Platform = 'instagram';
  private client: TikHubClient;

  constructor(cfg: AppConfig) {
    this.client = new TikHubClient(cfg);
  }

  clearTrendCache(): void {
    this.lastKeyword = undefined;
    this.lastTopics = undefined;
  }

  /** 推荐流热点不需要关键词；保留常量兼容已有调用方。 */
  static readonly DEFAULT_TREND_KEYWORD = '';

  async fetchAccount(accountUrl: string): Promise<SocialAccount> {
    const { uniqueId } = parseAccountUrl('instagram', accountUrl);
    const resp: any = await this.client.get('/api/v1/instagram/v2/fetch_user_info', { username: uniqueId ?? '' });
    // 稳健定位 user 对象：TiKhub 返回结构多层不一（resp.data.user / resp.data.data.user 等），
    // 用深度查找定位含 username/full_name 的对象，避免字段映射失败导致 bio/粉丝为空 → 模型幻觉。
    const user = findIgUser(resp?.data ?? resp) ?? resp?.data?.user ?? resp?.user ?? (resp?.data ?? resp);
    const name = user?.username ?? user?.full_name ?? uniqueId ?? 'unknown';
    const followers = Number(user?.follower_count ?? user?.edge_followed_by?.count ?? 0);
    const mediaCount = Number(user?.media_count ?? user?.edge_owner_to_timeline_media?.count ?? 0);
    return {
      id: `instagram_${name}`,
      platform: 'instagram',
      uniqueId: name,
      name: user?.full_name ?? name,
      url: accountUrl,
      followers,
      likesTotal: 0, // IG V2 用户接口不直接提供总赞数，留空（0）而非误用 media_count
      videoCount: mediaCount,
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

  private async fetchUserReels(username: string): Promise<any[]> {
    const resp: any = await this.client.get('/api/v1/instagram/v2/fetch_user_reels', { username, count: '50' });
    // 响应结构：resp.data.data.items
    const inner = resp?.data?.data ?? resp?.data ?? {};
    const items = inner?.items ?? inner ?? [];
    return Array.isArray(items) ? items : [];
  }

  /** 关键词搜索帖子（供其它功能使用，热点模块不再调用） */
  async searchVideos(keyword: string): Promise<SocialVideo[]> {
    const kw = (keyword ?? '').trim();
    if (!kw) return [];
    try {
      const r: any = await this.client.get('/api/v1/instagram/v2/general_search', { keyword: kw, search_type: 'posts', count: 20 });
      return digIgList(r).slice(0, 20).map((v: any) => normalizeIgReel(v));
    } catch {
      return [];
    }
  }

  /** 模块三：热点话题（推荐流合并 → 本地标签聚合） */
  async fetchTrends(_keyword?: string): Promise<TrendTopic[]> { return []; }

  /** 模块三：Hashtag 排行（复用 fetchTrends 已发现的同一批话题，映射为 posts/views；按官方帖子数/浏览量降序，与「上升热点话题」的热度排序区分开） */
  async fetchHashtags(keyword?: string): Promise<HashtagStat[]> {
    const kw = keyword?.trim();
    if (!kw) return [];
    // Instagram V3 接口参数名为 query；传 keyword 会被接口校验为 422。
    const resp: any = await this.client.get('/api/v1/instagram/v3/search_hashtags', { query: kw });
    return digIgHashtagList(resp).slice(0, 30).map((item) => ({
      tag: `#${item.name}`, platform: 'instagram' as Platform,
      posts: item.postCount, views: item.postCount, growth: 0,
    }));
  }

  // 短时共享缓存：fetchTrendData 会先调 fetchTrends 再调 fetchHashtags，用同一批推荐流结果
  private lastKeyword?: string;
  private lastTopics?: DiscoveredTopic[];

  /** 同一次调用周期内 fetchTrends / fetchHashtags 共享两个推荐流结果 */
  private async discoverShared(keyword?: string): Promise<DiscoveredTopic[]> {
    const key = 'recommended-reels+explore';
    if (this.lastKeyword === key && this.lastTopics) return this.lastTopics;
    const topics = await this.discoverHashtags();
    this.lastKeyword = key;
    this.lastTopics = topics;
    return topics;
  }

  /** 两个推荐流各调用一次，合并去重后完成热点与 Tag 聚合。 */
  private async discoverHashtags(): Promise<DiscoveredTopic[]> {
    const [recommended, explore] = await Promise.all([
      this.fetchDiscoveryFeed('/api/v1/instagram/v3/get_recommended_reels'),
      this.fetchDiscoveryFeed('/api/v1/instagram/v3/get_explore'),
    ]);
    const posts = dedupeIgPosts([...recommended, ...explore]);
    if (!posts.length) return [];
    // Step 2：提取 caption hashtag 频次统计（纯应用层）
    const freq = new Map<string, { count: number; engagement: number; samples: any[] }>();
    for (const p of posts) {
      const post = unwrapIgPost(p);
      const likes = Number(post?.like_count ?? post?.likes_count ?? post?.edge_liked_by?.count ?? 0);
      for (const t of extractIgHashtags(p)) {
        const name = t.replace(/^#/, '');
        if (!name || isGenericTag(name)) continue;
        const st = freq.get(name) ?? { count: 0, engagement: 0, samples: [] };
        st.count += 1;
        st.engagement += likes + Number(post?.comment_count ?? post?.comments_count ?? 0) + Number(post?.share_count ?? post?.shares_count ?? 0);
        if (st.samples.length < 5) st.samples.push(p);
        freq.set(name, st);
      }
    }
    // Step 3：热度验证（官方帖子数仅作热度描述与「浏览量」口径；热度值本身走样本频次+互动，
    // 使「上升热点话题」（按热度）与「Hashtag 排行」（按官方帖子数）两个模块排序不同，避免展示内容雷同）
    return Array.from(freq.entries())
      .sort((a, b) => b[1].count - a[1].count || b[1].engagement - a[1].engagement)
      .map(([tag, st]) => {
        const heat = Math.min(100, 20 + st.count * 12 + Math.round(st.engagement / 300));
        const heatDesc = `候选频次 ${st.count} 次 / 样本赞 ${st.engagement}`;
        return {
          tag,
          count: st.count,
          engagement: st.engagement,
          views: st.engagement,
          heat,
          heatDesc,
          relatedTags: igCoOccurrence(st.samples, tag).slice(0, 5),
          topPosts: igTopPosts(st.samples),
        };
      });
  }

  /** 获取一个推荐流；单个接口失败不影响另一个推荐流继续产出数据。 */
  private async fetchDiscoveryFeed(path: string): Promise<any[]> {
    try {
      const resp: any = await this.client.get(path, {});
      return digIgList(resp);
    } catch {
      return [];
    }
  }

  /**
   * 模块四「用链接直接拆解」入口：按 shortcode 拉取单条帖子详情。
   * 调用链（TiKhub Instagram V1 接口，已确认存在）：
   *   1) 先 fetch_post_by_url（用 shortcode 拼出标准 reel 链接，最稳，单请求）；
   *   2) 失败再 shortcode_to_media_id → fetch_post_by_id（media_id 直查）兜底。
   * 任一成功即返回标准化 SocialVideo（含可直链 mediaUrl，供 MiniMax 多模态分析），
   * 解决此前「fetchOneVideo 恒返回 null → 无视频内容可供分析」的根因。
   */
  async fetchOneVideo(videoId: string): Promise<SocialVideo | null> {
    const shortcode = (videoId ?? '').trim();
    if (!shortcode) return null;
    try {
      const byUrl = await this.fetchPostByUrl(`https://www.instagram.com/reel/${shortcode}/`);
      if (byUrl) return byUrl;
    } catch {
      /* 按 URL 获取失败，进入 shortcode → media_id 兜底链 */
    }
    try {
      const mediaId = await this.shortcodeToMediaId(shortcode);
      if (mediaId) {
        const byId = await this.fetchPostById(mediaId);
        if (byId) return byId;
      }
    } catch {
      /* 兜底链失败，返回 null */
    }
    return null;
  }

  async fetchVideoComments(videoId: string): Promise<{ text: string; likes: number }[]> { return []; }
  async fetchHashtagDetail(keyword: string): Promise<HashtagStat | null> { return null; }

  /** V1：按帖子 URL 获取单条帖子（post_url 参数） */
  private async fetchPostByUrl(postUrl: string): Promise<SocialVideo | null> {
    const resp: any = await this.client.get('/api/v1/instagram/v1/fetch_post_by_url', { post_url: postUrl });
    const post = resp?.data?.data ?? resp?.data ?? null;
    return post ? normalizeIgPost(post) : null;
  }

  /** V1：shortcode → media_id（用于 fetch_post_by_id 兜底） */
  private async shortcodeToMediaId(shortcode: string): Promise<string | null> {
    const resp: any = await this.client.get('/api/v1/instagram/v1/shortcode_to_media_id', { shortcode });
    const data = resp?.data?.data ?? resp?.data ?? null;
    const id = data?.media_id ?? data?.id ?? null;
    return id ? String(id) : null;
  }

  /** V1：按 media_id 获取单条帖子（post_id 参数） */
  private async fetchPostById(postId: string): Promise<SocialVideo | null> {
    const resp: any = await this.client.get('/api/v1/instagram/v1/fetch_post_by_id', { post_id: postId });
    const post = resp?.data?.data ?? resp?.data ?? null;
    return post ? normalizeIgPost(post) : null;
  }
}

/** 从 Instagram Reels 条目中抽取 hashtag（caption.hashtags 经常为空，故同时用正则从 caption.text 提取） */
function extractIgHashtags(v: any): string[] {
  v = unwrapIgPost(v);
  const raw = v?.caption?.hashtags ?? v?.caption_hashtags ?? v?.hashtags ?? [];
  const fromField = (Array.isArray(raw) ? raw : [])
    .map((h: any) => (typeof h === 'string' ? h : (h?.name ?? h?.hashtag ?? '')))
    .map((t: string) => t.replace(/^#/, '').trim())
    .filter(Boolean);
  const text = typeof v?.caption === 'string' ? v.caption : (v?.caption?.text ?? v?.caption_text ?? v?.description ?? '');
  const fromText = extractTags(text);
  return Array.from(new Set([...fromField, ...fromText]));
}

/** 解析 search_hashtags 响应：data.items 为候选话题列表（名称 + 官方帖子数） */
function digIgHashtagList(resp: any): { name: string; postCount: number }[] {
  const items = resp?.data?.items ?? resp?.data?.data?.items ?? resp?.data?.hashtags ?? [];
  if (!Array.isArray(items)) return [];
  return items
    .map((h: any) => ({
      name: String(h?.name ?? h?.hashtag ?? h?.tag_name ?? '').replace(/^#/, '').trim(),
      postCount: Number(h?.media_count ?? h?.post_count ?? h?.mediaCount ?? h?.count ?? 0),
    }))
    .filter((h: { name: string }) => h.name);
}

/** 兼容 TiKhub Instagram 列表类响应的多种包裹：data.items / data.data.items / 直接数组 */
function digIgList(resp: any): any[] {
  const inner = resp?.data?.data ?? resp?.data ?? resp;
  const items = inner?.items
    ?? inner?.posts
    ?? inner?.reels
    ?? inner?.media
    ?? inner?.feed_items
    ?? (Array.isArray(inner?.edges) ? inner.edges.map((edge: any) => edge?.node ?? edge).filter(Boolean) : null)
    ?? inner?.data?.items
    ?? inner?.data?.posts
    ?? (Array.isArray(inner) ? inner : []);
  if (Array.isArray(items)) return items;
  return findIgObjectArray(inner, 0) ?? [];
}

function findIgObjectArray(value: any, depth: number): any[] | null {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  if (Array.isArray(value)) {
    return value.length && value.every((item) => item && typeof item === 'object') ? value : null;
  }
  for (const key of Object.keys(value)) {
    const found = findIgObjectArray(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function dedupeIgPosts(posts: any[]): any[] {
  const seen = new Set<string>();
  return posts.filter((post) => {
    const key = String(post?.id ?? post?.pk ?? post?.media_id ?? post?.code ?? post?.shortcode ?? '');
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 200);
}

/** 帖子 caption 的共现标签统计（除自身外的 Top 5，含 # 前缀） */
function igCoOccurrence(posts: any[], self: string): string[] {
  const freq = new Map<string, number>();
  for (const p of posts) {
    const tags = extractIgHashtags(p)
      .map((t) => t.replace(/^#/, ''))
      .filter((name) => name && name.toLowerCase() !== self.toLowerCase() && !isGenericTag(name));
    for (const t of new Set(tags)) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => `#${t}`);
}

/** 把帖子列表映射为该话题的「最热内容样本」（按赞降序 Top 3） */
function igTopPosts(posts: any[]): { id: string; title: string; likes: number; cover?: string; url?: string }[] {
  return posts
    .map((p) => {
      p = unwrapIgPost(p);
      const id = String(p?.id ?? p?.code ?? '');
      return {
        id,
        title: igCaption(p).slice(0, 30),
        likes: Number(p?.like_count ?? p?.likes_count ?? p?.edge_liked_by?.count ?? 0),
        cover: p?.thumbnail_url ?? p?.display_url ?? p?.image_url ?? undefined,
        url: p?.code ? `https://www.instagram.com/reel/${p.code}` : undefined,
      };
    })
    .filter((p) => p.id)
    .sort((a, b) => b.likes - a.likes)
    .slice(0, 3);
}

function unwrapIgPost(value: any): any {
  if (!value || typeof value !== 'object') return value ?? {};
  let current = value;
  for (let i = 0; i < 5; i++) {
    const next = current?.media ?? current?.node ?? current?.item ?? current?.post;
    if (!next || next === current || typeof next !== 'object') break;
    current = next;
  }
  return current;
}

function igCaption(value: any): string {
  const v = unwrapIgPost(value);
  return typeof v?.caption === 'string'
    ? v.caption
    : String(v?.caption?.text ?? v?.caption_text ?? v?.description ?? v?.title ?? '');
}

/**
 * 深度查找 TiKhub Instagram 响应里的「用户对象」：
 * 部分接口把用户包在 resp.data.user，部分在 resp.data.data.user，结构不一致。
 * 以「含 username / full_name 字段」为锚点定位，避免解析不到导致 bio / 粉丝量缺失（进而模型幻觉）。
 */
function findIgUser(obj: any, depth = 0): any {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
  if ((obj.username || obj.full_name) && typeof obj === 'object') return obj;
  for (const k of Object.keys(obj)) {
    const r = findIgUser(obj[k], depth + 1);
    if (r) return r;
  }
  return undefined;
}

function extractTags(text: string): string[] {
  const m = text.match(/#[\p{L}\p{N}_]+/gu);
  return m ? m.map((t) => t.slice(1)) : [];
}

function normalizeIgReel(v: any, owner?: string): SocialVideo {
  v = unwrapIgPost(v);
  const cap: string = igCaption(v);
  const hashtags = extractIgHashtags(v);
  const id = v?.id ?? v?.code ?? `ig_${Math.random()}`;
  const taken = typeof v?.taken_at_ts === 'number' ? v.taken_at_ts : undefined;
  const author = v?.user?.username ?? v?.owner?.username ?? owner ?? 'unknown';
  const text = `${cap}`;
  return {
    id: `instagram_${id}`,
    platform: 'instagram',
    authorId: author,
    authorName: author,
    url: `https://www.instagram.com/reel/${id}`,
    publishTime: taken ? new Date(Number(taken) * 1000).toISOString() : new Date().toISOString(),
    title: cap,
    caption: cap,
    hook: '',
    views: Number(v?.view_count ?? v?.play_count ?? 0),
    likes: Number(v?.like_count ?? v?.likes_count ?? v?.edge_liked_by?.count ?? 0),
    comments: Number(v?.comment_count ?? v?.comments_count ?? v?.edge_media_to_comment?.count ?? 0),
    shares: Number(v?.share_count ?? v?.shares_count ?? 0),
    favorites: 0,
    durationSec: Number(v?.video_duration ?? v?.duration ?? 15),
    structure: '',
    source: '',
    bgm: '',
    tags: [...hashtags, ...extractTags(text)],
    isVideo: true,
    mediaType: 'video',
    mediaUrl: v?.video_url ?? v?.media_url ?? v?.thumbnail_url ?? v?.display_url ?? undefined,
  };
}

/**
 * 把 TiKhub Instagram V1 单条帖子响应标准化为 SocialVideo。
 * V1 帖子字段命名与 V2 Reels 不完全一致（view_count / video_view_count / taken_at / edge_* 等），
 * 用多重别名兜底，避免映射失败导致播放量/发布时间为空。
 */
function normalizeIgPost(v: any): SocialVideo {
  const cap: string = v?.caption?.text ?? (typeof v?.caption === 'string' ? v.caption : '');
  const hashtags = extractIgHashtags(v);
  const id = v?.id ?? v?.code ?? v?.shortcode ?? `ig_${Math.random()}`;
  const takenRaw = v?.taken_at_ts ?? v?.taken_at ?? v?.created_at;
  const takenTs = typeof takenRaw === 'number'
    ? takenRaw
    : (typeof takenRaw === 'string' ? Date.parse(takenRaw) / 1000 : undefined);
  const author = v?.user?.username ?? v?.owner?.username ?? 'unknown';
  const text = `${cap}`;
  return {
    id: `instagram_${id}`,
    platform: 'instagram',
    authorId: author,
    authorName: author,
    url: `https://www.instagram.com/reel/${id}`,
    publishTime: takenTs ? new Date(Number(takenTs) * 1000).toISOString() : new Date().toISOString(),
    title: cap,
    caption: cap,
    hook: '',
    views: Number(v?.view_count ?? v?.play_count ?? v?.video_view_count ?? 0),
    likes: Number(v?.like_count ?? v?.edge_liked_by?.count ?? 0),
    comments: Number(v?.comment_count ?? v?.edge_media_to_comment?.count ?? 0),
    shares: Number(v?.share_count ?? 0),
    favorites: 0,
    durationSec: Number(v?.video_duration ?? v?.duration ?? 15),
    structure: '',
    source: '',
    bgm: '',
    tags: [...hashtags, ...extractTags(text)],
    isVideo: true,
    mediaType: 'video',
    mediaUrl: v?.video_url ?? v?.media_url ?? v?.thumbnail_url ?? undefined,
  };
}
