// 平台数据提供者统一接口
import { HashtagStat, Platform, SocialAccount, SocialVideo, TrendTopic, VideoComment } from '../shared/types';

export interface SocialProvider {
  platform: Platform;
  /** 通过账号链接抓取账号档案 */
  fetchAccount(accountUrl: string): Promise<SocialAccount>;
  /** 抓取账号下的视频/帖子列表 */
  fetchVideos(accountUrl: string, limit: number): Promise<SocialVideo[]>;
  /** 抓取热点趋势（关键词/话题）。accounts 仅供 Instagram 使用：以指定参考账号的 Reels 聚合（TiKhub 无 IG 搜索/hashtag 接口） */
  fetchTrends(accounts?: string[]): Promise<TrendTopic[]>;
  /** 抓取/计算 Hashtag 排行。accounts 同上 */
  fetchHashtags(accounts?: string[]): Promise<HashtagStat[]>;
  /** 单条视频详情（无水印直链 + 元数据）：用于模块二/四/五的多模态解析 */
  fetchOneVideo(videoId: string): Promise<SocialVideo | null>;
  /** 单条视频评论（Top N）：用于模块四/五用户诉求分析 */
  fetchVideoComments(videoId: string): Promise<VideoComment[]>;
  /** 关键词搜索视频：用于模块三热点追踪（其余平台兜底） */
  searchVideos(keyword: string): Promise<SocialVideo[]>;
  /** Hashtag 详情（官方热度/播放）：用于模块三 Tag 排行（不支持时返回 null） */
  fetchHashtagDetail?(keyword: string): Promise<HashtagStat | null>;
}
