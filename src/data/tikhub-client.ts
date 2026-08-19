// TiKhub 通用 HTTP 客户端
// 文档: https://api.tikhub.io/  (大陆: https://api.tikhub.dev)
// 鉴权: Authorization: Bearer <token>
import { AppConfig } from '../shared/types';
import { trace } from '../shared/trace';

// 接口路径 -> 中文名（用于「处理流程」面板展示「调用了哪个 TiKhub 接口」）
const ENDPOINT_LABELS: Record<string, string> = {
  '/api/v1/tiktok/app/v3/handler_user_profile': '获取用户资料（App V3）',
  '/api/v1/tiktok/web/fetch_user_profile': '获取用户资料（Web）',
  '/api/v1/tiktok/app/v3/fetch_user_post_videos': '获取用户发布视频',
  '/api/v1/tiktok/web/fetch_user_post': '获取用户发布视频（Web 回退）',
  '/api/v1/tiktok/app/v3/fetch_one_video': '获取单条视频详情',
  '/api/v1/tiktok/app/v3/fetch_video_comments': '获取视频评论',
  '/api/v1/tiktok/app/v3/fetch_general_search_result': '关键词搜索视频',
  '/api/v1/tiktok/web/fetch_general_search_result': '关键词搜索视频（Web 回退）',
  '/api/v1/tiktok/web/fetch_hashtag_detail': '获取 Hashtag 详情',
  '/api/v1/tiktok/web/fetch_trending_post': '获取热门视频',
  '/api/v1/tiktok/web/fetch_trending_searchwords': '获取热门搜索词',
  // YouTube（Web V2，已实测可用）
  '/api/v1/youtube/web_v2/get_general_search_v2': 'YouTube 关键词搜索',
  '/api/v1/youtube/web_v2/get_channel_videos': 'YouTube 频道视频',
  '/api/v1/youtube/web_v2/get_video_info': 'YouTube 视频详情',
  // Instagram（V2，已实测可用）
  '/api/v1/instagram/v2/fetch_user_info': 'Instagram 用户资料',
  '/api/v1/instagram/v2/fetch_user_reels': 'Instagram Reels',
  // Twitter / X（Web，已实测可用）
  '/api/v1/twitter/web/fetch_trending': 'Twitter 热门趋势',
  '/api/v1/twitter/web/fetch_user_profile': 'Twitter 用户资料',
  '/api/v1/twitter/web/fetch_user_media': 'Twitter 用户媒体',
};

export class TikHubClient {
  /**
   * 当前活动的取消信号（主进程 withProgress 设置/清空）。
   * 工作流为顺序执行（同一时刻仅一个请求），故共享单个信号是安全的。
   */
  static activeSignal?: AbortSignal;

  // 持有 AppConfig 引用、调用时实时读取，使「设置」页保存后立即生效（无需重启）。
  private cfg: AppConfig;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
  }

  get isAuthed(): boolean {
    return (this.cfg.tikhubApiToken ?? '').trim().length > 0;
  }

  /**
   * 发起 GET 请求
   * @param path 形如 /api/v1/tiktok/web/fetch_user_profile
   * @param params query 参数
   * @param signal 可选取消信号：优先使用传入的 signal，否则用全局活动信号
   */
  async get<T>(path: string, params: Record<string, string | number> = {}, signal?: AbortSignal): Promise<T> {
    const baseUrl = (this.cfg.tikhubBaseUrl ?? 'https://api.tikhub.io').replace(/\/$/, '');
    const token = this.cfg.tikhubApiToken ?? '';
    const url = new URL(baseUrl + path);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const endpoint = url.toString();
    const label = `TiKhub 接口：${ENDPOINT_LABELS[path] ?? path}`;
    const start = Date.now();
    let status = -1;
    let ok = false;
    let raw = '';
    try {
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: signal ?? TikHubClient.activeSignal,
      });
      status = res.status;
      ok = res.ok;
      raw = await res.text();
      if (!res.ok) {
        throw new Error(friendlyTikHubError(path, status, raw));
      }
      trace.add({
        kind: 'tikhub',
        title: label,
        endpoint,
        method: 'GET',
        params: { ...params },
        status,
        ok: true,
        durationMs: Date.now() - start,
        summary: summarizeTikHub(raw),
        raw: raw.length > 3000 ? `${raw.slice(0, 3000)}\n…(已截断)` : raw,
      });
      return JSON.parse(raw) as T;
    } catch (e: any) {
      // 主动取消：不追加失败 trace（弹窗已进入「已取消」状态）
      if (signal?.aborted || e?.name === 'AbortError') throw new Error('请求已取消');
      trace.add({
        kind: 'tikhub',
        title: label,
        endpoint,
        method: 'GET',
        params: { ...params },
        status,
        ok: false,
        durationMs: Date.now() - start,
        error: e?.message ?? String(e),
        raw: raw ? (raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw) : undefined,
      });
      throw e;
    }
  }
}

