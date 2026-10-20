const VIDEO_DB_UPDATED = "video-db-updated";

/** 通知已挂载但当前隐藏的下游模块重新读取视频库。 */
export function notifyVideoDbUpdated(): void {
  window.dispatchEvent(new Event(VIDEO_DB_UPDATED));
}

/** 订阅视频库变化，返回取消订阅函数。 */
export function onVideoDbUpdated(listener: () => void): () => void {
  window.addEventListener(VIDEO_DB_UPDATED, listener);
  return () => window.removeEventListener(VIDEO_DB_UPDATED, listener);
}
