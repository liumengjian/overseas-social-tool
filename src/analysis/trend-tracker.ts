// 模块三：海外社媒热点与 Hashtag 追踪（聚合与分析）
import {
  HashtagStat,
  Platform,
  TrendTopic,
  ALL_PLATFORMS,
} from "../shared/types";

export interface TrendSummary {
  rising: TrendTopic[]; // 上升热点
  topByPlatform: Record<Platform, TrendTopic[]>;
  hashtagRanking: HashtagStat[]; // 按热度排序
  platformComparison: {
    platform: Platform;
    totalViews: number;
    avgGrowth: number;
  }[];
  relatedTagSuggestions: string[]; // 关联 Tag 推荐
}

export function summarizeTrends(
  trends: TrendTopic[],
  hashtags: HashtagStat[],
): TrendSummary {
  const rising = [...trends]
    .filter((t) => t.growth > 0)
    .sort((a, b) => b.growth - a.growth);
  const topByPlatform = {} as Record<Platform, TrendTopic[]>;
  ALL_PLATFORMS.forEach((p) => {
    topByPlatform[p] = trends
      .filter((t) => t.platform === p)
      .sort((a, b) => b.heat - a.heat);
  });

  const hashtagRanking = [...hashtags].sort((a, b) => b.views - a.views);

  const platformComparison = ALL_PLATFORMS.map((p) => {
    const hs = hashtags.filter((h) => h.platform === p);
    const ts = trends.filter((t) => t.platform === p);
    return {
      platform: p,
      totalViews: hs.reduce((s, h) => s + h.views, 0),
      avgGrowth: ts.length
        ? ts.reduce((s, t) => s + t.growth, 0) / ts.length
        : 0,
    };
  }).filter((c) => c.totalViews > 0 || c.avgGrowth !== 0);

  // 关联 Tag 推荐（规则聚合）：取上升热点 / 高热度话题的「共现关联标签」，
  // 但排除已在话题榜 / Hashtag 榜上的话题本身——否则三个模块展示同一批标签（此前「三模块内容雷同」的根因）。
  const hot = new Set<string>();
  rising
    .slice(0, 8)
    .forEach((t) => hot.add(t.keyword.replace(/^#/, "").toLowerCase()));
  hashtagRanking
    .slice(0, 12)
    .forEach((h) => hot.add(h.tag.replace(/^#/, "").toLowerCase()));
  const related = new Set<string>();
  rising.slice(0, 8).forEach((t) =>
    (t.relatedTags ?? []).forEach((x) => {
      const n = x.replace(/^#/, "").toLowerCase();
      if (n && !hot.has(n)) related.add(x);
    }),
  );
  const relatedTagSuggestions = Array.from(related).slice(0, 12);

  return {
    rising,
    topByPlatform,
    hashtagRanking,
    platformComparison,
    relatedTagSuggestions,
  };
}
