# 页面实现过程统计

本文档按 `src/renderer/pages` 页面入口统计实际调用的 IPC API、下游接口和模型。

## 模型与基础服务

- **TiKhub API**：账号、视频、趋势、Hashtag、评论等社媒数据。基地址由 `TIKHUB_BASE_URL` 配置，默认 `https://api.tikhub.io`。
- **视频分析大模型**：`MiniMaxClient` 的 OpenAI 兼容 Chat Completions。模型由 `VIDEO_MODEL` / 设置页 `llmModel` 配置，默认 `gemini-3.1-pro-preview`（代码中的统一任务注释称 MiniMax-M3）。
- **客服/口播模型**：`SOP_BASE_URL/chat/completions`，模型由 `SOP_MODEL` / 设置页 `sopModel` 配置，默认 `doubao-seed-2-0-lite-260215`。
- **图片模型**：`IMAGE_BASE_URL` 的图片生成/编辑接口，模型由 `IMAGE_MODEL` 配置，默认 `gpt-image-2`。
- **Whisper**：口播转写使用本地 Whisper（优先打包的 whisper.cpp，否则调用本机 `openai-whisper`），不是远程大模型。
- **本地能力**：Electron 主进程中的 yt-dlp、ffmpeg、MySQL 缓存、腾讯 COS；这些不是大模型，但会出现在页面流程中。

## 页面明细

| 页面 | 页面侧 IPC/API 调用 | 下游接口/模型 | 实现过程 |
|---|---|---|---|
| 总览仪表盘 `Dashboard` | `getVideoDb`、对全部平台调用 `fetchTrends` | TiKhub 趋势接口；无大模型 | 读取本地视频库，同时并行拉取各平台趋势，计算总览指标 |
| 竞对账号分析 `CompetitorAnalysis` | `getConfig`、`getJson/setJson`、`queryCache/saveCache`、`fetchAccount`、`fetchVideos`、`runAiTask(analyzeAccount)` | TiKhub 用户资料/用户视频；视频分析大模型 `analyzeAccount` | 先查竞对缓存；未命中时拉账号和视频，再用视频大模型生成账号画像/分析并写回缓存 |
| 竞对视频数据库 `VideoDatabase` | `getConfig/getVideoDb`、`fetchVideos`、`runAiTask(analyzeImage)`、`downloadVideo`、`replaceMediaWithLocal`、`importVideos/deleteVideos` | TiKhub 用户视频；视频分析大模型；yt-dlp/本地文件 | 抓取并持久化视频，支持下载/导入/删除；单条图文内容解析由视频分析模型完成 |
| 热点与 Tag 追踪 `TrendTracking` | `fetchTrendData`、`searchVideos` | TiKhub 趋势、热门搜索词、Hashtag、关键词搜索；无大模型 | 按平台/关键词拉取趋势和标签，必要时用搜索视频做辅助展示；热点数据可走 MySQL 缓存 |
| 爆款视频拆解 `ViralBreakdown` | `getVideoDb`、`getJson/setJson`、`queryCache/saveCache`、`fetchVideoDetail`、`resolveMediaUrl`、`runAiTask(breakdownViralVideo)`、`updateVideoHook` | TiKhub 视频详情/评论；yt-dlp 直链解析；视频分析大模型 | 读取本地或链接视频，获取详情、媒体和评论，调用多模态视频模型拆解并缓存结果 |
| 口播文案抓取 `VoiceoverCapture` | `getVideoDb`、`queryCache/saveCache`、`extractVoiceover` | yt-dlp/音频提取 + 本地 Whisper 转写 + SOP 对话模型 `analyzeVoiceover` | 提取音频并转写全文，再由 SOP 模型输出 Hook、卖点、CTA、脚本结构，结果缓存 |
| 高转化分析 `ConversionAnalysis` | `getVideoDb`、`getConfig`、`fetchVideoDetail`、`runAiTask(analyzeConversionVideo)` | TiKhub 视频详情/评论；视频分析大模型 | 从视频库选择视频，补齐详情和评论后生成转化要素分析 |
| 自身账号分析 `OwnAccount` | `getConfig`、`getJson/setJson`、`queryCache/saveCache`、`fetchAccount`、`fetchVideos`、`runAiTask(analyzeOwnAccount)` | TiKhub 用户资料/用户视频；视频分析大模型 | 账号数据优先读缓存；未命中时抓取资料和视频并生成自身账号分析 |
| AI 批量视频剪辑 `AiEditing` | `getConfig/getVideoDb`、`pickVideoFiles`、`generateEditPlan`、`renderEditPlan`、`openPath` | 视频分析大模型（剪辑方案，`generateEditPlansSafe`）；ffmpeg | 选择视频素材，模型生成多平台剪辑方案，再由 ffmpeg 渲染成片并打开输出目录 |
| AI 生图 `AiImage` | `getConfig`、`generateImage`、`editImage`、`getJson/setJson`、模板 CRUD、分类 CRUD、`uploadTemplateImage` | 图片生成/编辑模型（默认 `gpt-image-2`）；MySQL 模板库；腾讯 COS 图片上传 | 支持文生图、参考图编辑、历史记录；模板图片上传 COS，模板和分类保存 MySQL |
| 客服 SOP 语料库 `CustomerSop` | `list/create/update/deleteSopReply`、`generateSopReply`、`getJson/setJson` | SOP 对话模型（默认 `doubao-seed-2-0-lite-260215`） | 管理可复用客服话术；输入客户问题后调用对话模型生成英文回复，系统提示词本地持久化 |
| 设置 `Settings` | `saveConfig`、`resetConfig` | 不直接调用外部服务 | 修改 TiKhub、视频模型、SOP 模型、图片模型、MySQL/COS 等配置并持久化 |

## 平台接口映射

页面调用的 `fetchAccount/fetchVideos/fetchVideoDetail/searchVideos/fetchTrendData` 会根据平台路由到 `src/data/providers`：TikTok、YouTube、Instagram、小红书、微信视频号。具体 TiKhub endpoint 由 provider 选择，统一在 `src/data/tikhub-client.ts` 记录 trace。

## 统一调用链

```text
React 页面
  -> window.api (preload)
  -> ipcMain.handle (src/main/main.ts)
  -> DataService / MiniMaxClient / SOP / Image / 本地工具
  -> TiKhub、模型服务、MySQL/COS、yt-dlp、Whisper、ffmpeg
```

实时工作流面板通过 `progress`、`aichunk`、`batchProgress` IPC 事件展示 TiKhub 请求、模型推理和批处理进度。
