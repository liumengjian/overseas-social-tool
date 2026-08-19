// Twitter / X 数据提供者（基于 TiKhub 官方接口，已实测可用）
// 端点（均返回 200）：
//   - 热点 / 趋势：/api/v1/twitter/web/fetch_trending（返回 data.trends[]，每条含 name/description/context）
//   - 用户资料：   /api/v1/twitter/web/fetch_user_profile（参数 screen_name）
//   - 用户媒体：   /api/v1/twitter/web/fetch_user_media（参数 screen_name）
// 说明：Twitter 没有独立的「搜索 / hashtag」接口，Hashtag 排行由 fetch_trending 的热点词派生，
//       用户媒体（fetch_user_media 的 timeline）结构较深，采用「递归扫描 legacy 节点」做最佳解析，
//       解析不到时返回空数组（绝不发起 404 请求）。
import { TikHubClient, parseAccountUrl } from '../tikhub-client';
import { SocialProvider } from '../types';
import { AppConfig, Platform, SocialAccount, SocialVideo, TrendTopic, HashtagStat } from '../../shared/types';

export class TwitterProvider implements SocialProvider {
  platform: Platform = 'twitter';
  private client: TikHubClient;
  // 同一次 fetchTrendData 内 fetchTrends / fetchHashtags 都会调用 fetch_trending，缓存一次避免重复计费
  private trendRaw: any = null;

  constructor(cfg: AppConfig) {
    this.client = new TikHubClient(cfg);
  }

  async fetchAccount(accountUrl: string): Promise<SocialAccount> {
    const { uniqueId } = parseAccountUrl('twitter', accountUrl);
    const screen = uniqueId || accountUrl.trim().replace(/^@/, '');
    const resp: any = await this.client.get('/api/v1/twitter/web/fetch_user_profile', { screen_name: screen });
    const d = resp?.data ?? {};
    if (d?.status !== 'active' && !d?.name) {
      throw new Error(`未找到该 Twitter 账号（status: ${d?.status ?? 'unknown'}）`);
    }
    return {
      id: `twitter_${d.id ?? screen}`,
      platform: 'twitter',
      uniqueId: screen,
      name: d.name ?? screen,
      url: accountUrl,
      followers: Number(d.sub_count ?? 0),
      category: 'traffic',
      categoryReason: 'Twitter 账号（未做业务分类）',
      categoryEvidence: [],
      bio: d.desc ?? '',
    };
  }

  async fetchVideos(accountUrl: string, limit: number): Promise<SocialVideo[]> {
    const { uniqueId } = parseAccountUrl('twitter', accountUrl);
    const screen = uniqueId || accountUrl.trim().replace(/^@/, '');
    const resp: any = await this.client.get('/api/v1/twitter/web/fetch_user_media', { screen_name: screen, count: 50 });
    const tweets = collectTweets(resp?.data).slice(0, limit);
    return tweets.map((t: any, i: number) => normalizeTweet(t, i, screen));
  }

  async fetchTrends(_accounts?: string[]): Promise<TrendTopic[]> {
    const resp: any = await this.client.get('/api/v1/twitter/web/fetch_trending');
    this.trendRaw = resp;
    const list = resp?.data?.trends ?? [];
    return list
      .map((t: any, i: number): TrendTopic => ({
        platform: 'twitter',
        keyword: String(t.name ?? '').replace(/^#/, ''),
        // 排名越靠前热度越高：用 (总数 - 名次) 映射一个相对热度值
        heat: list.length - i,
        growth: 0,
        relatedTags: [String(t.name ?? ''), t.context ? String(t.context) : ''].filter(Boolean),
        snapshotTime: Date.now(),
      }))
      .filter((t: TrendTopic) => t.keyword);
  }

  async fetchHashtags(_accounts?: string[]): Promise<HashtagStat[]> {
    // 复用热点请求（优先用缓存的 trendRaw），不再重复计费
    let list: any[] = this.trendRaw?.data?.trends;
    if (!Array.isArray(list)) {
      const resp: any = await this.client.get('/api/v1/twitter/web/fetch_trending');
      list = resp?.data?.trends ?? [];
    }
    return list
      .map((t: any, i: number): HashtagStat => ({
        platform: 'twitter',
        tag: String(t.name ?? '').replace(/^#/, ''),
        posts: list.length - i,
        views: list.length - i,
        growth: 0,
      }))
      .filter((h: HashtagStat) => h.tag);
  }

  async searchVideos(_keyword: string): Promise<SocialVideo[]> { return []; }
  async fetchOneVideo(_videoId: string): Promise<SocialVideo | null> { return null; }
  async fetchVideoComments(_videoId: string): Promise<{ text: string; likes: number }[]> { return []; }
  async fetchHashtagDetail(_keyword: string): Promise<HashtagStat | null> { return null; }
}

/** 递归扫描任意结构，收集所有含 legacy.full_text 的推文节点（Twitter API v2 timeline 结构很深） */
function collectTweets(node: any, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((n) => collectTweets(n, out));
    return out;
  }
  if (node.legacy && typeof node.legacy.full_text === 'string') {
    out.push(node);
    return out;
  }
  for (const k of Object.keys(node)) collectTweets(node[k], out);
  return out;
}

/** 把一条推文 legacy 节点规范为 SocialVideo（最佳解析，字段缺失则给空默认值） */
function normalizeTweet(t: any, i: number, screen: string): SocialVideo {
  const legacy = t.legacy ?? {};
  const id = String(legacy.id_str ?? legacy.id ?? `${screen}_${i}`);
  const text: string = legacy.full_text ?? '';
  const mediaList: any[] = legacy.entities?.media ?? [];
  const firstMedia = mediaList[0];
  const isVideo = !!firstMedia?.video_info || /(\.mp4|video)/i.test(firstMedia?.media_url_https ?? '');
  const mediaUrl = firstMedia?.media_url_https ?? firstMedia?.media_url ?? undefined;
  const createdAt: string = legacy.created_at ?? '';
  const url = (legacy.entities?.urls?.[0]?.expanded_url)
    ?? `https://twitter.com/${screen}/status/${id}`;
  return {
    id: `twitter_${id}`,
    platform: 'twitter',
    authorId: screen,
    authorName: screen,
    url,
    publishTime: createdAt ? new Date(createdAt).toISOString() : new Date().toISOString(),
    title: text.slice(0, 40),
    caption: text,
    hook: text.slice(0, 60),
    views: Number(legacy.views?.count ?? 0),
    likes: Number(legacy.favorite_count ?? 0),
    comments: 0,
    shares: Number(legacy.retweet_count ?? 0),
    favorites: Number(legacy.favorite_count ?? 0),
    durationSec: isVideo ? (firstMedia?.video_info?.duration_millis ? Math.round(firstMedia.video_info.duration_millis / 1000) : 0) : 0,
    structure: '',
    source: '',
    bgm: '',
    tags: extractHashtags(text),
    isVideo,
    mediaType: isVideo ? 'video' : 'image',
    mediaUrl,
  };
}

function extractHashtags(text: string): string[] {
  const set = new Set<string>();
  const re = /#([\p{L}\p{N}_]+)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) set.add(m[1]);
  return Array.from(set).slice(0, 10);
}
