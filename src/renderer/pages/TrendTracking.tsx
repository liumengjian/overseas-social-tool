import React, { useState } from "react";
import { Badge, Card, platformLabel } from "../components/ui";
import { HashtagStat, Platform, TrendTopic } from "../../shared/types";
import { useWorkflow } from "../workflowStore";
import { fmtCount } from "../../data/trend-utils";

const COLORS: Record<string, string> = {
  tiktok: "#241334",
  instagram: "#E1306C",
  youtube: "#2563EB",
  xiaohongshu: "#E53935",
  wechat_channels: "#07C160",
};

type SupportedPlatform = Platform;
const PLATFORMS: SupportedPlatform[] = [
  "tiktok",
  "instagram",
  "youtube",
  "xiaohongshu",
  "wechat_channels",
];

type PlatformSearchState = {
  keyword: string;
  results: HashtagStat[];
  searched: boolean;
  loading: boolean;
  error: string;
};

function emptyPlatformSearchState(): PlatformSearchState {
  return {
    keyword: "",
    results: [],
    searched: false,
    loading: false,
    error: "",
  };
}

function initialPlatformSearchState(): Record<
  SupportedPlatform,
  PlatformSearchState
> {
  return Object.fromEntries(
    PLATFORMS.map((item) => [item, emptyPlatformSearchState()]),
  ) as Record<SupportedPlatform, PlatformSearchState>;
}

