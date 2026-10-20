// 小红书（Red Note）数据提供者（基于 TiKhub Xiaohongshu App V2 接口）。
// 文档：https://tikhub.io/zh/xiaohongshu-api  /  https://blog.tikhub.io/article/7
// 已选用端点（App V2，2026-06-17 后 App V1 / Web V2 / Web V3 已停用，勿用）：
//   - 用户资料：     /api/v1/xiaohongshu/app_v2/get_user_info         (user_id | share_text 二选一)
//   - 用户笔记列表： /api/v1/xiaohongshu/app_v2/get_user_posted_notes  (user_id | share_text, cursor 分页)
//   - 视频笔记详情： /api/v1/xiaohongshu/app_v2/get_video_note_detail   (note_id | share_text)
//   - 图文笔记详情： /api/v1/xiaohongshu/app_v2/get_image_note_detail    (note_id | share_text)
//   - 笔记评论：     /api/v1/xiaohongshu/app_v2/get_note_comments        (note_id, cursor)
//   - 搜索笔记：     /api/v1/xiaohongshu/app_v2/search_notes            (keyword)
// 说明：热点 / Hashtag 排行使用创作者中心热点灵感流：
// get_creator_hot_inspiration_feed（游标分页）→ 应用层统计话题标签频次与共现关系。
// 注意：响应字段命名未在公开文档中给出精确 JSON 路径，以下用多重别名兜底，确保缺失字段不报错；
// 若实际返回结构与别名不符，请按真实响应微调 normalizeXhs* 的字段映射。
import { TikHubClient } from '../tikhub-client';
import { SocialProvider } from '../types';
import { DiscoveredTopic, fmtCount, isGenericTag } from '../trend-utils';
import { AppConfig, Platform, SocialAccount, SocialVideo, TrendTopic, HashtagStat } from '../../shared/types';

export class XiaohongshuProvider implements SocialProvider {
  platform: Platform = 'xiaohongshu';
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

  /** 把账号输入（user_id 或分享链接）映射为请求参数：链接走 share_text，否则走 user_id */
  private userParams(acc: string): { user_id?: string; share_text?: string } {
    return /^https?:\/\//i.test(acc) ? { share_text: acc } : { user_id: acc };
  }

  async fetchAccount(accountUrl: string): Promise<SocialAccount> {
    const resp: any = await this.client.get('/api/v1/xiaohongshu/app_v2/get_user_info', this.userParams(accountUrl));
    const u = digXhsUser(resp?.data ?? resp) ?? {};
    const name = pickStr(u, ['nickname', 'name']) || 'unknown';
    return {
      id: `xiaohongshu_${pickStr(u, ['user_id', 'userId', 'id']) || name}`,
      platform: 'xiaohongshu',
      uniqueId: name,
      name,
      url: accountUrl,
      followers: pickNum(u, ['fans_count', 'follower_count', 'fans']),
      likesTotal: pickNum(u, ['likes_count', 'liked_count', 'interaction_count']),
      videoCount: pickNum(u, ['notes_count', 'note_count']),
      category: 'traffic',
      categoryReason: '待分类',
      bio: pickStr(u, ['desc', 'bio', 'signature']),
    };
  }

  async fetchVideos(accountUrl: string, limit: number): Promise<SocialVideo[]> {
    const out: SocialVideo[] = [];
    let cursor = '';
    // 游标分页，最多拉 5 页，凑够 limit 条
    for (let page = 0; page < 5 && out.length < limit; page++) {
      const params: Record<string, string> = this.userParams(accountUrl);
      if (cursor) params.cursor = cursor;
      const resp: any = await this.client.get('/api/v1/xiaohongshu/app_v2/get_user_posted_notes', params);
      const notes = digNotes(resp);
      if (!notes.length) break;
      for (const n of notes) {
        if (out.length >= limit) break;
        out.push(normalizeXhsNote(n));
      }
      cursor = String(resp?.data?.cursor ?? resp?.data?.data?.cursor ?? '');
      if (!cursor) break;
    }
    return out;
  }

