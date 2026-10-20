// 账号视频过滤：从「合并后的视频库」中筛出某个账号自己的视频。
// 背景：window.api.fetchVideos 返回的是合并后的整个视频库（含历史抓取的所有账号），
// 自身账号分析 / 竞对账号分析都必须用本函数按账号过滤，否则会把其它账号的视频混进来，
// 导致两个模块对同一账号的「高流量作品」不一致。
// 放在 shared/ 保持纯净（零 node/electron 依赖），渲染进程可安全导入。
import { Platform, SocialVideo } from "./types";

/**
 * 按账号过滤视频：平台一致，且 authorId / authorName 命中，或链接包含账号标识。
 * @param uniqueId 账号唯一标识（用户名 / handle / secUid）
 * @param name 账号显示名（昵称 / full_name），用于额外的作者名匹配
 */
export function filterAccountVideos(
  videos: SocialVideo[],
  platform: Platform,
  uniqueId?: string,
  name?: string,
): SocialVideo[] {
  const ids = new Set(
    [uniqueId, name].filter(
      (x): x is string => !!x && String(x).trim().length > 0,
    ),
  );
  if (ids.size === 0) return [];
  return videos.filter((v) => {
    if (v.platform !== platform) return false;
    for (const id of ids) {
      if (
        v.authorId === id ||
        v.authorName === id ||
        (v.url || "").includes(id)
      )
        return true;
    }
    return false;
  });
}