/** 从 TiKhub 原始响应中提取一句摘要：调用了什么、返回了多少条 */

/** 把 TiKhub 的 HTTP 错误翻译成清晰中文，便于前端直接展示「为什么失败」 */
function friendlyTikHubError(path: string, status: number, raw: string): string {
  let msg = '';
  try {
    const j = JSON.parse(raw);
    msg = j?.error?.message || j?.message || j?.detail?.message || '';
  } catch {
    /* 非 JSON 响应，忽略 */
  }
  if (status === 402) {
    return `TiKhub 余额不足：${msg || '该接口为付费接口，当前账户免费额度/余额为 0'}。请到 https://tikhub.io 充值或领取免费额度后重试。（接口：${path}）`;
  }
  if (status === 401) {
    return `TiKhub 鉴权失败（401）：${msg || 'API 令牌无效或未授权'}。请检查 .env 的 TIKHUB_API_TOKEN。`;
  }
  if (status === 404) {
    return `TiKhub 接口不存在（404）：${path}。请检查端点路径与参数。`;
  }
  if (status === 422) {
    return `TiKhub 请求参数错误（422）：${msg || raw.slice(0, 120)}（接口：${path}）`;
  }
  if (status === 429) {
    return `TiKhub 请求过于频繁（429，触发限流）。请稍后重试。`;
  }
  return `TiKhub ${path} 失败: ${status} ${raw.slice(0, 200)}`;
}

function summarizeTikHub(raw: string): string {
  try {
    const data = JSON.parse(raw);
    const d = data?.data ?? data;
    if (Array.isArray(d?.videos) || Array.isArray(d?.aweme_list) || Array.isArray(d?.item_list) || Array.isArray(d?.comments)) {
      const list = d?.videos ?? d?.aweme_list ?? d?.item_list ?? d?.comments;
      return `返回 ${list.length} 条数据`;
    }
    if (d?.aweme_detail || d?.user || d?.author || data?.user || data?.author) return '返回用户/视频资料';
    if (typeof data?.code === 'number') return `返回 code=${data.code}`;
    if (data?.data && typeof data.data === 'object' && !Array.isArray(data.data)) return '返回数据对象（见原始响应）';
    return '返回数据（见原始响应）';
  } catch {
    return '返回非 JSON 响应';
  }
}

/** 从各类平台账号链接中提取用户名 / uniqueId / secUid */
export function parseAccountUrl(platform: import('../shared/types').Platform, url: string): { uniqueId?: string; secUid?: string } {
  const u = url.trim();
  // TikTok: https://www.tiktok.com/@username 或 /tiktok/@secUid
  if (platform === 'tiktok') {
    const m = u.match(/tiktok\.com\/@([^\/\?]+)/);
    if (m) return { uniqueId: decodeURIComponent(m[1]) };
    const s = u.match(/[?&]secUid=([^&]+)/);
    if (s) return { secUid: s[1] };
  }
  // Instagram: https://www.instagram.com/username/
  if (platform === 'instagram') {
    const m = u.match(/instagram\.com\/([^\/\?\&]+)/);
    if (m) return { uniqueId: decodeURIComponent(m[1]) };
  }
  // YouTube: https://www.youtube.com/@handle 或 /channel/ID
  if (platform === 'youtube') {
    const m = u.match(/youtube\.com\/@([^\/\?\&]+)/);
    if (m) return { uniqueId: decodeURIComponent(m[1]) };
    const c = u.match(/youtube\.com\/channel\/([^\/\?\&]+)/);
    if (c) return { uniqueId: c[1] };
  }
  // Facebook: https://www.facebook.com/PageName
  if (platform === 'facebook') {
    const m = u.match(/facebook\.com\/([^\/\?\&]+)/);
    if (m) return { uniqueId: decodeURIComponent(m[1]) };
  }
  return {};
}
