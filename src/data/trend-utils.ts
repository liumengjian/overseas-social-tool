// 热点发现的通用工具：泛化标签过滤 + 数字格式化 + 话题中间结构。
// 供 Instagram / Facebook / 小红书 的「搜索→提取→验证」三步即时热点发现算法共用。

/** 泛化标签黑名单：这些词几乎每条内容都带、没有区分度，直接过滤（#旅行 #love 这类永远高频的词） */
export const GENERIC_TAG_STOPWORDS = new Set([
  // 跨平台高普适
  "love",
  "like",
  "lol",
  "haha",
  "fun",
  "cool",
  "nice",
  "awesome",
  "amazing",
  "best",
  "new",
  "top",
  "daily",
  "vlog",
  "video",
  "videos",
  "shorts",
  "reel",
  "reels",
  "fyp",
  "foryou",
  "foryoupage",
  "trending",
  "viral",
  "explore",
  "repost",
  "follow",
  "follower",
  "like4like",
  "photo",
  "photos",
  // 旅行领域泛化词（由搜索关键词派生，几乎每条都带，无区分度）
  "travel",
  "trip",
  "tourism",
  "tourist",
  "tour",
  "china",
  "chinese",
  "visit",
  "vacation",
  "holiday",
  "destination",
  "景点",
  "旅行",
  "旅游",
  "攻略",
  "游客",
  "中国",
  "打卡",
  "出游",
  "行程",
  "旅程",
]);

/** 是否为泛化标签（无区分度的永远高频词） */
export function isGenericTag(name: string): boolean {
  return GENERIC_TAG_STOPWORDS.has(String(name || "").toLowerCase());
}

/** 数字格式化：1280000 → 128.0万；452000 → 45.2万；3200 → 3.2k */
export function fmtCount(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

/** 把「逗号分隔的关键词串」拆成关键词数组（支持中英文逗号）；空串返回 [] */
export function splitKeywords(keyword?: string): string[] {
  return (keyword ?? "")
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 合并两个关键词各自发现到的同一话题（候选频次/互动累加，热度取高，关联标签去重，样本取更热） */
export function mergeDiscovered(
  a: DiscoveredTopic,
  b: DiscoveredTopic,
): DiscoveredTopic {
  return {
    tag: a.tag,
    count: a.count + b.count,
    engagement: a.engagement + b.engagement,
    views: a.views + b.views,
    heat: Math.max(a.heat, b.heat),
    // 优先保留「官方验证」得到的热度描述（兜底描述以「候选频次」开头）
    heatDesc:
      (a.heatDesc && !a.heatDesc.startsWith("候选频次")
        ? a.heatDesc
        : b.heatDesc) ||
      a.heatDesc ||
      b.heatDesc,
    relatedTags: Array.from(
      new Set([...a.relatedTags, ...b.relatedTags]),
    ).slice(0, 5),
    topPosts: [...a.topPosts, ...b.topPosts]
      .sort((x, y) => y.likes - x.likes)
      .slice(0, 3),
  };
}

/** 一个被发现的候选热点话题（三步算法的中间产物，最终映射为 TrendTopic / HashtagStat） */
export interface DiscoveredTopic {
  tag: string; // 不含 # 前缀
  count: number; // 候选频次（多少条内容携带）
  engagement: number; // 样本互动总量（赞/互动）
  views: number; // 样本播放/浏览总量（或验证到的官方热度）
  heat: number; // 归一化热度 0-100
  heatDesc: string; // 热度描述文案，如「浏览量 128万 / 讨论数 3.2万」「帖子数 45.2万」
  relatedTags: string[]; // 关联标签（含 # 前缀，Top 5）
  topPosts: {
    id: string;
    title: string;
    likes: number;
    cover?: string;
    url?: string;
  }[]; // 该话题下最热内容样本
}
