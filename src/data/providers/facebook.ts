// Facebook 数据提供者
// 重要：经实测，TiKhub 当前【不提供任何 Facebook 数据接口】——
// /api/v1/facebook/web/* 与 /api/v1/facebook/app/* 下所有路径均返回 404（Not Found，即路由不存在）。
// 因此本 provider 不调用任何 Facebook 接口，仅在用户显式使用时给出明确「平台不受支持」提示，
// 避免产生无意义的 404 请求。热点 / Tag 模块的 Facebook 标签页也会显示对应说明。
import { SocialProvider } from '../types';
import { AppConfig, Platform, SocialAccount, SocialVideo, TrendTopic, HashtagStat } from '../../shared/types';

const UNSUPPORTED = 'TiKhub 当前未提供 Facebook 数据接口（已确认 api.tikhub.io 下所有 facebook/* 路径均 404），本工具暂不支持 Facebook。';

export class FacebookProvider implements SocialProvider {
  platform: Platform = 'facebook';

  constructor(_cfg: AppConfig) {}

  async fetchAccount(_accountUrl: string): Promise<SocialAccount> {
    throw new Error(UNSUPPORTED);
  }
  async fetchVideos(_accountUrl: string, _limit: number): Promise<SocialVideo[]> {
    throw new Error(UNSUPPORTED);
  }
  // 热点 / Tag 追踪：无接口可用，返回空（不发起 404 请求），由页面显示「平台不支持」说明
  async fetchTrends(_accounts?: string[]): Promise<TrendTopic[]> { return []; }
  async fetchHashtags(_accounts?: string[]): Promise<HashtagStat[]> { return []; }
  async searchVideos(_keyword: string): Promise<SocialVideo[]> { return []; }
  async fetchOneVideo(_videoId: string): Promise<SocialVideo | null> { return null; }
  async fetchVideoComments(_videoId: string): Promise<{ text: string; likes: number }[]> { return []; }
  async fetchHashtagDetail(_keyword: string): Promise<HashtagStat | null> { return null; }
}

export const FACEBOOK_UNSUPPORTED_MESSAGE = UNSUPPORTED;
