# 海外社媒智能运营桌面工具

基于 **Electron + Vite + React + TypeScript** 的本地桌面应用，覆盖《海外社媒对接需求（初步）》中的 8 大模块。

## 功能模块

| # | 模块 | 说明 |
|---|------|------|
| 1 | 竞品账号智能分类 | 按平台/粉丝量/内容方向对竞品账号打标签并评分 |
| 2 | 视频数据库 | 抓取并落库竞品视频（播放/点赞/评论/转发/收藏），支持 CSV/JSON 导入 |
| 3 | 热点 / Tag 追踪 | 追踪话题与 Hashtag 热度趋势，识别增长型热点 |
| 4 | 爆款视频拆解 | 拆解高表现视频的内容结构（钩子/时长/标签/情绪） |
| 5 | 高转化分析 | 分析高转化视频的共性特征，输出可复用公式 |
| 6 | 自身账号对比 | 将自有账号与竞品基准对比，给出差距与建议 |
| 7 | AI 剪辑（真实渲染） | 选取真实素材（本地视频/视频库直链/手动链接），由视频解析大模型生成成片方案，再用 ffmpeg 按方案裁剪/缩放/拼接并可选烧录字幕，输出 mp4 |
| 8 | TikTok 客户承接 (CRM) | 私信线索管理、阶段流转与转化统计 |

## 技术栈

- **桌面壳**：Electron（主进程 + preload IPC 桥接）
- **UI**：React 18 + Vite 5
- **语言**：TypeScript（严格模式）
- **数据层**：可插拔适配器，默认对接 [TiKhub API](https://api.tikhub.io/)（TikTok / Instagram / YouTube / Facebook）；**未配置令牌时返回空容器（真正的空状态），不填充任何示例/演示数据**。所有列表初始为空，配置后拉取真实数据。

## 目录结构

```
overseas-social-tool/
├─ package.json            # 依赖与脚本（dev/build/electron/打包）
├─ vite.config.ts          # 渲染端（React）构建
├─ tsconfig.json           # 渲染端类型检查
├─ tsconfig.node.json      # 主进程编译到 dist-electron
├─ .env.example            # 配置模板（复制为 .env 填令牌）
├─ src/
│  ├─ main/                # Electron 主进程（窗口 / IPC）
│  ├─ preload/             # 安全暴露 window.api
│  ├─ renderer/            # React 界面（App + 8 个页面 + 组件）
│  ├─ shared/             # 跨进程类型与 IPC 契约
│  ├─ data/               # 数据层（TiKhub 适配器 + 本地持久化；无示例数据）
│  └─ analysis/           # 8 个业务分析模块（纯函数）
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

> 若 Electron 二进制下载慢，可先跳过二进制（仅影响首次启动 GUI，不影响代码与构建）：
> ```bash
> ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
> ```

### 2. 配置数据来源（可选）

复制 `.env.example` 为 `.env`，填入 TiKhub 令牌以使用真实平台数据：

```bash
cp .env.example .env
# 编辑 .env：
# TIKHUB_API_TOKEN=你的令牌
# TIKHUB_BASE_URL=https://api.tikhub.io
```

**不填令牌也能运行**：应用仅呈现「空状态」，所有列表为空，不会填充任何示例/演示数据；配置 TiKhub 令牌后才会拉取真实平台数据。

> 也可以在应用内「十一、设置」页直接填写 **TiKhub Key / Base URL** 与 **视频解析模型 Key / Base URL / 模型名**，保存后立即生效（写入本地 `app-config.json`，优先于 `.env` 默认值，无需重启）。「恢复默认」可回到 `.env` 配置。

### 2b. 配置视频解析大模型（AI 音视频分析）

在「视频库」页可对单条视频一键调用 OpenAI 兼容多模态模型（支持 text/image/video 输入）做语义/音视频分析。在 `.env` 中填入：

```bash
VIDEO_API_KEY=你的视频解析模型密钥
VIDEO_BASE_URL=https://api.new.bi/v1   # OpenAI 兼容端点
VIDEO_MODEL=gemini-3.1-pro-preview
```

- 真实抓取（TiKhub）且视频带可直链 `mediaUrl` 时，会把视频作为 `video_url` 多模态输入传给模型做真正的画面/声音理解；
- 未直链时，模型仅基于文本元数据（标题/文案/标签/数据指标）分析，结果面板会明确标注。
- 客户端代码位于 `src/data/minimax.ts`，调用在主进程（`src/main/main.ts` 的 `analyzeVideo` IPC），API Key 不暴露给渲染进程。

### 3. 开发模式（Web 预览，无需 Electron）

```bash
npm run dev
# 打开 http://localhost:5173
```

### 4. 以桌面应用运行

先构建再启动（也可直接用已打包产物）：

```bash
npm run build          # tsc 编译主进程 + vite 构建渲染端
npm run electron:start # 用 Electron 打开应用
```

或直接一条龙：

```bash
npm run electron:dev   # vite build && electron .
```

### 5. 打包为安装程序（Windows 为例）

```bash
npm run dist           # 产出 release/ 下的 nsis 安装包
```

其他平台目标可在 `package.json` 的 `build.win/target` 中调整（mac 用 `dmg`，linux 用 `AppImage`）。

## 数据接入说明

- 数据层位于 `src/data/`，通过 `providers/tiktok.ts` 等适配器对接 TiKhub。
- TiKhub 的 TikTok-Web-API 返回 tikwm 风格 `snake_case` 字段（`follower_count`/`play_count` 等），适配器已做兼容解析，保证粉丝/播放等指标正确入库。
- 想接自有爬虫 / 官方 API 时，只需新增一个实现了 `src/data/types.ts` 中 `PlatformProvider` 接口的适配器并注册到 `src/data/index.ts`，上层分析逻辑无需改动。
- 视频库、CRM 线索、应用配置通过本地 JSON 文件持久化在用户数据目录。
- 页面切换采用「挂载后保留」策略：各页面首次访问后保持挂载（CSS 隐藏），切回时历史操作与数据不丢失。

## 已知边界

- 模块 7（AI 剪辑）已接入真实渲染：视频解析大模型生成成片方案（分平台/分方向、钩子/字幕/转场），主进程用 `ffmpeg-static` 提供的 ffmpeg 对**真实素材**做裁剪、缩放、拼接并输出 mp4；无 `VIDEO_API_KEY` 时该模块不可用。剪辑素材可来自本地文件（文件选择对话框）、视频库已抓取且含直链的视频（自动下载）、或手动粘贴的可直链 URL。
- 烧录字幕依赖系统字体；若找不到字体会自动跳过字幕叠加（仍完成裁剪/拼接）。当前版本为「规划+渲染」层，未做转场特效引擎（转场以硬切 + 节奏裁剪体现）。
- 模块 2（视频库 AI 分析）与模块 7（AI 剪辑）为真正调用大模型的 AI 能力，需配置 `VIDEO_API_KEY`；其余模块为基于真实抓取数据的规则/统计计算，不依赖大模型。
- 真实平台抓取依赖 TiKhub 等第三方服务，需遵守各平台 ToS；本工具不内置任何绕过风控的抓取逻辑。
