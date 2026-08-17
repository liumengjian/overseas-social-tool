// 平台支持情况集中管理。
// TiKhub 实测：Facebook 全部路径 404（不提供接口）；Twitter 已接入真实接口（fetch_trending / fetch_user_profile / fetch_user_media）。
// 因此目前仅 Facebook 在所有模块中统一走「优雅降级」——不发起任何请求，页面展示明确说明。
import { Platform } from '../../shared/types';
import { FACEBOOK_UNSUPPORTED_MESSAGE } from './facebook';

/** TiKhub 不支持、应用内仅作「暂不支持」展示的平台 */
export const UNSUPPORTED_PLATFORMS: Platform[] = ['facebook'];

/** 返回某平台不支持时的说明文案；支持则返回 null */
export function platformUnsupportedMessage(platform: Platform): string | null {
  if (platform === 'facebook') return FACEBOOK_UNSUPPORTED_MESSAGE;
  return null;
}