export default function TrendTracking() {
  const [platform, setPlatform] = useState<SupportedPlatform>("tiktok");
  const [searchState, setSearchState] = useState<
    Record<SupportedPlatform, PlatformSearchState>
  >(initialPlatformSearchState);
  const [tiktokTrends, setTiktokTrends] = useState<TrendTopic[]>([]);
  const [tiktokHashtags, setTiktokHashtags] = useState<HashtagStat[]>([]);
  const [wechatVideos, setWechatVideos] = useState<any[]>([]);
  const pipe = useWorkflow("热点与Tag追踪");

  const activeSearch = searchState[platform];
  const { keyword, results, loading, searched, error } = activeSearch;

  function updatePlatformSearch(
    next: SupportedPlatform,
    update: Partial<PlatformSearchState>,
  ) {
    setSearchState((prev) => ({
      ...prev,
      [next]: { ...prev[next], ...update },
    }));
  }

  function loadTiktok() {
    updatePlatformSearch("tiktok", { loading: true, error: "" });
    pipe.enqueue("加载 TikTok 热点", async (runId, signal) => {
      try {
        // 首次进入页面只加载趋势词，不执行关键词搜索；关键词搜索必须由输入框主动触发。
        const trends = await window.api.fetchTrends({
          platform: "tiktok",
          runId,
        });
        if (signal.aborted) return;
        setTiktokTrends(trends ?? []);
        setTiktokHashtags([]);
      } catch (e: any) {
        if (!signal.aborted)
          updatePlatformSearch("tiktok", { error: e?.message ?? String(e) });
      } finally {
        if (!signal.aborted) updatePlatformSearch("tiktok", { loading: false });
      }
    });
  }

  React.useEffect(() => {
    loadTiktok();
  }, []);

  function selectPlatform(next: SupportedPlatform) {
    setPlatform(next);
    if (next === "tiktok" && !tiktokTrends.length && !tiktokHashtags.length)
      loadTiktok();
  }

  function search(force = false) {
    const query = activeSearch.keyword.trim();
    if (!query || loading) return;
    const searchPlatform = platform;
    updatePlatformSearch(searchPlatform, { loading: true, error: "" });
    pipe.enqueue(
      `搜索${platformLabel(searchPlatform)}词条`,
      async (runId, signal) => {
        try {
          if (searchPlatform === "wechat_channels") {
            const videos = await window.api.searchVideos({
              platform: searchPlatform,
              keyword: query,
              runId,
            });
            if (signal.aborted) return;
            setWechatVideos(videos ?? []);
            const tags = Array.from(
              new Set((videos ?? []).flatMap((v: any) => v.tags ?? [])),
            ).map((tag) => ({
              tag: `#${tag}`,
              platform: searchPlatform,
              posts: 0,
              views: 0,
              growth: 0,
            }));
            updatePlatformSearch(searchPlatform, {
              results: tags,
              searched: true,
            });
            return;
          }
          const res = await window.api.fetchTrendData({
            platform: searchPlatform,
            keyword: query,
            runId,
            bypassCache: force,
          });
          if (signal.aborted) return;
          updatePlatformSearch(searchPlatform, {
            results: res?.hashtags ?? [],
            searched: true,
          });
        } catch (e: any) {
          if (signal.aborted) return;
          updatePlatformSearch(searchPlatform, {
            error: e?.message ?? String(e),
            results: [],
            searched: true,
          });
        } finally {
          if (!signal.aborted)
            updatePlatformSearch(searchPlatform, { loading: false });
        }
      },
    );
  }

  function refresh() {
    if (platform === "tiktok" && !keyword.trim()) loadTiktok();
    else search(true);
  }

  const ranked = [...results].sort(
    (a, b) => (b.views || b.posts || 0) - (a.views || a.posts || 0),
  );
  const maxValue = Math.max(
    ...ranked.map((item) => item.views || item.posts || 0),
    1,
  );
  const hasRankMetrics = ranked.some(
    (item) => item.views > 0 || item.posts > 0,
  );

  return (
    <div className="page">
      <h1>三、海外社媒热点与 Tag 追踪</h1>
      <div className="row" style={{ marginTop: 12 }}>
        {PLATFORMS.map((item) => {
          const active = platform === item;
          return (
            <button
              key={item}
              className={`pill ${active ? "active" : ""}`}
              onClick={() => selectPlatform(item)}
              style={{
                borderColor: COLORS[item],
                background: active ? COLORS[item] : "transparent",
                color: active ? "#fff" : undefined,
                fontWeight: active ? 700 : 400,
              }}
            >
              {platformLabel(item)}
            </button>
          );
        })}
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <label className="small" htmlFor="trend-keyword">
          热点发现关键词：
        </label>
        <input
          id="trend-keyword"
          style={{ flex: 1 }}
          value={keyword}
          onChange={(event) =>
            updatePlatformSearch(platform, { keyword: event.target.value })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") search();
          }}
          placeholder="输入关键词搜索词条"
        />
        <button
          className="primary"
          onClick={() => search()}
          disabled={loading || !keyword.trim()}
        >
          {loading ? "搜索中…" : "搜索"}
        </button>
      </div>

      {platform === "tiktok" && (
        <>
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={() => refresh()} disabled={loading}>
              {loading ? "刷新中…" : "刷新 TikTok 热点"}
            </button>
          </div>
          <div className="grid-2" style={{ marginTop: 16 }}>
            <Card title="上升热点话题">
              {tiktokTrends.length === 0 ? (
                <p className="muted">暂无热点数据</p>
              ) : (
                <ul className="trend-list">
                  {tiktokTrends.slice(0, 12).map((item) => (
                    <li key={item.keyword} className="trend-item">
                      <div className="trend-item-head">
                        <span>{item.keyword}</span>
                        {item.growth > 0 && (
                          <Badge kind="ok">+{item.growth}%</Badge>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="TikTok Hashtag 热度排行">
              {tiktokHashtags.length === 0 ? (
                <p className="muted">暂无 Hashtag 数据</p>
              ) : (
                <div className="hbar-list">
                  {[...tiktokHashtags]
                    .sort((a, b) => b.views - a.views)
                    .map((item) => {
                      const max = Math.max(
                        ...tiktokHashtags.map((tag) => tag.views),
                        1,
                      );
                      return (
                        <div key={item.tag} className="hbar-row">
                          <span className="hbar-tag">{item.tag}</span>
                          <span className="hbar-track">
                            <span
                              className="hbar-fill"
                              style={{
                                width: `${Math.max(4, Math.round((item.views / max) * 100))}%`,
                                background: COLORS.tiktok,
                              }}
                            />
                          </span>
                          <span className="hbar-val">
                            {fmtCount(item.views)}
                          </span>
                        </div>
                      );
                    })}
                </div>
              )}
            </Card>
            <Card title="关联 Tag 推荐">
              {Array.from(
                new Set(tiktokTrends.flatMap((item) => item.relatedTags ?? [])),
              ).length === 0 ? (
                <p className="muted">暂无关联 Tag 推荐</p>
              ) : (
                <div className="tag-row">
                  {Array.from(
                    new Set(
                      tiktokTrends.flatMap((item) => item.relatedTags ?? []),
                    ),
                  ).map((tag) => (
                    <span key={tag} className="trend-chip">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </>
      )}

      {error && (
        <p className="err" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}

      <Card title={platform === "wechat_channels" ? "热门视频" : "词条排行榜"}>
        {platform === "wechat_channels" &&
          searched &&
          wechatVideos.length > 0 && (
            <div className="trend-list" style={{ marginBottom: 16 }}>
              {wechatVideos.map((video: any, index: number) => (
                <div key={video.id ?? index} className="trend-item">
                  <div className="trend-item-head">
                    <span>{video.title || video.caption || "未命名视频"}</span>
                  </div>
                  <div className="muted small" style={{ marginTop: 4 }}>
                    {video.authorName || ""}
                    {video.views ? ` · ${fmtCount(video.views)} 播放` : ""}
                  </div>
                  {(video.tags ?? []).length > 0 && (
                    <div className="tag-row" style={{ marginTop: 6 }}>
                      {video.tags.map((tag: string) => (
                        <span key={tag} className="trend-chip">
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        {loading && <p className="muted">加载中…</p>}
        {!loading && !searched && <p className="muted">输入关键词后搜索词条</p>}
        {!loading &&
          searched &&
          platform !== "wechat_channels" &&
          ranked.length === 0 && <p className="muted">暂无匹配词条</p>}
        {!loading && ranked.length > 0 && (
          <div
            className={`hbar-list ranked-hbar-list${hasRankMetrics ? "" : " ranked-hbar-list-terms-only"}`}
          >
            {ranked.map((item, index) => {
              const value = item.views || item.posts || 0;
              const display =
                item.views > 0
                  ? fmtCount(item.views)
                  : item.posts > 0
                    ? `${fmtCount(item.posts)} 条`
                    : "—";
              return (
                <div key={`${item.tag}-${index}`} className="hbar-row">
                  <span className="small" style={{ width: 28, flexShrink: 0 }}>
                    {index + 1}
                  </span>
                  <span className="hbar-tag">{item.tag}</span>
                  {hasRankMetrics && (
                    <>
                      <span className="hbar-track">
                        <span
                          className="hbar-fill"
                          style={{
                            width: `${Math.max(value ? Math.round((value / maxValue) * 100) : 0, value ? 4 : 0)}%`,
                            background: COLORS[platform],
                          }}
                        />
                      </span>
                      <span className="hbar-val">{display}</span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
