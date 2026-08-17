// TikTok 数据提供者（基于 TiKhub 官方接口）
// 端点选择依据：https://www.tikhub.io/tiktok-api 官方推荐
//   - 视频/帖子：App V3 /api/v1/tiktok/app/v3/fetch_user_post_videos（最稳定，需 sec_user_id，unique_id 为备用）
//   - 用户资料：Web /api/v1/tiktok/web/fetch_user_profile（返回含 sec_uid，用于解析真实用户标识）
//   - 热点/趋势：Web /api/v1/tiktok/web/fetch_trending_post（返回热门视频，可派生热点与 hashtag）
// 注意：TiKhub 的 TikTok 接口返回 tikwm 风格 snake_case 字段，统一用 pick() 兼容
// snake_case 与 camelCase，避免解析不到导致数据为空。
import { TikHubClient, parseAccountUrl } from '../tikhub-client';
import { SocialProvider } from '../types';
import { AppConfig, Platform, SocialAccount, SocialVideo, TrendTopic, HashtagStat } from '../../shared/types';

// App V3 推荐（最稳定）；Web 作为回退
const POST_ENDPOINTS = [
  '/api/v1/tiktok/app/v3/fetch_user_post_videos',
  '/api/v1/tiktok/web/fetch_user_post',
];
const TRENDING_ENDPOINTS = [
  '/api/v1/tiktok/web/fetch_trending_post',
  '/api/v1/tiktok/web/fetch_trending_searchwords',
];

export class TikTokProvider implements SocialProvider {
  platform: Platform = 'tiktok';
  private client: TikHubClient;

  constructor(cfg: AppConfig) {
    this.client = new TikHubClient(cfg);
  }

  /** 解析账号链接，必要时先调 profile 拿到真正的 sec_user_id（部分视频接口需要它） */
  private async resolveIdentity(accountUrl: string): Promise<{ uniqueId?: string; secUid?: string }> {
    const { uniqueId, secUid } = parseAccountUrl('tiktok', accountUrl);
    if (secUid) return { uniqueId, secUid };
    if (!uniqueId) return { uniqueId, secUid };
    // 仅拿到 @username：先拉 profile 取 sec_uid（视频接口需要它）
    // App V3 优先（最稳定），Web 回退；两者参数均为 unique_id / sec_uid
    for (const ep of [
      '/api/v1/tiktok/app/v3/handler_user_profile',
      '/api/v1/tiktok/web/fetch_user_profile',
    ]) {
      try {
        const resp: any = await this.client.get(ep, { unique_id: uniqueId });
        const data = resp?.data ?? resp;
        const user = pick(data, 'user', 'author', 'userInfo') ?? data ?? {};
        const s = pick(user, 'sec_uid', 'secUid');
        const u = pick(user, 'unique_id', 'uniqueId');
        if (s || u) return { uniqueId: u ?? uniqueId, secUid: s ?? undefined };
      } catch {
        // 尝试下一个端点
      }
    }
    return { uniqueId, secUid: undefined };
  }