  async fetchOneVideo(videoId: string): Promise<SocialVideo | null> {
    const id = (videoId ?? '').trim();
    if (!id) return null;
    // 链接直连：整条 URL 作为 share_text；库内视频：xiaohongshu_<note_id> 取 note_id
    const params: Record<string, string | number> = /^https?:\/\//i.test(id)
      ? { share_text: id }
      : { note_id: id.replace(/^xiaohongshu_/, '') };
    try {
      const resp: any = await this.client.get('/api/v1/xiaohongshu/app_v2/get_video_note_detail', params);
      const note = resp?.data?.data ?? resp?.data ?? resp?.note ?? null;
      return note ? normalizeXhsNote(note, true) : null;
    } catch {
      // 视频笔记详情失败，尝试图文笔记（部分笔记为图文，无视频流）
      try {
        const resp: any = await this.client.get('/api/v1/xiaohongshu/app_v2/get_image_note_detail', params);
        const note = resp?.data?.data ?? resp?.data ?? resp?.note ?? null;
        return note ? normalizeXhsNote(note, false) : null;
      } catch {
        return null;
      }
    }
  }

  async fetchVideoComments(videoId: string): Promise<{ text: string; likes: number }[]> {
    const id = (videoId ?? '').replace(/^xiaohongshu_/, '').trim();
    if (!id) return [];
    try {
      const resp: any = await this.client.get('/api/v1/xiaohongshu/app_v2/get_note_comments', { note_id: id });
      const list = resp?.data?.data?.comments ?? resp?.data?.comments ?? resp?.data?.data?.list ?? [];
      if (!Array.isArray(list)) return [];
      return list
        .map((c: any) => ({ text: pickStr(c, ['content', 'text', 'comment_content']), likes: pickNum(c, ['liked_count', 'like_count', 'likes']) }))
        .filter((c: { text: string }) => c.text)
        .slice(0, 20);
    } catch {
      return [];
    }
  }

  async searchVideos(keyword: string): Promise<SocialVideo[]> {
    const kw = (keyword ?? '').trim();
    if (!kw) return [];
    try {
      const resp: any = await this.client.get('/api/v1/xiaohongshu/app_v2/search_notes', { keyword: kw, search_type: 'note', cursor: '' });
      return digNotes(resp).slice(0, 20).map((n) => normalizeXhsNote(n));
    } catch {
      return [];
    }
  }

  /**
   * 模块三：热点话题（「搜索→提取→验证」三步即时发现，多关键词循环合并）
   * Step1 获取创作者热点灵感流 → Step2 提取灵感内容 tag 统计频次 → Step3 使用互动数据和共现标签生成结果。
   * keyword 支持逗号分隔的多关键词；仅在用户主动输入关键词时执行搜索。
   * 与 fetchHashtags 共享同一份发现结果（同一次 fetchTrendData 只搜一轮，避免重复消耗接口）。
   */
  async fetchTrends(keyword?: string): Promise<TrendTopic[]> {
    return [];
  }

  /** 模块三：Hashtag 排行（复用 fetchTrends 已发现的同一批话题，映射为 posts/views；按浏览量降序，与「上升热点话题」的热度排序区分开） */
  async fetchHashtags(keyword?: string): Promise<HashtagStat[]> {
    const kw = keyword?.trim();
    if (!kw) return [];
    const resp: any = await this.client.get('/api/v1/xiaohongshu/web_v3/fetch_search_suggest', { keyword: kw });
    return digXhsSuggestions(resp).slice(0, 30).map((suggestion) => ({
      tag: suggestion.text,
      platform: 'xiaohongshu' as Platform,
      posts: 0,
      // 接口没有词条浏览量/热度时不生成虚假数值。
      views: suggestion.heat,
      growth: 0,
    }));
  }

  // 短时共享缓存：fetchTrendData 会先调 fetchTrends 再调 fetchHashtags，用同一批发现结果，避免搜索接口重复调用
  private lastKeyword?: string;
  private lastTopics?: DiscoveredTopic[];

