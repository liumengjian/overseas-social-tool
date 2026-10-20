// 微信视频号（WeChat Channels）数据提供者（基于 TiKhub WeChat Channels V2 接口）。
// 文档：https://tikhub.io/zh/wechat-api
// 已选用端点（V2，2026-06-13 后旧 /api/v1/wechat_channels/* 与 /api/v1/wechat_mp/web/* 已停用）：
//   - 视频号ID转finder用户名：/api/v1/wechat_channels/v2/fetch_channel_id_to_username (POST, channel_id)
//   - 用户主页与统计：       /api/v1/wechat_channels/v2/fetch_user_profile          (POST username)
//   - 用户作品列表：         /api/v1/wechat_channels/v2/fetch_user_videos          (POST username, last_buffer 分页)
//   - 视频详情（解析下载）：   /api/v1/wechat_channels/v2/fetch_video_detail          (POST object_id | share_url, raw=false)
//   - 视频评论：             /api/v1/wechat_channels/v2/fetch_video_comments        (POST object_id, raw=false)
// 热点搜索使用 wechat_search/v2/fetch_search_videos（keyword + sort=hot），
// 再从返回视频的标题与 hashtag 聚合趋势和 Tag 排行。
// 注意：fetch_user_profile / fetch_video_detail 的响应字段命名以多重别名兜底；若与真实返回不符请微调映射。
import { TikHubClient } from '../tikhub-client';
import { SocialProvider } from '../types';
import { AppConfig, Platform, SocialAccount, SocialVideo, TrendTopic, HashtagStat } from '../../shared/types';

export class WechatChannelsProvider implements SocialProvider {
  platform: Platform = 'wechat_channels';
  private client: TikHubClient;

  constructor(cfg: AppConfig) {
    this.client = new TikHubClient(cfg);
  }

