// 模块七：AI 批量视频剪辑（规划层 —— 素材分析 + 自动成片方案）
// 重要：本文件不再包含任何伪造/随机生成逻辑。
// 剪辑方案由 MiniMax-M3（见 src/data/minimax.ts 的 generateEditPlans）基于真实素材
// （视频直链做画面理解，或元数据做语义分析）生成。无 LLM 配置时本模块不可用。

export type EditDirection = 'traffic' | 'seed' | 'conversion';
export type EditPlatform = 'tiktok' | 'instagram' | 'facebook';

// 用户真实录入/从视频库选取的素材，不含任何随机值
export interface EditMaterial {
  name: string;
  url?: string; // 可直链的视频地址（用于多模态画面理解 / 远程素材下载）
  filePath?: string; // 本地视频绝对路径（用于真实剪辑，优先于 url）
  title?: string;
  caption?: string;
  tags?: string[];
  platform?: EditPlatform;
  durationSec?: number;
}

// 剪辑方案由大模型返回，结构固定
export interface EditPlan {
  direction: EditDirection;
  platform: EditPlatform;
  durationSec: number;
  hook: string;
  clips: string[]; // 选用的素材名
  captions: string[];
  transitions: string;
  note: string;
}

export const DIRECTION_LABEL: Record<EditDirection, string> = {
  traffic: '流量型（提升播放涨粉）',
  seed: '种草型（激发旅行兴趣）',
  conversion: '转化型（引导咨询/购买）',
};