  /** 推荐流发现；同一次调用周期内 fetchTrends / fetchHashtags 共享 */
  private async discoverShared(_keyword?: string): Promise<DiscoveredTopic[]> {
    const key = 'creator-inspiration-feeds';
    if (this.lastKeyword === key && this.lastTopics) return this.lastTopics;
    const topics = await this.discoverTopics();
    this.lastKeyword = key;
    this.lastTopics = topics;
    return topics;
  }

  /** 各取一页创作者热点流，两个接口并行调用，避免走关键词搜索。 */
  private async searchNotesHot(count: number): Promise<any[]> {
    const paths = [
      '/api/v1/xiaohongshu/app_v2/get_creator_hot_inspiration_feed',
      '/api/v1/xiaohongshu/app_v2/get_creator_inspiration_feed',
    ];
    const pages = await Promise.all(paths.map(async (path) => {
      try {
        const resp: any = await this.client.get(path, { cursor: '' });
        return digInspirationItems(resp);
      } catch {
        return [];
      }
    }));
    return Array.from(new Map(pages.flat().map((item: any, index: number) => [
      String(item?.note_id ?? item?.id ?? item?.note_card?.note_id ?? index),
      item,
    ])).values()).slice(0, count);
  }

  /** 三步即时热点发现核心实现 */
  private async discoverTopics(): Promise<DiscoveredTopic[]> {
    // Step 1：合并创作者热点灵感流和普通灵感流（接口返回顺序即平台热点流顺序）
    const notes = await this.searchNotesHot(200);
    if (!notes.length) return [];
    // Step 2：标签提取与频次统计（纯应用层）
    const freq = new Map<string, { count: number; engagement: number; views: number; pageId?: string; samples: any[] }>();
    for (const n of notes) {
      const note = unwrapXhsNote(n);
      const topics = extractXhsTopics(note);
      const it = note?.interact_info ?? note?.interaction_info ?? {};
      const likes = pickNum(it, ['liked_count', 'like_count', 'likes']) || pickNum(note, ['score']);
      const views = pickNum(it, ['viewed_count', 'view_count', 'views']) || parseCountText(note?.score_text ?? note?.cnt_desc);
      for (const t of topics) {
        if (!t.name || isGenericTag(t.name)) continue;
        const st = freq.get(t.name) ?? { count: 0, engagement: 0, views: 0, samples: [] };
        st.count += 1;
        st.engagement += likes;
        st.views += views;
        if (!st.pageId && t.pageId) st.pageId = t.pageId;
        if (st.samples.length < 5) st.samples.push(n);
        freq.set(t.name, st);
      }
    }
    // 仅使用本次搜索结果完成统计，避免额外调用话题详情接口。
    const ranked = Array.from(freq.entries()).sort(
      (a, b) => b[1].count - a[1].count || b[1].engagement - a[1].engagement,
    );
    const out: DiscoveredTopic[] = [];
    for (let i = 0; i < ranked.length; i++) {
      const [tag, st] = ranked[i];
      let heat = Math.min(100, 20 + st.count * 12 + Math.round(st.engagement / 500));
      let heatDesc = `候选频次 ${st.count} 次 / 样本赞 ${st.engagement}`;
      // 先使用搜索样本做共现统计；话题详情接口成功时再用更丰富的 feed 覆盖。
      let related: string[] = xhsCoOccurrence(st.samples, tag).slice(0, 5);
      let topPosts = xhsTopPosts(st.samples);
      out.push({ tag, count: st.count, engagement: st.engagement, views: st.views, heat, heatDesc, relatedTags: related, topPosts });
    }
    return out;
  }