  async fetchAccount(accountUrl: string): Promise<SocialAccount> {
    const { uniqueId, secUid } = await this.resolveIdentity(accountUrl);
    const params: Record<string, string> = {};
    if (secUid) params.sec_user_id = secUid;
    if (uniqueId) params.unique_id = uniqueId;
    // App V3 优先，Web 回退
    let resp: any = null;
    let lastErr: unknown;
    for (const ep of [
      '/api/v1/tiktok/app/v3/handler_user_profile',
      '/api/v1/tiktok/web/fetch_user_profile',
    ]) {
      try {
        resp = await this.client.get(ep, params);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!resp) throw lastErr;
    const data = resp?.data ?? resp;
    // 兼容多种层级：data.user / data.author / data 直接是用户
    const user = pick(data, 'user', 'author', 'userInfo') ?? data ?? {};
    const stats = pick(user, 'stats') ?? pick(data, 'stats') ?? user ?? {};
    const name = pick(user, 'nickname', 'unique_id', 'uniqueId', 'name', 'username') ?? uniqueId ?? 'unknown';
    const uid = pick(user, 'unique_id', 'uniqueId') ?? uniqueId ?? name;
    return {
      id: `tiktok_${uid}`,
      platform: 'tiktok',
      uniqueId: uid,
      name,
      url: accountUrl,
      followers: Number(pick(stats, 'follower_count', 'followerCount', 'fans', 'fans_count') ?? 0),
      likesTotal: Number(pick(stats, 'heart_count', 'heartCount', 'digg_count', 'diggCount', 'like_count', 'likes')),
      videoCount: Number(pick(stats, 'video_count', 'videoCount', 'aweme_count', 'post_count')),
      category: 'traffic',
      categoryReason: '待分类',
      bio: pick(user, 'signature', 'bio', 'desc') ?? '',
    };
  }

  /**
   * 拉取账号全部视频（按游标翻页，直到 has_more=false 或达到上限）。
   * @param limit 安全上限（防止极端情况下无限翻页），默认 2000
   */
  async fetchVideos(accountUrl: string, limit = 2000): Promise<SocialVideo[]> {
    const { uniqueId, secUid } = await this.resolveIdentity(accountUrl);
    const baseParams: Record<string, string> = {
      count: '30',
      sort_type: '0', // 0=最新
    };
    if (secUid) baseParams.sec_user_id = secUid;
    if (uniqueId) baseParams.unique_id = uniqueId;

    let all: any[] = [];
    let lastErr: unknown;
    const MAX_PAGES = 100; // 2000/30 ≈ 67 页，留足余量
    for (const ep of POST_ENDPOINTS) {
      let cursor = 0;
      let hasMore = true;
      let pages = 0;
      while (hasMore && all.length < limit && pages < MAX_PAGES) {
        const params = { ...baseParams, max_cursor: String(cursor) };
        try {
          const r: any = await this.client.get(ep, params);
          const list = extractList(r, ['videos', 'aweme_list', 'itemList']);
          if (!list.length) { hasMore = false; break; }
          all.push(...list);
          const pg = extractPagination(r);
          hasMore = pg.hasMore;
          if (pg.cursor !== undefined) cursor = pg.cursor;
          else cursor += 30;
          pages += 1;
        } catch (e) {
          lastErr = e;
          hasMore = false;
        }
      }
      if (all.length) break; // 主端点拿到数据就停止回退
    }
    if (!all.length && lastErr) throw lastErr;
    // 保留「视频」与「图文/相册」帖，剔除纯音频/音乐类型（无画面、无可播放链接）。
    // 仍按游标全量翻页拉取，并按上限截断。
    return all
      .map((v: any) => normalizeTikTokVideo(v))
      .filter((v: SocialVideo) => v.mediaType !== 'audio' && v.mediaType !== 'music')
      .slice(0, limit);
  }

  // 模块三：热点追踪预设的中国旅游相关关键词（fetch_general_search_result 搜索源）
  private static readonly TREND_KEYWORDS = [
    'china travel', 'china tourism', 'visit china', 'china food', 'chinese culture',
    '张家界', '西安', '成都', 'china trip', 'travel china 2026',
  ];

  /** 模块三：基于 TikTok 真实「热门搜索词」接口的热点话题（替代旧的 trending_post / 关键词搜索聚合方案） */
  async fetchTrends(_accounts?: string[]): Promise<TrendTopic[]> {
    try {
      const resp: any = await this.client.get('/api/v1/tiktok/web/fetch_trending_searchwords', {});
      const words: any[] = resp?.data?.trending_search_words ?? [];
      if (!words.length) return [];
      // 按排名映射热度（排名越靠前越热），并标注热门类型（trendingSearchWordType==='2' 视为「上升/爆款」）
      return words.slice(0, 30).map((w: any, idx: number) => {
        const kw = String(w?.trendingSearchWord ?? '').trim();
        return {
          platform: 'tiktok' as Platform,
          keyword: kw,
          heat: Math.max(1, 100 - idx),
          growth: 0, // 增长率由 DataService 基于多时段快照计算（同平台前后对比）
          relatedTags: w?.trendingSearchWordType === '2' ? ['#trending'] : [],
        };
      });
    } catch {
      // 接口不可用（如 402 额度不足）时回退到关键词搜索聚合
      return this.fetchTrendsFromSearch();
    }
  }

  /** 兜底：当真实 trending 接口不可用时，用关键词搜索聚合出热点（仅 TikTok 自身关键词） */
  private async fetchTrendsFromSearch(): Promise<TrendTopic[]> {
    const out: TrendTopic[] = [];
    for (const kw of TikTokProvider.TREND_KEYWORDS) {
      try {
        const videos = await this.searchVideos(kw);
        if (!videos.length) continue;
        const totalViews = videos.reduce((s, v) => s + v.views, 0);
        const heat = Math.min(100, 30 + Math.round(totalViews / videos.length / 50000));
        const tagSet = new Set<string>();
        videos.forEach((v) => v.tags.slice(0, 3).forEach((t) => tagSet.add(t)));
        out.push({
          platform: 'tiktok' as Platform,
          keyword: kw,
          heat,
          growth: 0,
          relatedTags: Array.from(tagSet).slice(0, 5).map((t) => `#${t}`),
        });
      } catch {
        // 单个关键词失败不中断
      }
    }
    return out.sort((a, b) => b.heat - a.heat).slice(0, 20);
  }

  async fetchHashtags(_accounts?: string[]): Promise<HashtagStat[]> {
    const map = new Map<string, { posts: number; views: number }>();
    const bump = (name: string, views: number) => {
      if (!name) return;
      const key = name.replace(/^#/, '');
      const cur = map.get(key) ?? { posts: 0, views: 0 };
      cur.posts += 1;
      cur.views += views;
      map.set(key, cur);
    };
    for (const kw of TikTokProvider.TREND_KEYWORDS) {
      try {
        const videos = await this.searchVideos(kw);
        for (const v of videos) {
          v.tags.forEach((t) => bump(t, v.views));
        }
      } catch {
        // ignore
      }
    }
    return Array.from(map.entries())
      .map(([tag, st]) => ({
        tag: `#${tag}`,
        platform: 'tiktok' as Platform,
        posts: st.posts,
        views: st.views,
        growth: 0,
      }))
      .sort((a, b) => b.views - a.views || b.posts - a.posts)
      .slice(0, 10);
  }

  /** 模块二/四/五：单条视频详情（无水印直链 + 元数据） */
  async fetchOneVideo(videoId: string): Promise<SocialVideo | null> {
    const awemeId = videoId.replace(/^tiktok_/, '');
    try {
      const r: any = await this.client.get('/api/v1/tiktok/app/v3/fetch_one_video', { aweme_id: awemeId });
      const data = r?.data ?? r?.aweme_detail ?? r;
      if (!data || !data.aweme_id) return null;
      return normalizeTikTokVideo(data);
    } catch {
      return null;
    }
  }

  /** 模块四/五：单条视频评论（Top50，按点赞降序） */
  async fetchVideoComments(videoId: string): Promise<{ text: string; likes: number }[]> {
    const awemeId = videoId.replace(/^tiktok_/, '');
    try {
      const r: any = await this.client.get('/api/v1/tiktok/app/v3/fetch_video_comments', {
        aweme_id: awemeId,
        count: 50,
      });
      const list = extractList(r, ['comments', 'comment_list', 'data']) ?? [];
      return list
        .map((c: any) => ({
          text: String(pick(c, 'text', 'comment', 'content') ?? '').trim(),
          likes: Number(pick(c, 'digg_count', 'like_count', 'likes') ?? 0),
        }))
        .filter((c: { text: string }) => c.text)
        .sort((a: any, b: any) => b.likes - a.likes)
        .slice(0, 50);
    } catch {
      return [];
    }
  }

  /** 模块三：关键词搜索视频（fetch_general_search_result） */
  async searchVideos(keyword: string): Promise<SocialVideo[]> {
    let list: any[] = [];
    let lastErr: unknown;
    for (const ep of [
      '/api/v1/tiktok/app/v3/fetch_general_search_result',
      '/api/v1/tiktok/web/fetch_general_search_result',
    ]) {
      try {
        const r: any = await this.client.get(ep, { keyword, search_type: 0, count: 20 });
        const items = extractList(r, ['data', 'item_list', 'aweme_list', 'videos']);
        if (items.length) { list = items; break; }
      } catch (e) {
        lastErr = e;
      }
    }
    if (!list.length && lastErr) {
      // 不抛出，返回空（由调用方决定是否降级）
      return [];
    }
    return list.slice(0, 20).map((v: any) => normalizeTikTokVideo(v));
  }

  /** 模块三：Hashtag 详情（官方热度/播放） */
  async fetchHashtagDetail(keyword: string): Promise<HashtagStat | null> {
    try {
      const r: any = await this.client.get('/api/v1/tiktok/web/fetch_hashtag_detail', { keyword });
      const data = r?.data ?? r;
      const views = Number(pick(data, 'view_count', 'views', 'volume') ?? 0);
      const posts = Number(pick(data, 'post_count', 'posts', 'video_count') ?? 0);
      return { tag: `#${keyword.replace(/^#/, '')}`, platform: 'tiktok', posts, views, growth: 0 };
    } catch {
      return null;
    }
  }

  /** 取热门视频（兜底：仅当搜索全部失败时回退） */
  private async fetchTrendingVideos(): Promise<any[]> {
    let lastErr: unknown;
    for (const ep of TRENDING_ENDPOINTS) {
      try {
        const r: any = await this.client.get(ep, { region: 'US', count: '30' });
        const list = extractList(r, ['itemList', 'aweme_list', 'videos', 'items', 'words']);
        if (list.length) return list;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    return [];
  }
}

/** 从对象中按多个候选键取值（兼容 snake_case / camelCase 及不同命名习惯） */
function pick(obj: any, ...keys: string[]): any {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/**
 * 从响应中递归查找视频/列表数组。优先匹配已知键（videos/aweme_list/itemList…），
 * 找不到时再做一次递归搜索，确保不同层级的 data 包裹都能取到。
 */
function extractList(resp: any, keys: string[]): any[] {
  const search = (obj: any, depth: number): any[] | null => {
    if (!obj || typeof obj !== 'object' || depth > 4) return null;
    if (Array.isArray(obj) && obj.length && typeof obj[0] === 'object') return obj;
    // 优先已知键
    for (const k of keys) {
      const v = obj[k];
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
    }
    // 递归
    for (const k of Object.keys(obj)) {
      const r = search(obj[k], depth + 1);
      if (r) return r;
    }
    return null;
  };
  return search(resp, 0) ?? (resp?.data ? search(resp.data, 0) ?? [] : []) ?? [];
}

/**
 * 从响应中提取翻页游标：TiKhub 不同接口把 has_more / 下一页游标放在不同层级
 * （顶层 has_more + max_cursor，或 data.has_more + data.cursor 等）。递归查找后返回。
 */
function extractPagination(resp: any): { hasMore: boolean; cursor?: number } {
  let hasMore = false;
  let cursor: number | undefined;
  const scan = (obj: any, depth: number): void => {
    if (!obj || typeof obj !== 'object' || depth > 4) return;
    if (typeof obj.has_more === 'boolean') hasMore = hasMore || obj.has_more;
    if (typeof obj.hasMore === 'boolean') hasMore = hasMore || obj.hasMore;
    if (typeof obj.max_cursor === 'number') cursor = cursor ?? obj.max_cursor;
    if (typeof obj.cursor === 'number') cursor = cursor ?? obj.cursor;
    if (typeof obj.min_cursor === 'number' && cursor === undefined) cursor = obj.min_cursor;
    for (const k of Object.keys(obj)) scan(obj[k], depth + 1);
  };
  scan(resp, 0);
  return { hasMore, cursor };
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 时长：tikwm 返回毫秒（如 15000），个别字段返回秒（如 15），统一转成秒 */
function toSec(v: any): number {
  const n = num(v);
  if (n <= 0) return 15;
  return n > 1000 ? Math.round(n / 1000) : Math.round(n);
}

function firstWord(text: string): string {
  const m = (text || '').trim().split(/\s+/)[0];
  return m ? m.slice(0, 20) : '';
}

function normalizeTikTokVideo(v: any): SocialVideo {
  // 搜索结果里视频被包在 aweme_info 中，先解包
  const raw = v?.aweme_info && typeof v.aweme_info === 'object' ? v.aweme_info : v;
  const aid = pick(raw, 'aweme_id', 'itemId', 'id', 'item_id') ?? `tk_${Math.random()}`;
  const stats = pick(raw, 'stats', 'statistics') ?? {};
  const desc: string = pick(raw, 'desc', 'caption', 'title') ?? '';
  const author = pick(raw, 'author', 'authorInfo') ?? {};
  const music = pick(raw, 'music') ?? {};
  const video = pick(raw, 'video') ?? {};
  const createTime = num(pick(raw, 'create_time', 'createTime', 'timestamp'));
  // 区分视频与「图文/相册」帖子：TikTok 图文帖带 image_post_info、且无可播放的 play_addr；
  // aweme_type=2 也为图文。这类帖子不是视频，抓取时应剔除。
  const isImagePost = !!raw.image_post_info || raw.aweme_type === 2;
  const hasPlayable = !!pick(video, 'play_addr', 'download_addr', 'bit_rate');
  // 媒体类型细分：
  //  - image_post_info / aweme_type=2 → 图文帖（保留）
  //  - 有可播放地址 → 视频（保留）
  //  - 既无画面也无视频（纯音乐/音频笔记）→ audio（剔除，不入库）
  let mediaType: 'video' | 'image' | 'audio' | 'music';
  if (isImagePost) mediaType = 'image';
  else if (hasPlayable) mediaType = 'video';
  else mediaType = 'music';
  const isVideo = mediaType === 'video';
  // 图文帖的封面/图片地址（用于预览与后续图片理解）
  const imageUrl = !isVideo
    ? pick(pick(raw, 'image_post_info') ?? {}, 'images')?.[0]?.url_list?.[0]
      ?? pick(pick(raw, 'image_post_info') ?? {}, 'cover')?.[0]?.url_list?.[0]
      ?? undefined
    : undefined;
  return {
    id: `tiktok_${aid}`,
    platform: 'tiktok',
    authorId: pick(author, 'unique_id', 'uniqueId', 'id', 'uid') ?? 'unknown',
    authorName: pick(author, 'nickname', 'unique_id', 'uniqueId', 'name') ?? 'unknown',
    url: `https://www.tiktok.com/@${pick(author, 'unique_id', 'uniqueId') ?? 'user'}/video/${aid}`,
    publishTime: createTime > 0 ? new Date(createTime * 1000).toISOString() : new Date().toISOString(),
    title: desc.slice(0, 40),
    caption: desc,
    hook: desc.slice(0, 60),
    views: num(pick(stats, 'play_count', 'playCount', 'views', 'plays')),
    likes: num(pick(stats, 'digg_count', 'diggCount', 'likes')),
    comments: num(pick(stats, 'comment_count', 'commentCount', 'comments')),
    shares: num(pick(stats, 'share_count', 'shareCount', 'shares')),
    favorites: num(pick(stats, 'collect_count', 'collectCount', 'favorites', 'saveCount', 'saved_count')),
    durationSec: toSec(pick(video, 'duration') ?? pick(raw, 'duration')),
    structure: '',
    source: pick(music, 'title') ? `BGM: ${pick(music, 'title')}` : '',
    bgm: pick(music, 'title') ?? '',
    tags: extractTags(desc),
    isVideo,
    mediaType,
    mediaUrl: isVideo
      ? pick(pick(video, 'play_addr') ?? {}, 'url_list', 'urlList')?.[0]
        ?? pick(pick(video, 'download_addr') ?? {}, 'url_list', 'urlList')?.[0]
        ?? undefined
      : imageUrl,
  };
}

function extractTags(text: string): string[] {
  const m = text.match(/#[\p{L}\p{N}_]+/gu);
  return m ? m.map((t) => t.slice(1)) : [];
}
