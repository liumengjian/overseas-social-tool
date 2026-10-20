// 预加载脚本：通过 contextBridge 暴露类型安全的 IPC 接口给渲染进程
import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  IpcApi,
  ProgressEvent,
  AiChunkEvent,
  BatchProgressEvent,
} from "../shared/ipc";

const api: IpcApi = {
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.getConfig),
  generateImage: (args) => ipcRenderer.invoke(IPC_CHANNELS.generateImage, args),
  editImage: (args) => ipcRenderer.invoke(IPC_CHANNELS.editImage, args),
  fetchAccount: (args) => ipcRenderer.invoke(IPC_CHANNELS.fetchAccount, args),
  fetchVideos: (args) => ipcRenderer.invoke(IPC_CHANNELS.fetchVideos, args),
  fetchAccountVideos: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.fetchAccountVideos, args),
  getVideoDb: () => ipcRenderer.invoke(IPC_CHANNELS.getVideoDb),
  updateVideoHook: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateVideoHook, args),
  fetchTrends: (args) => ipcRenderer.invoke(IPC_CHANNELS.fetchTrends, args),
  fetchHashtags: (args) => ipcRenderer.invoke(IPC_CHANNELS.fetchHashtags, args),
  fetchTrendData: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.fetchTrendData, args),
  fetchVideoDetail: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.fetchVideoDetail, args),
  searchVideos: (args) => ipcRenderer.invoke(IPC_CHANNELS.searchVideos, args),
  importVideos: (videos) =>
    ipcRenderer.invoke(IPC_CHANNELS.importVideos, videos),
  replaceMediaWithLocal: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.replaceMediaWithLocal, args),
  deleteVideos: (args) => ipcRenderer.invoke(IPC_CHANNELS.deleteVideos, args),
  runAiTask: (args) => ipcRenderer.invoke(IPC_CHANNELS.runAiTask, args),
  analyzeVideoSafe: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.analyzeVideoSafe, args),
  generateEditPlan: (materials, options, runId) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.generateEditPlan,
      materials,
      options,
      runId,
    ),
  uploadVideoToCos: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.uploadVideoToCos, args),
  downloadVideo: (args) => ipcRenderer.invoke(IPC_CHANNELS.downloadVideo, args),
  pickVideoFiles: () => ipcRenderer.invoke(IPC_CHANNELS.pickVideoFiles),
  listFonts: () => ipcRenderer.invoke(IPC_CHANNELS.listFonts),
  pickFontFile: () => ipcRenderer.invoke(IPC_CHANNELS.pickFontFile),
  uploadFont: (args) => ipcRenderer.invoke(IPC_CHANNELS.uploadFont, args),
  deleteFont: (args) => ipcRenderer.invoke(IPC_CHANNELS.deleteFont, args),
  renderEditPlan: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.renderEditPlan, args),
  previewTts: (args) => ipcRenderer.invoke(IPC_CHANNELS.previewTts, args),
  generateSpeechAudio: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.generateSpeechAudio, args),
  openPath: (p) => ipcRenderer.invoke(IPC_CHANNELS.openPath, p),
  showItemInFolder: (p) => ipcRenderer.invoke(IPC_CHANNELS.showItemInFolder, p),
  saveConfig: (cfg) => ipcRenderer.invoke(IPC_CHANNELS.saveConfig, cfg),
  resetConfig: () => ipcRenderer.invoke(IPC_CHANNELS.resetConfig),
  getJson: (key) => ipcRenderer.invoke(IPC_CHANNELS.getJson, key),
  setJson: (key, value) => ipcRenderer.invoke(IPC_CHANNELS.setJson, key, value),
  listImageTemplateCategories: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listImageTemplateCategories),
  createImageTemplateCategory: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.createImageTemplateCategory, args),
  updateImageTemplateCategory: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateImageTemplateCategory, args),
  reorderImageTemplateCategories: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.reorderImageTemplateCategories, args),
  deleteImageTemplateCategory: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteImageTemplateCategory, args),
  listImageTemplates: () => ipcRenderer.invoke(IPC_CHANNELS.listImageTemplates),
  uploadTemplateImage: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.uploadTemplateImage, args),
  createImageTemplate: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.createImageTemplate, args),
  updateImageTemplate: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateImageTemplate, args),
  deleteImageTemplate: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteImageTemplate, args),
  generateSopReply: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.generateSopReply, args),
  listSopReplies: () => ipcRenderer.invoke(IPC_CHANNELS.listSopReplies),
  createSopReply: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.createSopReply, args),
  updateSopReply: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateSopReply, args),
  deleteSopReply: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteSopReply, args),
  cancelRun: (runId) => ipcRenderer.invoke(IPC_CHANNELS.cancelRun, runId),
  queryCache: (args) => ipcRenderer.invoke(IPC_CHANNELS.queryCache, args),
  saveCache: (args) => ipcRenderer.invoke(IPC_CHANNELS.saveCache, args),
  extractVoiceover: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.extractVoiceover, args),
  resolveMediaUrl: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.resolveMediaUrl, args),
  getTtsLocales: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getTtsLocales),
  getTtsVoicesByLocale: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.getTtsVoicesByLocale, args),
  syncTtsVoices: () =>
    ipcRenderer.invoke(IPC_CHANNELS.syncTtsVoices),
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
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.batchProgress, handler);
  },
};

contextBridge.exposeInMainWorld("api", api);