  /** 话题详情验证：返回官方浏览量 / 讨论数 */
  private async fetchTopicInfo(pageId: string): Promise<{ heat: number; heatDesc: string } | null> {
    const resp: any = await this.client.get('/api/v1/xiaohongshu/app_v2/get_topic_info', { page_id: pageId });
    const info = resp?.data?.page_info ?? resp?.data?.data?.page_info ?? resp?.data ?? resp ?? {};
    const views = pickNum(info, ['view_count', 'views', 'view_num', 'views_count']);
    const discussions = pickNum(info, ['discussion_count', 'discussion_num', 'discussions', 'feed_count', 'note_count']);
    if (!views && !discussions) return null;
    const heat = Math.min(100, 5 + Math.round(Math.log10(views || 1) * 8) + (discussions ? Math.round(Math.log10(discussions + 1) * 4) : 0));
    return { heat, heatDesc: `浏览量 ${fmtCount(views)} / 讨论数 ${fmtCount(discussions)}` };
  }

  /** 话题下最热笔记列表（sort=trend） */
  private async fetchTopicFeed(pageId: string, count: number): Promise<any[]> {
    const resp: any = await this.client.get('/api/v1/xiaohongshu/app_v2/get_topic_feed', { page_id: pageId, sort: 'trend' });
    return digNotes(resp).slice(0, count);
  }

  async fetchHashtagDetail(_keyword: string): Promise<HashtagStat | null> { return null; }
}

// ---- 响应结构兜底工具 ----

function digXhsSuggestions(resp: any): { text: string; heat: number }[] {
  const root = resp?.data ?? resp;
  const list = findXhsSuggestionArray(root) ?? [];
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list.map((item: any) => {
    const text = String(typeof item === 'string'
      ? item
      : item?.keyword ?? item?.query ?? item?.word ?? item?.text ?? item?.title ?? item?.name ?? '').trim();
    const heat = Number(item?.heat ?? item?.hot_score ?? item?.score ?? item?.hot_value ?? item?.view_count ?? item?.views ?? 0);
    return { text, heat };
  }).filter((item) => item.text && !seen.has(item.text) && (seen.add(item.text), true));
}

