// 云端缓存（MySQL）的缓存键构造与日期工具
// 缓存键规则统一在这里维护，保证渲染层（算 key 发查询）与主进程（写库/读库）一致：
//   - 热点：hotspot:{platform}:{query}:{yyyy-MM-dd}（当天有效）
//   - 账号分析：account:{platform}:{账号url}（默认 7 天，天数可配置；0=禁用）
//   - 爆款拆解：viral:{platform}:{视频原url}（永久，不因拆解过而重复扣费）
import { Platform } from "./types";

/** 本地时区 yyyy-MM-dd（MySQL DATE 同格式，避免 UTC 偏移导致跨天判断错位） */
export function toDateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 热点缓存键：当天日期参与，第二天自然失效 */
export function hotspotCacheKey(
  platform: Platform,
  dateKey: string = toDateKey(),
  keyword?: string,
): string {
  // 推荐流平台按查询词隔离缓存；传空查询时统一使用 "-"，保持键格式稳定且可读。
  const query = encodeURIComponent((keyword ?? "").trim() || "-");
  return `hotspot:${platform}:${query}:${dateKey}`;
}

/** 账号分析缓存键：以账号 url 为维度（同一账号不同入口粘贴的 url 尽量归一化）。
 *  kind 区分「自身账号分析(own) / 竞对账号分析(cmp)」——两模块缓存的数据结构不同，
 *  共用同一 key 会导致缓存错位（自身存 {account,ownVideos,analysis}，竞对存 SocialAccount）。 */
export function accountCacheKey(
  platform: Platform,
  url: string,
  kind: "own" | "cmp" = "own",
): string {
  return `account:${kind}:${platform}:${normalizeUrl(url)}`;
}

/** 爆款拆解缓存键：以视频原 url 为维度 */
export function viralCacheKey(platform: Platform, url: string): string {
  return `viral:${platform}:${normalizeUrl(url)}`;
}

export function voiceoverCacheKey(platform: Platform, url: string): string {
  return `voiceover:${platform}:${normalizeUrl(url)}`;
}

/** 归一化 url：去首尾空白与末尾斜杠（保留 query，避免误伤签名参数） */
function normalizeUrl(url: string): string {
  return (url ?? "").trim().replace(/\/+$/, "");
}
