// 预加载脚本：通过 contextBridge 暴露类型安全的 IPC 接口给渲染进程
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, IpcApi, ProgressEvent, AiChunkEvent, BatchProgressEvent } from '../shared/ipc';

const api: IpcApi = {
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.getConfig),
  fetchAccount: (args) => ipcRenderer.invoke(IPC_CHANNELS.fetchAccount, args),
  fetchVideos: (args) => ipcRenderer.invoke(IPC_CHANNELS.fetchVideos, args),
  getVideoDb: () => ipcRenderer.invoke(IPC_CHANNELS.getVideoDb),
  fetchTrends: (args) => ipcRenderer.invoke(IPC_CHANNELS.fetchTrends, args),
  fetchHashtags: (args) => ipcRenderer.invoke(IPC_CHANNELS.fetchHashtags, args),
  fetchTrendData: (args) => ipcRenderer.invoke(IPC_CHANNELS.fetchTrendData, args),
  fetchVideoDetail: (args) => ipcRenderer.invoke(IPC_CHANNELS.fetchVideoDetail, args),
  searchVideos: (args) => ipcRenderer.invoke(IPC_CHANNELS.searchVideos, args),
  importVideos: (videos) => ipcRenderer.invoke(IPC_CHANNELS.importVideos, videos),
  replaceMediaWithLocal: (args) => ipcRenderer.invoke(IPC_CHANNELS.replaceMediaWithLocal, args),
  deleteVideos: (args) => ipcRenderer.invoke(IPC_CHANNELS.deleteVideos, args),
  runAiTask: (args) => ipcRenderer.invoke(IPC_CHANNELS.runAiTask, args),
  analyzeVideoSafe: (args) => ipcRenderer.invoke(IPC_CHANNELS.analyzeVideoSafe, args),
  generateEditPlan: (materials, runId) => ipcRenderer.invoke(IPC_CHANNELS.generateEditPlan, materials, runId),
  downloadVideo: (args) => ipcRenderer.invoke(IPC_CHANNELS.downloadVideo, args),
  pickVideoFiles: () => ipcRenderer.invoke(IPC_CHANNELS.pickVideoFiles),
  renderEditPlan: (args) => ipcRenderer.invoke(IPC_CHANNELS.renderEditPlan, args),
  openPath: (p) => ipcRenderer.invoke(IPC_CHANNELS.openPath, p),
  saveConfig: (cfg) => ipcRenderer.invoke(IPC_CHANNELS.saveConfig, cfg),
  resetConfig: () => ipcRenderer.invoke(IPC_CHANNELS.resetConfig),
  getJson: (key) => ipcRenderer.invoke(IPC_CHANNELS.getJson, key),
  setJson: (key, value) => ipcRenderer.invoke(IPC_CHANNELS.setJson, key, value),
  cancelRun: (runId) => ipcRenderer.invoke(IPC_CHANNELS.cancelRun, runId),
  onProgress: (cb: (e: ProgressEvent) => void) => {
    const handler = (_e: unknown, e: ProgressEvent) => cb(e);
    ipcRenderer.on(IPC_CHANNELS.progress, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.progress, handler);
  },
  onAiChunk: (cb: (e: AiChunkEvent) => void) => {
    const handler = (_e: unknown, e: AiChunkEvent) => cb(e);
    ipcRenderer.on(IPC_CHANNELS.aichunk, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.aichunk, handler);
  },
  onBatchProgress: (cb: (e: BatchProgressEvent) => void) => {
    const handler = (_e: unknown, e: BatchProgressEvent) => cb(e);
    ipcRenderer.on(IPC_CHANNELS.batchProgress, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.batchProgress, handler);
  },
};

contextBridge.exposeInMainWorld('api', api);
