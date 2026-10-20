// 自身账号分析：作品样本类型 + 高/低流量分组纯函数。
// 放在 shared/ 是因为它同时被主进程侧（ai-tasks.ts 组装 prompt）与渲染进程侧
// （OwnAccount 页展示与传参）使用；此文件必须保持纯净（零 node/electron 依赖），
// 否则渲染端 Vite 打包会因 fs/electron 等 browser-external 报错。

/** 单个作品样本（用于 grounded 分析；数据均来自真实抓取，绝不伪造） */
export interface OwnWorkSample {
  title: string;
  caption?: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  tags?: string[];
  durationSec?: number;
}

/**
 * 按播放量把作品拆成「高流量组」与「低流量组」，供自身账号分析分别归因。
 * 排序规则：整体按播放量降序，前 50%（最多 6 条）为高流量组，其余（最多 6 条、取最低的）为低流量组。
 * 作品数 <= 1 时全部归入高流量组，低流量组为空。
 */
export function splitOwnWorksByTraffic<T extends { views?: number }>(
  videos: T[],
): { high: T[]; low: T[] } {
  const sorted = [...videos].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const n = sorted.length;
  if (n <= 1) return { high: sorted.slice(0, 1), low: [] };
  const mid = Math.ceil(n / 2);
  const high = sorted.slice(0, Math.min(mid, 6));
  const low = sorted.slice(mid).slice(0, 6); // 后半段按播放量升序，取最低的若干条
  return { high, low };
}
