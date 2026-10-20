import { IpcApi } from '../shared/ipc';

declare global {
  interface Window {
    api: IpcApi;
  }

  // 由 vite.config 的 define 在构建期注入的布尔开关（仅表示「是否配置了令牌」，不含密钥值）
  const __TIKHUB_CONFIGURED__: boolean;
  const __VIDEO_CONFIGURED__: boolean;
}

export {};