function findXhsSuggestionArray(value: any, depth = 0): any[] | null {
  if (!value || depth > 6) return null;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return null;
  for (const key of ['suggestions', 'items', 'list', 'results', 'data']) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findXhsSuggestionArray(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** 在任意层级找「笔记列表」数组 */
function digNotes(resp: any): any[] {
  const d = resp?.data?.data ?? resp?.data ?? resp;
  const candidates = [
    d?.notes,
    d?.data?.notes,
    d?.items,
    d?.data?.items,
    d?.list,
    d?.note_list,
    d?.data?.note_list,
    Array.isArray(d) ? d : null,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  // 递归兜底：某些接口把列表包在更深层级（如 search 结果 data.data 下的集合）
  const found = deepFindNotesArray(d, 0);
  return found ?? [];
}

/** 兼容创作者灵感流的列表包装；优先使用明确的内容字段，避免误取标签数组。 */
function digInspirationItems(resp: any): any[] {
  const root = resp?.data ?? resp;
  const named = [
    root?.items,
    root?.list,
    root?.notes,
    root?.inspiration,
    root?.inspirations,
    root?.hot_inspiration_list,
    root?.inspiration_list,
    root?.feed_list,
    root?.feed,
    root?.data?.items,
    root?.data?.list,
    root?.data?.notes,
    root?.data?.inspiration,
    root?.data?.inspirations,
    root?.data?.hot_inspiration_list,
    root?.data?.inspiration_list,
    root?.data?.feed_list,
  ];
  for (const value of named) {
    if (Array.isArray(value)) return value;
  }
  return findObjectArray(root, 0) ?? [];
}

/** 在有限深度内寻找对象数组，适配接口后续增加包装层的情况。 */
function findObjectArray(value: any, depth: number): any[] | null {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  if (Array.isArray(value)) {
    return value.length && value.every((item) => item && typeof item === 'object') ? value : null;
  }
  for (const key of Object.keys(value)) {
    const found = findObjectArray(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/** 兼容 cursor 位于 data、data.data 或响应根节点的情况。 */
function digCursor(resp: any): string {
  const candidates = [
    resp?.cursor,
    resp?.data?.cursor,
    resp?.data?.data?.cursor,
    resp?.data?.next_cursor,
    resp?.data?.data?.next_cursor,
    resp?.next_cursor,
  ];
  return candidates.find((value) => value !== undefined && value !== null && String(value) !== '') !== undefined
    ? String(candidates.find((value) => value !== undefined && value !== null && String(value) !== ''))
    : '';
}

/** 递归查找「对象数组」（首元素为对象的数组），最深 5 层 */
function deepFindNotesArray(obj: any, depth: number): any[] | null {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  if (Array.isArray(obj) && obj.length && typeof obj[0] === 'object') return obj;
  for (const k of Object.keys(obj)) {
    const r = deepFindNotesArray(obj[k], depth + 1);
    if (r) return r;
  }
  return null;
}

/** 在任意层级找「用户对象」（含 nickname / name） */
function digXhsUser(obj: any, depth = 0): any {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
  if ((obj.nickname || obj.name) && typeof obj === 'object') return obj;
  for (const k of Object.keys(obj)) {
    const r = digXhsUser(obj[k], depth + 1);
    if (r) return r;
  }
  return undefined;
}

/** 兼容小红书搜索结果的多种笔记包裹（note_card / note / 直接是笔记对象） */
function unwrapXhsNote(n: any): any {
  if (!n || typeof n !== 'object') return n ?? {};
  if (n?.note_card && typeof n.note_card === 'object') return n.note_card;
  if (n?.note && typeof n.note === 'object') return n.note;
  if (n?.note_info && typeof n.note_info === 'object') return n.note_info;
  if (n?.note_data && typeof n.note_data === 'object') return n.note_data;
  return n;
}

/** 从笔记中提取话题标签（含话题 page_id，用于 get_topic_info / get_topic_feed 验证） */
function extractXhsTopics(n: any): { name: string; pageId?: string }[] {
  const unwrapped = unwrapXhsNote(n);
  const out: { name: string; pageId?: string }[] = [];
  const list = unwrapped?.tag_list
    ?? unwrapped?.tags
    ?? unwrapped?.topics
    ?? unwrapped?.topic_list
    ?? unwrapped?.hot_topics
    ?? unwrapped?.hashtags
    ?? [];
  if (Array.isArray(list)) {
    for (const t of list) {
      if (typeof t === 'string') {
        const name = t.replace(/^#/, '').trim();
        if (name) out.push({ name });
      } else if (t && typeof t === 'object') {
        const name = String(t?.name ?? t?.tag_name ?? t?.tag ?? '').replace(/^#/, '').trim();
        if (name) out.push({ name, pageId: t?.id ?? t?.tag_id ?? t?.page_id ?? undefined });
      }
    }
  }
  for (const key of ['topic_name', 'tag_name', 'hashtag', 'keyword']) {
    const value = unwrapped?.[key];
    if (typeof value === 'string') {
      const name = value.replace(/^#/, '').trim();
      if (name) out.push({ name });
    }
  }
  // 从文案提取 # 标签兜底（无 topic id，仅参与频次统计）
  const desc: string = unwrapped?.desc ?? unwrapped?.title ?? unwrapped?.content ?? '';
  extractTags(desc).forEach((t) => out.push({ name: t }));
  // 创作者中心灵感流不是普通笔记结构：热点流使用 title，灵感流使用 name。
  for (const key of ['title', 'name', 'hot_name', 'topic']) {
    const value = unwrapped?.[key];
    if (typeof value === 'string' && value.trim()) {
      const name = value.replace(/^#/, '').trim();
      if (name && !out.some((item) => item.name === name)) out.push({ name });
    }
  }
  return out;
}

/** 话题下笔记的共现标签统计（除自身外的 Top 5，含 # 前缀） */
function xhsCoOccurrence(notes: any[], self: string): string[] {
  const freq = new Map<string, number>();
  for (const n of notes) {
    const tags = extractXhsTopics(n)
      .map((t) => t.name)
      .filter((name) => name && name !== self && !isGenericTag(name));
    for (const t of new Set(tags)) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => `#${t}`);
}

/** 把笔记列表映射为该话题的「最热内容样本」（按赞降序 Top 3） */
function xhsTopPosts(notes: any[]): { id: string; title: string; likes: number; cover?: string; url?: string }[] {
  return notes
    .map((n) => {
      n = unwrapXhsNote(n);
      const it = n?.interact_info ?? n?.interaction_info ?? {};
      const noteId = pickStr(n, ['note_id', 'id', 'noteId']);
      return {
        id: noteId,
        title: (pickStr(n, ['title', 'display_title', 'desc']) || '').slice(0, 30),
        likes: pickNum(it, ['liked_count', 'like_count', 'likes']),
        cover: pickStr(n, ['cover_url', 'cover', 'image_url']) || undefined,
        url: pickStr(n, ['note_url', 'url']) || (noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : undefined),
      };
    })
    .filter((p) => p.id)
    .sort((a, b) => b.likes - a.likes)
    .slice(0, 3);
}

function pickNum(obj: any, keys: string[]): number {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && !isNaN(Number(v))) return Number(v);
  }
  return 0;
}

function parseCountText(value: any): number {
  const text = String(value ?? '').replace(/,/g, '').trim();
  const match = text.match(/([\d.]+)\s*([万亿kKmMbB]?)/);
  if (!match) return 0;
  const base = Number(match[1]);
  const unit = match[2].toLowerCase();
  return Math.round(base * (unit === '亿' || unit === 'b' ? 1e8 : unit === '万' || unit === 'm' ? 1e4 : unit === 'k' ? 1e3 : 1));
}

function pickStr(obj: any, keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function extractTags(text: string): string[] {
  const m = text.match(/#[\p{L}\p{N}_]+/gu);
  return m ? Array.from(new Set(m.map((t) => t.slice(1)))) : [];
}

function normalizeXhsNote(n: any, isVideo = true): SocialVideo {
  const it = n?.interact_info ?? n?.interaction_info ?? {};
  const noteId = pickStr(n, ['note_id', 'id', 'noteId']);
  const desc: string = pickStr(n, ['desc', 'title', 'content']);
  const cover = pickStr(n, ['cover_url', 'cover', 'image_url']) || (Array.isArray(n?.images) ? n.images[0] : '');
  const videoUrl = n?.video_info?.url ?? n?.video_info?.video_url ?? n?.video?.url ?? undefined;
  const timeRaw = n?.time ?? n?.create_time ?? n?.publish_time;
  const publishTime = typeof timeRaw === 'number'
    ? new Date((timeRaw < 1e12 ? timeRaw * 1000 : timeRaw)).toISOString()
    : new Date().toISOString();
  const tags = Array.isArray(n?.tag_list)
    ? n.tag_list.map((t: any) => (typeof t === 'string' ? t.replace(/^#/, '') : (t?.name ?? t?.tag ?? ''))).filter(Boolean)
    : [];
  return {
    id: `xiaohongshu_${noteId || Math.random()}`,
    platform: 'xiaohongshu',
    authorId: pickStr(n?.user ?? {}, ['user_id', 'userId', 'nickname']),
    authorName: pickStr(n?.user ?? {}, ['nickname', 'name']),
    url: pickStr(n, ['note_url', 'url']) || `https://www.xiaohongshu.com/explore/${noteId}`,
    publishTime,
    title: pickStr(n, ['title', 'display_title']) || '',
    caption: desc,
    hook: '',
    views: pickNum(it, ['viewed_count', 'view_count', 'views']),
    likes: pickNum(it, ['liked_count', 'like_count', 'likes']),
    comments: pickNum(it, ['comment_count', 'comments']),
    shares: pickNum(it, ['share_count', 'share_count']),
    favorites: pickNum(it, ['collected_count', 'collect_count', 'favorites']),
    durationSec: Number(n?.video_info?.duration ?? n?.duration ?? 15),
    structure: '',
    source: '',
    bgm: '',
    tags: [...tags, ...extractTags(desc)],
    isVideo,
    mediaType: isVideo ? 'video' : 'image',
    mediaUrl: videoUrl ?? cover ?? undefined,
  };
}
