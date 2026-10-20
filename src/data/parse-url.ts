// 从各平台链接（视频 / 账号主页）中识别平台（供「账号分析 / 视频分析」自动判别平台复用）。
// 设计：纯函数、无网络依赖，渲染进程与主进程均可安全导入。
// 支持：TikTok / Instagram / YouTube / Facebook / 小红书(xiaohongshu) / 微信视频号(wechat_channels)。
// Facebook / 小红书 / 微信视频号 的接口均以「完整链接」为入参，故这里直接返回整条 URL 作为 videoId。
import { Platform } from "../shared/types";

export interface ParsedVideoUrl {
  platform: Platform;
  videoId: string; // 已去除平台前缀（如 TikTok 的 tiktok_），可直接传给各 Provider 的 fetchOneVideo
  cleanUrl: string;
}

interface PlatformRule {
  platform: Platform;
  test: RegExp;
  extract: (url: string) => string | null;
}

const RULES: PlatformRule[] = [
  {
    // Facebook 链接仍可识别，以便业务入口给出明确的不支持提示。
    platform: "facebook",
    test: /facebook\./i,
    extract: (u) => u,
  },
  {
    platform: "tiktok",
    test: /tiktok\./i,
    extract: (u) => {
      const m = u.match(/tiktok\.com\/(?:@[\w.-]+|.*?)\/video\/(\d+)/i);
      return m ? m[1] : null;
    },
  },
  {
    platform: "instagram",
    test: /instagram\./i,
    extract: (u) => {
      const m = u.match(
        /instagram\.com\/(?:reels?|p|tv|share)\/([A-Za-z0-9_-]+)/i,
      );
      return m ? m[1] : null;
    },
  },
  {
    platform: "youtube",
    test: /(youtube\.com|youtu\.be)/i,
    extract: (u) => {
      const m =
        u.match(/[?&]v=([^&]+)/i) ||
        u.match(/youtu\.be\/([^/?#&]+)/i) ||
        u.match(/youtube\.com\/(?:shorts|embed|v)\/([^/?#&]+)/i);
      return m ? m[1] : null;
    },
  },
  {
    // 小红书：App V2 接口支持 user_id / share_text（整条链接）二选一，
    // 故直接返回整条 URL 作为 videoId，由 Provider 决定用 note_id 还是 share_text。
    platform: "xiaohongshu",
    test: /(xiaohongshu\.com|xhslink\.com|xhslink\.cn)/i,
    extract: (u) => u,
  },
  {
    // 微信视频号：fetch_video_detail / fetch_user_profile 等接口支持 share_url / channel_id，
    // 故直接返回整条 URL，由 Provider 解析 channel_id 或 share_url。
    platform: "wechat_channels",
    test: /(weixin\.qq\.com|channels\.weixin\.qq\.com)/i,
    extract: (u) => u,
  },
];

/**
 * 解析视频链接，返回 { 平台, 视频ID, 原链接 }。
 * - 无法识别平台（如未知域名）→ 返回 null
 * - 已知平台但提取不到 videoId（如主页链接）→ 仍返回该平台、videoId 为空字符串，由调用方判断是否拦截
 */
export function parseVideoUrl(raw: string): ParsedVideoUrl | null {
  const u = (raw || "").trim();
  if (!u) return null;
  for (const rule of RULES) {
    if (rule.test.test(u)) {
      const videoId = rule.extract(u) ?? "";
      return { platform: rule.platform, videoId, cleanUrl: u };
    }
  }
  return null;
}
