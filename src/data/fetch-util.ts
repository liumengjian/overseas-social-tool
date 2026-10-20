// 带超时的 fetch 信号工具：合并「外部取消信号」与「超时」，供各数据客户端使用。
// 背景：此前客户端 fetch 无超时，若上游 API 卡住，promise 永不 settle——
// 热点缓存会永远停在 loading，工作流队列也会被卡死的任务堵住（后续任务一直排队中）。
// 用法：
//   const fs = createFetchSignal(outerSignal, 30000);
//   try { await fetch(url, { signal: fs.signal }); ... }
//   catch (e) { if (fs.timedOut()) throw new Error('请求超时...'); ... }
//   finally { fs.cleanup(); }
export function createFetchSignal(
  outer?: AbortSignal,
  timeoutMs = 30000,
): { signal: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
  const ctrl = new AbortController();
  let flag = false;
  const timer = setTimeout(() => {
    flag = true;
    ctrl.abort();
  }, timeoutMs);
  const onOuter = () => ctrl.abort();
  if (outer && !outer.aborted) outer.addEventListener('abort', onOuter, { once: true });
  return {
    signal: ctrl.signal,
    timedOut: () => flag,
    cleanup: () => {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onOuter);
    },
  };
}
