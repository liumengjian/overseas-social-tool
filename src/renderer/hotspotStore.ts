// 热点 / Tag 数据全局缓存与后台预拉取
// 一进入应用即在后台调用所有平台的热点相关接口（fetchTrendData），把结果缓存到这里。
// 「热点与 Tag 追踪」页面直接读取本缓存，切换平台不再重复请求；「重新获取数据」按钮强制刷新当前平台。
// 预拉取会通过 workflowStore 发起工作流，使「实时工作流」面板能看到进度。
import { useSyncExternalStore } from 'react';
import type { HashtagStat, Platform, TrendTopic } from '../shared/types';
import { startWorkflow, finishWorkflow } from './workflowStore';

export interface TrendCache {
  loading: boolean;
  loadedAt: number | null;
  trends: TrendTopic[];
  hashtags: HashtagStat[];
  error?: string;
}

const PLATFORMS: Platform[] = ['tiktok', 'instagram', 'youtube', 'facebook', 'twitter'];

function emptyCache(): TrendCache {
  return { loading: false, loadedAt: null, trends: [], hashtags: [] };
}

// 用 let + 重新赋值保证 useSyncExternalStore 能检测到引用变化
let cache: Record<string, TrendCache> = {};
const listeners = new Set<() => void>();
const loadingSet = new Set<Platform>();

function emit() {
  listeners.forEach((l) => l());
}

async function fetchOne(platform: Platform, accounts?: string[], runId?: string) {
  if (loadingSet.has(platform)) return;
  loadingSet.add(platform);
  cache = { ...cache, [platform]: { ...(cache[platform] || emptyCache()), loading: true } };
  emit();
  try {
    const res = await window.api.fetchTrendData({ platform, accounts, runId });
    cache = {
      ...cache,
      [platform]: {
        loading: false,
        loadedAt: Date.now(),
        trends: res?.trends ?? [],
        hashtags: res?.hashtags ?? [],
      },
    };
  } catch (e: any) {
    cache = {
      ...cache,
      [platform]: { loading: false, loadedAt: Date.now(), trends: [], hashtags: [], error: e?.message ?? String(e) },
    };
  } finally {
    loadingSet.delete(platform);
    emit();
  }
}

/** 应用启动时调用：后台拉取所有平台热点（已加载/加载中的平台会跳过），并在工作流面板展示进度 */
export function prefetchAll(accounts?: string[]) {
  // 筛选需要拉取的平台
  const toFetch = PLATFORMS.filter((p) => {
    const c = cache[p];
    return !c?.loadedAt && !loadingSet.has(p);
  });
  if (!toFetch.length) return;

  // 启动工作流，让面板显示预拉取进度
  const rid = startWorkflow('热点数据预拉取');
  const ps = toFetch.map((p) => fetchOne(p, p === 'instagram' ? accounts : undefined, rid));
  // 全部完成后结束工作流（无论成功失败）
  Promise.allSettled(ps).finally(() => finishWorkflow());
}

/** 强制刷新某一平台（用于「重新获取数据」按钮）。返回 Promise 便于 UI 等待。 */
export function refresh(platform: Platform, accounts?: string[]): Promise<void> {
  return fetchOne(platform, accounts);
}

/** 仅在「尚未加载且未在加载中」时拉取一次（供页面切换时兜底，避免与后台预拉取重复） */
export function ensureLoaded(platform: Platform, accounts?: string[]) {
  const c = cache[platform];
  if (!c?.loadedAt && !loadingSet.has(platform)) {
    fetchOne(platform, accounts);
  }
}

export function getTrendCache(platform: Platform): TrendCache {
  return cache[platform] || emptyCache();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function getSnapshot() {
  return cache;
}

/** 订阅某平台的热点缓存（随后台预拉取 / 手动刷新自动更新） */
export function useTrendCache(platform: Platform): TrendCache {
  const all = useSyncExternalStore(subscribe, getSnapshot);
  return all[platform] || emptyCache();
}