  /** 从视频号链接 / 用户名解析出 finder username（v2_...@finder） */
  private async resolveUsername(acc: string): Promise<string> {
    const s = acc.trim();
    if (/v2_.*@finder/i.test(s)) return s; // 已是 finder username
    const channelId = extractChannelId(s) || (!/^https?:\/\//i.test(s) ? s : null);
    if (channelId) {
      const resp: any = await this.client.post('/api/v1/wechat_channels/v2/fetch_channel_id_to_username', { channel_id: channelId, raw: false });
      const username = pickStr(resp?.data ?? resp, ['username']);
      if (!username) throw new Error('无法从视频号链接解析出 finder 用户名，请确认链接为有效的视频号主页 / 分享链接。');
      return username;
    }
    // 既不是链接也不是 finder username，直接当作 username 试一次
    return s;
  }

  async fetchAccount(accountUrl: string): Promise<SocialAccount> {
    const username = await this.resolveUsername(accountUrl);
    const resp: any = await this.client.post('/api/v1/wechat_channels/v2/fetch_user_profile', { username, raw: false });
    const d = resp?.data?.user ?? resp?.data?.profile ?? resp?.data ?? resp;
    const name = pickStr(d, ['nickname', 'name', 'username']) || username;
    // 视频数：顺带拉第一页作品统计（不强制）
    let videoCount = pickNum(d, ['feeds_count', 'note_count', 'video_count', 'notes_count']);
    try {
      if (!videoCount) {
        const vids = await this.fetchUserVideos(username, 1);
        videoCount = vids.length;
      }
    } catch { /* 不影响主流程 */ }
    return {
      id: `wechat_channels_${username}`,
      platform: 'wechat_channels',
      uniqueId: username,
      name,
      url: accountUrl,
      followers: pickNum(d, ['fans_count', 'fansCount', 'follower_count', 'followerCount', 'fans']),
      // 微信接口对部分账号会明确返回 fans_count=0，文档说明这代表未提供可用粉丝数。
      followersKnown: pickNum(d, ['fans_count', 'fansCount', 'follower_count', 'followerCount', 'fans']) > 0,
      likesTotal: pickNum(d, ['like_count', 'likes_count', 'liked_count', 'feedsLikeCount']),
      videoCount,
      category: 'traffic',
      categoryReason: '待分类',
      bio: pickStr(d, ['signature', 'desc', 'bio']),
    };
  }

  async fetchVideos(accountUrl: string, limit: number): Promise<SocialVideo[]> {
    const username = await this.resolveUsername(accountUrl);
    return this.fetchUserVideos(username, limit);
  }

  /** 拉取视频号作品（游标分页：last_buffer + up_continue） */
  private async fetchUserVideos(username: string, limit: number): Promise<SocialVideo[]> {
    const out: SocialVideo[] = [];
    let lastBuffer = '';
    for (let page = 0; page < 6 && out.length < limit; page++) {
      const params: Record<string, string> = { username };
      if (lastBuffer) params.last_buffer = lastBuffer;
      const resp: any = await this.client.post('/api/v1/wechat_channels/v2/fetch_user_videos', { ...params, raw: false });
      const d = resp?.data ?? resp;
      const list = firstArray(d, ['videos', 'items', 'list', 'aweme_list'])
        || firstArray(d?.data, ['videos', 'items', 'list']) || [];
      for (const v of list) {
        if (out.length >= limit) break;
        out.push(normalizeWechatVideo(v));
      }
      if (!d?.up_continue) break;
      lastBuffer = String(d?.last_buffer ?? '');
      if (!lastBuffer) break;
    }
    return out;
  }

  async fetchOneVideo(videoId: string): Promise<SocialVideo | null> {
    const id = (videoId ?? '').trim();
    if (!id) return null;
    const params = /^https?:\/\//i.test(id)
      ? { share_url: id, raw: false }
      : { object_id: id.replace(/^wechat_channels_/, ''), raw: false };
    try {
      const resp: any = await this.client.post('/api/v1/wechat_channels/v2/fetch_video_detail', params as any);
      const d = resp?.data ?? resp;
      const media = d?.media ?? d?.data?.media ?? d?.video ?? d?.data?.video ?? null;
      const fullUrl = pickStr(d, ['media_url', 'video_url', 'download_url', 'url'])
        || pickStr(media, ['full_url', 'download_url', 'video_url'])
        || (() => { const url = pickStr(media, ['url']); const token = pickStr(media, ['url_token', 'urlToken']); return url && token ? `${url}${token}` : (url || undefined); })();
      const objectId = pickStr(d, ['object_id', 'objectId', 'id', 'feed_id']) || pickStr(media, ['object_id', 'objectId', 'id']);
      const title = pickStr(d, ['title', 'description', 'desc', 'content', 'text'])
        || pickStr(media, ['title', 'description', 'desc']);
      const createTime = d?.create_time ?? media?.create_time;
      const publishTime = typeof createTime === 'number'
        ? new Date((createTime < 1e12 ? createTime * 1000 : createTime)).toISOString()
        : new Date().toISOString();
      return {
        id: `wechat_channels_${objectId || Math.random()}`,
        platform: 'wechat_channels',
        authorId: pickStr(d, ['username', 'nickname']),
        authorName: pickStr(d, ['nickname', 'username']),
        url: pickStr(d, ['share_url', 'url']) || id,
        publishTime,
        title,
        caption: title,
        hook: '',
        views: pickNum(d, ['read_count', 'readCount', 'views', 'play_count', 'playCount', 'view_count', 'viewCount'])
          || pickNum(d?.count_info ?? d?.countInfo ?? d?.monotonic_data ?? d?.monotonicData, ['read_count', 'readCount', 'view_count', 'viewCount', 'play_count', 'playCount'])
          || pickNum(media, ['read_count', 'views', 'play_count']),
        likes: pickNum(d, ['like_count', 'likes', 'digg_count']) || pickNum(media, ['like_count', 'likes']),
        comments: pickNum(d, ['comment_count', 'comments']) || pickNum(media, ['comment_count', 'comments']),
        shares: pickNum(d, ['forward_count', 'share_count', 'forwards']) || pickNum(media, ['forward_count', 'share_count']),
        favorites: pickNum(d, ['fav_count', 'favorites', 'collect_count']) || pickNum(media, ['fav_count', 'favorites']),
        durationSec: Number(d?.duration ?? media?.duration ?? 15),
        structure: '',
        source: '',
        bgm: '',
        tags: normalizeTags(d?.tags ?? d?.hashtags ?? d?.hash_tags, title),
        isVideo: true,
        mediaType: 'video',
        // read_count=0 是接口常见的“未提供播放量”，不应在页面伪装成真实 0。
        viewsKnown: pickNum(d, ['read_count', 'readCount', 'views', 'play_count', 'playCount', 'view_count', 'viewCount']) > 0,
        mediaUrl: fullUrl,
        decodeKey: pickStr(media, ['decode_key', 'decodeKey']) || pickStr(d, ['decode_key', 'decodeKey']) || undefined,
      };
    } catch {
      return null;
    }
  }

  async fetchVideoComments(videoId: string): Promise<{ text: string; likes: number }[]> {
    let id = (videoId ?? '').replace(/^wechat_channels_/, '').trim();
    if (!id) return [];
    if (/^https?:\/\//i.test(id)) {
      const detail = await this.fetchOneVideo(id);
      id = detail?.id?.replace(/^wechat_channels_/, '') ?? '';
    }
    if (!id || !/^\d+$/.test(id)) return [];
    try {
      const resp: any = await this.client.post('/api/v1/wechat_channels/v2/fetch_video_comments', { object_id: id, raw: false });
      const d = resp?.data ?? resp;
      const list = d?.comments ?? d?.data?.comments ?? d?.list ?? [];
      if (!Array.isArray(list)) return [];
      return list
        .map((c: any) => ({ text: pickStr(c, ['content', 'text', 'comment_content']), likes: pickNum(c, ['like_count', 'likes']) }))
        .filter((c: { text: string }) => c.text)
        .slice(0, 20);
    } catch {
      return [];
    }
  }

  async searchVideos(keyword: string): Promise<SocialVideo[]> {
    const q = (keyword ?? '').trim();
    if (!q) return [];
    try {
      const resp: any = await this.client.post('/api/v1/wechat_search/v2/fetch_search_videos', {
        keyword: q, sort: 'hot', duration: 'all', publish_time: 'all', offset: 0, raw: false,
      });
      const d = resp?.data ?? resp;
      const list = findVideoArray(d);
      return list.map(normalizeWechatVideo).filter((v: SocialVideo) => v.title || v.url);
    } catch {
      return [];
    }
  }

  /** 热点：按 hot 排序搜索后，以标题和标签作为可展示的话题项。 */
  async fetchTrends(keyword?: string): Promise<TrendTopic[]> {
    const videos = await this.searchVideos(keyword ?? '');
    return videos.slice(0, 30).map((v, i) => ({
      platform: 'wechat_channels', keyword: v.title || v.tags[0] || `视频 ${i + 1}`,
      heat: v.views || v.likes || 0, growth: 0, relatedTags: v.tags,
      topPosts: [{ id: v.id, title: v.title, likes: v.likes, url: v.url }],
    }));
  }

  async fetchHashtags(keyword?: string): Promise<HashtagStat[]> {
    const videos = await this.searchVideos(keyword ?? '');
    const stats = new Map<string, HashtagStat>();
    videos.forEach((v) => v.tags.forEach((tag) => {
      const prev = stats.get(tag) || { tag, platform: 'wechat_channels' as const, posts: 0, views: 0, growth: 0 };
      prev.posts += 1; prev.views += v.views || 0; stats.set(tag, prev);
    }));
    return Array.from(stats.values()).sort((a, b) => b.views - a.views || b.posts - a.posts).slice(0, 50);
  }

  async fetchHashtagDetail(_keyword: string): Promise<HashtagStat | null> { return null; }
}

// ---- 工具 ----

/** 从视频号链接中提取 channel_id（sph... 短号）：优先匹配 sph 前缀，否则取 /sph/ 之后路径段 */
function extractChannelId(url: string): string | null {
  const u = url.trim();
  const m = u.match(/sph[A-Za-z0-9_-]+/i);
  if (m) return m[0];
  const sph = u.match(/\/sph\/([A-Za-z0-9_-]+)/i);
  if (sph) return `sph${sph[1]}`;
  const seg = u.match(/channels\.weixin\.qq\.com\/(?:[^/]+\/)*(feed|post)\/([A-Za-z0-9_-]+)/i);
  if (seg) return seg[2];
  return null;
}

function pickNum(obj: any, keys: string[]): number {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && !isNaN(Number(v))) return Number(v);
  }
  return 0;
}

