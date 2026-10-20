// 模块七：AI 批量视频剪辑（规划层 —— 素材分析 + 自动成片方案）
// 重要：本文件不再包含任何伪造/随机生成逻辑。
// 剪辑方案由 MiniMax-M3（见 src/data/minimax.ts 的 generateEditPlans）基于真实素材
// （视频直链做画面理解，或元数据做语义分析）生成。无 LLM 配置时本模块不可用。

export type EditDirection = "traffic" | "seed" | "conversion";
export type EditPlatform =
  | "tiktok"
  | "instagram"
  | "youtube"
  | "xiaohongshu"
  | "wechat_channels";

/** 用户在生成成片前确认的业务参数。 */
export interface EditGenerationOptions {
  /** 生成视频类型；未指定时由模型按三种方向分别给出方案。 */
  direction?: EditDirection;
  /** 目标画布方向。 */
  videoType?: "landscape" | "portrait";
  /** 是否添加口播音频。 */
  includeVoiceover?: boolean;
  /** 用户提供的口播文案（includeVoiceover=true 时必填）。 */
  voiceoverText?: string;
  /** 目标成片时长（秒）。 */
  durationSec?: number;
  /** 本地视频抽取的画面帧，作为 data URL 发送给视觉模型。 */
  visualMedia?: { type: "image"; url: string; label?: string }[];
  /** Persisted subtitle styling applied during rendering. */
  captionStyle?: EditSubtitleStyle;
  /** Persisted title subtitle styling (script mode). */
  titleStyle?: EditSubtitleStyle;
  /** Voice synthesis settings. */
  voiceoverVoice?: string;
  voiceoverRate?: number;
  /** Script editing segments provided by the user. */
  scriptSegments?: Array<{
    startSec: number;
    endSec: number;
    shot?: string;
    camera?: string;
    caption?: string;
    title?: string;
    analyze?: boolean;
    preserveAudio?: boolean;
    material: string;
  }>;
}

/** Subtitle appearance and placement shared by caption/title overlays. */
export interface EditSubtitleStyle {
  position?: "top" | "center" | "bottom";
  /** Relative coordinates (0..1) for free placement; renderer may omit. */
  x?: number;
  y?: number;
  /** Width as relative fraction (0..1), used by preview and wrapping. */
  width?: number;
  color?: string;
  fontSize?: number;
  font?: string;
  fontWeight?: "normal" | "bold" | number;
  outlineColor?: string;
  outlineWidth?: number;
  strokeColor?: string;
  strokeWidth?: number;
}

// 用户真实录入/从视频库选取的素材，不含任何随机值
export interface EditMaterial {
  name: string;
  url?: string; // 可直链的视频地址（用于多模态画面理解 / 远程素材下载）
  filePath?: string; // 本地视频绝对路径（用于真实剪辑，优先于 url）
  /** 关联的视频库行 id（用于降级处理成功后把「过审资源」回写视频库，后续分析优先复用） */
  videoId?: string;
  title?: string;
  caption?: string;
  tags?: string[];
  platform?: EditPlatform;
  durationSec?: number;
}

/** AI 依据分镜语义从源素材中选出的实际片段（时间为源素材时间轴）。 */
export interface EditClipRange {
  material: string;
  startSec: number;
  endSec: number;
}

// 剪辑方案由大模型返回，结构固定
export interface EditPlan {
  direction: EditDirection;
  platform: EditPlatform;
  durationSec: number;
  hook: string;
  clips: string[]; // 选用的素材名
  /** 用户在脚本编辑中指定的每段素材裁剪范围。 */
  clipRanges?: EditClipRange[];
  /** Whether to keep the original audio for each clip in script mode. */
  preserveAudio?: boolean[];
  captions: string[];
  /** Optional title captions rendered with independent styling. */
  titleCaptions?: string[];
  /** AI 分配到成片时间轴的口播片段。 */
  voiceoverSegments?: Array<{ text: string; startSec: number; endSec: number }>;
  transitions: string;
  note: string;
  /** 模型可选输出的 ffmpeg filter_complex 脚本。 */
  ffmpegScript?: string;
}

export const DIRECTION_LABEL: Record<EditDirection, string> = {
  traffic: "流量型（提升播放涨粉）",
  seed: "种草型（激发旅行兴趣）",
  conversion: "转化型（引导咨询/购买）",
};
