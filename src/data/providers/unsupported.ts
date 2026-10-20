// 平台支持情况集中管理。Facebook 当前没有可用的数据源，禁止用于业务数据抓取和分析。
import { Platform } from '../../shared/types';
import { SocialProvider } from '../types';
import { HashtagStat, SocialAccount, SocialVideo, TrendTopic, VideoComment } from '../../shared/types';

export const UNSUPPORTED_PLATFORMS: Platform[] = ['facebook'];

/** 返回某平台不支持时的说明文案；支持则返回 null */
export function platformUnsupportedMessage(platform: Platform): string | null {
  return platform === 'facebook' ? '暂不支持 Facebook 平台的数据抓取与业务分析。' : null;
}

export class UnsupportedFacebookProvider implements SocialProvider {
  platform: Platform = 'facebook';

  private unsupported(): never {
    throw new Error('暂不支持 Facebook 平台的数据抓取与业务分析。');
  }

  fetchAccount(_accountUrl: string): Promise<SocialAccount> { return Promise.reject(this.unsupported()); }
  fetchVideos(_accountUrl: string, _limit: number): Promise<SocialVideo[]> { return Promise.reject(this.unsupported()); }
  fetchTrends(_keyword?: string): Promise<TrendTopic[]> { return Promise.reject(this.unsupported()); }
  fetchHashtags(_keyword?: string): Promise<HashtagStat[]> { return Promise.reject(this.unsupported()); }
  fetchOneVideo(_videoId: string): Promise<SocialVideo | null> { return Promise.reject(this.unsupported()); }
  fetchVideoComments(_videoId: string): Promise<VideoComment[]> { return Promise.reject(this.unsupported()); }
  searchVideos(_keyword: string): Promise<SocialVideo[]> { return Promise.reject(this.unsupported()); }
}