function pickStr(obj: any, keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function firstArray(obj: any, keys: string[]): any[] | null {
  for (const key of keys) if (Array.isArray(obj?.[key])) return obj[key];
  return null;
}

function findVideoArray(obj: any): any[] {
  const direct = firstArray(obj, ['videos', 'items', 'list', 'aweme_list', 'video_list', 'videoList', 'search_result']);
  if (direct && direct.length) return direct;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const nested = findVideoArray(item);
      if (nested.length) return nested;
    }
    return [];
  }
  if (obj && typeof obj === 'object') {
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) {
        const directItems = value.filter((item: any) => item && typeof item === 'object' && (item.title || item.desc || item.description || item.object_id || item.video_id || item.exportId));
        if (directItems.length) return directItems;
      }
      if (value && typeof value === 'object') {
        const nested = findVideoArray(value);
        if (nested.length) return nested;
      }
    }
  }
  return [];
}

function extractTags(text: string): string[] {
  const m = text.match(/#[\p{L}\p{N}_]+/gu);
  return m ? Array.from(new Set(m.map((t) => t.slice(1)))) : [];
}

function normalizeTags(raw: any, text: string): string[] {
  const fromApi = Array.isArray(raw)
    ? raw.map((t) => typeof t === 'string' ? t.replace(/^#/, '') : pickStr(t, ['name', 'tag', 'title'])).filter(Boolean)
    : [];
  return Array.from(new Set([...fromApi, ...extractTags(text)]));
}

function normalizeWechatVideo(v: any): SocialVideo {
  const media = v?.media ?? v?.video ?? null;
  const id = pickStr(v, ['id', 'object_id', 'objectId', 'doc_id', 'feed_id']) || Math.random().toString(36).slice(2);
  const title = pickStr(v, ['title', 'description', 'desc', 'short_title', 'content', 'text', 'share_text']);
  const createTime = v?.create_time ?? v?.publish_time;
  const publishTime = typeof createTime === 'number'
    ? new Date((createTime < 1e12 ? createTime * 1000 : createTime)).toISOString()
    : new Date().toISOString();
  return {
    id: `wechat_channels_${id}`,
    platform: 'wechat_channels',
    authorId: pickStr(v, ['username', 'nickname']),
    authorName: pickStr(v, ['nickname', 'username']),
    url: pickStr(v, ['share_url', 'url']) || `https://channels.weixin.qq.com/${id}`,
    publishTime,
      title,
    caption: title,
      hook: '',
    views: pickNum(v, ['read_count', 'readCount', 'views', 'play_count', 'playCount', 'view_count', 'viewCount']),
    likes: pickNum(v, ['like_count', 'likes']),
    comments: pickNum(v, ['comment_count', 'comments']),
    shares: pickNum(v, ['forward_count', 'share_count', 'forwards']),
    favorites: pickNum(v, ['fav_count', 'favorites', 'collect_count']),
    durationSec: Number(v?.duration ?? 15),
    structure: '',
    source: '',
    bgm: '',
    tags: normalizeTags(v?.tags ?? v?.hashtags ?? v?.hash_tags, title),
    isVideo: true,
    mediaType: 'video',
    viewsKnown: pickNum(v, ['read_count', 'readCount', 'views', 'play_count', 'playCount', 'view_count', 'viewCount']) > 0,
    mediaUrl: pickStr(v, ['media_url', 'video_url'])
      || pickStr(media, ['full_url', 'download_url', 'video_url'])
      || (() => { const url = pickStr(media, ['url']); const token = pickStr(media, ['url_token', 'urlToken']); return url && token ? `${url}${token}` : (url || undefined); })(),
    decodeKey: pickStr(media, ['decode_key', 'decodeKey']) || pickStr(v, ['decode_key', 'decodeKey']) || undefined,
  };
}

function hasNum(obj: any, keys: string[]): boolean {
  return keys.some((k) => typeof obj?.[k] === 'number' || (typeof obj?.[k] === 'string' && obj[k].trim() !== '' && !isNaN(Number(obj[k]))));
}
