// 全局导航 store：让任意页面都能切换左侧菜单 Tab（不依赖 props 层层传递），
// 并承载「从视频库跳转爆款拆解页时预选某条视频」的跨页目标。
import { useSyncExternalStore } from "react";

export type NavTab =
  | "dashboard"
  | "competitor"
  | "videodb"
  | "trend"
  | "viral"
  | "voiceover"
  | "conversion"
  | "own"
  | "ai"
  | "image"
  | "publish"
  | "settings";

let _navigate: ((t: NavTab) => void) | null = null;

// 爆款拆解页的预选视频目标；nonce 用于区分「同一视频被点了两次」的情况。
let _target = { id: "", nonce: 0 };
const listeners = new Set<() => void>();

/** App 挂载时注册真正的 navigate 实现 */
export function registerNavigate(fn: (t: NavTab) => void): void {
  _navigate = fn;
}

/** 任意页面调用：切换到指定 Tab */
export function navigateTo(t: NavTab): void {
  _navigate?.(t);
}

/** 设置爆款拆解页待拆解的视频（跳转前调用） */
export function setViralTarget(id: string): void {
  _target = { id, nonce: _target.nonce + 1 };
  listeners.forEach((l) => l());
}

/** 清除爆款拆解页的预选目标（跳转消费后调用，避免菜单重新进入时再次自动触发） */
export function clearViralTarget(): void {
  if (!_target.id) return;
  _target = { id: "", nonce: _target.nonce + 1 };
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function getSnapshot() {
  return _target;
}

/** 订阅爆款拆解页的预选视频目标 */
export function useViralTarget() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
