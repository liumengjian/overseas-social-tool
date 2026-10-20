import React, { useEffect, useState, useRef } from "react";
import {
  Card,
  Spinner,
  Empty,
  platformLabel,
  formatDateTime,
  StructuredText,
} from "../components/ui";
import {
  SocialVideo,
  Platform,
  AppConfig,
  platformConfigured,
} from "../../shared/types";
import { useWorkflow } from "../workflowStore";
import { useViralTarget, clearViralTarget } from "../navStore";
import { parseVideoUrl } from "../../data/parse-url";
import { viralCacheKey } from "../../shared/cache-keys";
import { onVideoDbUpdated } from "../videoDbEvents";

export default function ViralBreakdown() {
  const [videos, setVideos] = useState<SocialVideo[]>([]);
  const [selId, setSelId] = useState("");
  const [loading, setLoading] = useState(true);

  // 「用链接直接分析」输入态（仅用于输入框与解析提示，分析结果与库内拆解共用下方统一展示区）
  const [urlInput, setUrlInput] = useState("");
  const [urlDetected, setUrlDetected] = useState<{
    platform: Platform;
    videoId: string;
  } | null>(null);
  // URL 入口的「前置校验」提示（非分析错误，单独展示在输入框下方）
  const [urlErr, setUrlErr] = useState("");

  // 统一拆解结果展示区（视频库选择 + 链接直连两个入口共用，避免页面出现两块拆解内容）
  const [active, setActive] = useState<{
    source: "lib" | "url";
    key: string;
    info: SocialVideo | null;
    result: any;
    note: string;
  } | null>(null);
  const [activeState, setActiveState] = useState<
    "idle" | "loading" | "done" | "error"
  >("idle");
  const [activeErr, setActiveErr] = useState("");
  const [config, setConfig] = useState<AppConfig | null>(null);

  const pipe = useWorkflow("爆款视频拆解");
  const target = useViralTarget();
  // 拆解结果按视频 id / 链接 key 持久化，跨重启保留
  const savedRef = useRef<Record<string, any>>({}); // 视频库：byId
  const urlSavedRef = useRef<
    Record<string, { result: any; info: SocialVideo | null }>
  >({}); // 链接：by `${platform}_${videoId}`

  useEffect(() => {
    window.api.getVideoDb().then(async (v) => {
      setVideos(v);
      try {
        const saved = await window.api.getJson("viral_breakdown");
        savedRef.current = (saved && saved.byId) || {};
        const hit = v.find((x) => savedRef.current[x.id]);
        if (hit) setSelId(hit.id);
      } catch {
        /* 持久化读取失败则忽略，回落到默认选中第一条 */
      }

      try {
        const savedUrl = await window.api.getJson("viral_breakdown_url");
        urlSavedRef.current = (savedUrl && savedUrl.byId) || {};
      } catch {
        /* 忽略 */
      }

      // 进入时自动恢复最近一次拆解结果到统一展示区（优先视频库，其次链接直连）
      try {
        const libHit = v.find((x) => savedRef.current[x.id]);
        if (libHit) {
          setActive({
            source: "lib",
            key: libHit.id,
            info: libHit,
            result: savedRef.current[libHit.id],
            note: "",
          });
          setActiveState("done");
        } else {
          const keys = Object.keys(urlSavedRef.current);
          if (keys.length) {
            const lastKey = keys[keys.length - 1];
            const last = urlSavedRef.current[lastKey];
            setActive({
              source: "url",
              key: lastKey,
              info: last.info ?? makeInfoFromKey(lastKey),
              result: last.result,
              note: "",
            });
            setActiveState("done");
          }
        }
      } catch {
        /* 忽略恢复失败 */
      }

      setLoading(false);
    });
  }, []);

  useEffect(() => {
    window.api.getConfig().then(setConfig);
  }, []);

  useEffect(
    () =>
      onVideoDbUpdated(() => {
        window.api.getVideoDb().then((v) => {
          setVideos(v);
          setSelId((current) =>
            current && v.some((item) => item.id === current)
              ? current
              : (v[0]?.id ?? ""),
          );
          setActive((current) =>
            current?.source === "lib" && current.info
              ? {
                  ...current,
                  info:
                    v.find((item) => item.id === current.info?.id) ??
                    current.info,
                }
              : current,
          );
        });
      }),
    [],
  );

  // 从视频库「AI 解析」跳转过来：自动选中目标视频并**直接开始拆解**（无需再点「开始拆解」）。
  useEffect(() => {
    if (!target.id) return;
    const v = videos.find((x) => x.id === target.id);
    if (v) {
      setSelId(v.id);
      const r = savedRef.current[v.id];
      if (r) {
        // 该视频已有拆解结果：直接恢复展示，不重复消耗 AI 额度
        setActive({ source: "lib", key: v.id, info: v, result: r, note: "" });
        setActiveState("done");
      } else {
        setActive(null);
        setActiveState("idle");
        runBreakdown(v);
      }
      clearViralTarget();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id, target.nonce, videos]);

  const selected = videos.find((v) => v.id === selId);
  const currentLibResult = selId ? savedRef.current[selId] : null;

  async function runBreakdown(v: SocialVideo) {
    if (!v) return;
    pipe.enqueue("爆款视频拆解", async (runId, signal) => {
      setActiveState("loading");
      setActiveErr("");
      setActive(null);
      try {
        // 先查云端缓存：该视频（按原链接）拆解过 → 直接展示，不重复消耗接口额度 / AI
        const cacheUrl = v.url || v.id;
        const q = await window.api.queryCache({
          key: viralCacheKey(v.platform, cacheUrl),
          type: "viral",
          runId,
        });
        if (signal.aborted) return;
        if (q.hit && q.data?.result) {
          setActive({
            source: "lib",
            key: v.id,
            info: q.data.info ?? v,
            result: q.data.result,
            note: "⚡ 已从云端缓存加载拆解结果（未重新消耗接口额度 / AI）。",
          });
          setActiveState("done");
          const cachedHook = String(
            q.data.result.first3sHookSummary ?? "",
          ).trim();
          if (cachedHook)
            await window.api
              .updateVideoHook({ id: v.id, hook: cachedHook })
              .catch(() => {});
          return;
        }
        if (v.platform === "facebook")
          throw new Error("暂不支持 Facebook 平台的数据抓取与业务分析。");
        const detail = await window.api.fetchVideoDetail({
          platform: v.platform,
          videoId: v.id,
          runId,
        });
        if (signal.aborted) return;
        const mediaUrl = detail.mediaUrl || v.mediaUrl;
        const wechatNote =
          v.platform === "wechat_channels"
            ? "微信视频号接口的浏览量字段可能返回 0；其媒体链接通常带 decode_key 加密，若模型无法读取画面将仅依据标题/评论推测。"
            : "";
        const comments = (detail.comments || [])
          .slice(0, 12)
          .map((c) => c.text);
        const res = await window.api.runAiTask({
          task: "breakdownViralVideo",
          payload: {
            title: v.title || v.caption,
            comments,
            url: mediaUrl,
            videoId: v.id,
            platform: v.platform,
          },
          runId,
        });
        if (signal.aborted) return;
        setActive({
          source: "lib",
          key: v.id,
          info: v,
          result: res,
          note: wechatNote,
        });
        setActiveState("done");
        const hook = String(res?.first3sHookSummary ?? "").trim();
        if (hook)
          await window.api.updateVideoHook({ id: v.id, hook }).catch(() => {});
        // 拆解结果入库（云端缓存）：同一视频后续拆解直接命中
        await window.api
          .saveCache({
            key: viralCacheKey(v.platform, cacheUrl),
            type: "viral",
            data: { result: res, info: v },
            refUrl: cacheUrl,
          })
          .catch(() => {});
        // 按视频 id 持久化拆解结果，下次打开应用直接展示，无需重新消耗 AI 额度
        savedRef.current = { ...savedRef.current, [v.id]: res };
        window.api
          .setJson("viral_breakdown", { byId: savedRef.current })
          .catch(() => {});
      } catch (e: any) {
        if (signal.aborted) return;
        setActiveErr(e?.message ?? String(e));
        setActiveState("error");
        throw e;
      }
    });
  }

  function onUrlChange(value: string) {
    setUrlInput(value);
    const p = parseVideoUrl(value);
    setUrlDetected(p ? { platform: p.platform, videoId: p.videoId } : null);
    setUrlErr("");
  }

  async function runBreakdownByUrl(rawUrl: string) {
    const parsed = parseVideoUrl(rawUrl);
    if (!parsed) {
      setUrlErr(
        "无法识别该链接的平台，支持 TikTok / Instagram / YouTube / 小红书 / 微信视频号 视频链接",
      );
      return;
    }
    if (parsed.platform === "facebook") {
      setUrlErr("暂不支持 Facebook 平台的数据抓取与业务分析。");
      return;
    }
    // 按平台校验数据接口密钥，缺失时明确提示而非静默「无视频内容」。
    if (config && !platformConfigured(config, parsed.platform)) {
      setUrlErr("未配置 TiKhub 令牌（在 .env 填写 TIKHUB_API_TOKEN）。");
      return;
    }
    if (!parsed.videoId) {
      setUrlErr(
        "未能从链接中提取视频 ID，请确认链接指向单条视频（如 https://www.tiktok.com/@user/video/123）",
      );
      return;
    }
    setUrlErr("");
    pipe.enqueue("爆款视频拆解（链接）", async (runId, signal) => {
      setActiveState("loading");
      setActiveErr("");
      setActive(null);
      try {
        // 先查云端缓存：该链接拆解过 → 直接展示，不重复消耗接口额度 / AI
        const q = await window.api.queryCache({
          key: viralCacheKey(parsed.platform, rawUrl),
          type: "viral",
          runId,
        });
        if (signal.aborted) return;
        if (q.hit && q.data?.result) {
          const cachedInfo = q.data.info ?? {};
          const libraryInfo = videos.find(
            (v) => v.url.replace(/\/+$/, "") === rawUrl.replace(/\/+$/, ""),
          );
          const info = {
            ...makeInfoFromKey(parsed.platform + "_" + parsed.videoId),
            ...libraryInfo,
            ...cachedInfo,
            url: rawUrl,
            tags: Array.from(
              new Set([
                ...(libraryInfo?.tags ?? []),
                ...(cachedInfo.tags ?? []),
              ]),
            ),
          } as SocialVideo;
          setActive({
            source: "url",
            key: parsed.platform + "_" + parsed.videoId,
            info,
            result: q.data.result,
            note: "⚡ 已从云端缓存加载拆解结果（未重新消耗接口额度 / AI）。",
          });
          setActiveState("done");
          return;
        }
        // 先用 yt-dlp 把在线链接解析为视频直链（与视频库中「三方接口直接返回直链」同款用法）；
        // 解析失败（未安装 / 平台不支持）时回退到三方接口返回的直链
        let ytUrl: string | undefined;
        let ytErr = "";
        const yt = await window.api.resolveMediaUrl({ url: rawUrl, runId });
        if (signal.aborted) return;
        if (yt.mediaUrl) ytUrl = yt.mediaUrl;
        if (yt.error) ytErr = yt.error;
        const detail = await window.api.fetchVideoDetail({
          platform: parsed.platform,
          videoId: parsed.videoId,
          url: rawUrl,
          runId,
        });
        if (signal.aborted) return;
        const mediaUrl = ytUrl || detail.mediaUrl || detail.video?.mediaUrl;
        const wechatNote =
          parsed.platform === "wechat_channels"
            ? "微信视频号接口的浏览量字段可能返回 0；媒体可能是加密文件，模型无法读取画面时请勿将推测当作事实。"
            : "";
        let note = wechatNote;
        if (!mediaUrl) {
          note = `未获取到可分析的视频直链${ytErr ? `（${ytErr}）` : ""}，已基于可用信息做文本分析。`;
        } else if (!ytUrl) {
          note = "yt-dlp 未解析到直链，已回退使用三方接口返回的直链。";
        }
        const comments = (detail.comments || [])
          .slice(0, 12)
          .map((c) => c.text);
        const title =
          yt.title || detail.video?.title || detail.video?.caption || "";
        const libraryInfo = videos.find(
          (v) => v.url.replace(/\/+$/, "") === rawUrl.replace(/\/+$/, ""),
        );
        const urlTags = Array.from(
          new Set(
            (title + " " + (detail.video?.caption ?? ""))
              .match(/#[\p{L}\p{N}_]+/gu)
              ?.map((t) => t.slice(1)) ?? [],
          ),
        );
        const info: SocialVideo = detail.video
          ? {
              ...(libraryInfo ?? {}),
              ...detail.video,
              url: rawUrl,
              tags: Array.from(
                new Set([
                  ...(libraryInfo?.tags ?? []),
                  ...(detail.video.tags ?? []),
                  ...urlTags,
                ]),
              ),
            }
          : libraryInfo
            ? {
                ...libraryInfo,
                url: rawUrl,
                title: libraryInfo.title || title,
                tags: Array.from(
                  new Set([...(libraryInfo.tags ?? []), ...urlTags]),
                ),
              }
            : {
                id: `${parsed.platform}_${parsed.videoId}`,
                platform: parsed.platform,
                authorId: "",
                authorName: "",
                url: rawUrl,
                publishTime: "",
                title,
                caption: "",
                hook: "",
                views: 0,
                likes: 0,
                shares: 0,
                comments: 0,
                favorites: 0,
                durationSec: 0,
                structure: "",
                source: "",
                bgm: "",
                isVideo: true,
                mediaType: "video",
                tags: urlTags,
              };
        const res = await window.api.runAiTask({
          task: "breakdownViralVideo",
          payload: {
            title,
            comments,
            url: mediaUrl,
            videoId: parsed.videoId,
            platform: parsed.platform,
          },
          runId,
        });
        if (signal.aborted) return;
        const key = `${parsed.platform}_${parsed.videoId}`;
        setActive({ source: "url", key, info, result: res, note });
        setActiveState("done");
        const hook = String(res?.first3sHookSummary ?? "").trim();
        if (hook)
          await window.api
            .updateVideoHook({ id: info.id, hook })
            .catch(() => {});
        // 拆解结果入库（云端缓存）：同一链接后续拆解直接命中
        await window.api
          .saveCache({
            key: viralCacheKey(parsed.platform, rawUrl),
            type: "viral",
            data: { result: res, info },
            refUrl: rawUrl,
          })
          .catch(() => {});
        urlSavedRef.current = {
          ...urlSavedRef.current,
          [key]: { result: res, info },
        };
        window.api
          .setJson("viral_breakdown_url", { byId: urlSavedRef.current })
          .catch(() => {});
      } catch (e: any) {
        if (signal.aborted) return;
        setActiveErr(e?.message ?? String(e));
        setActiveState("error");
        throw e;
      }
    });
  }

  const hasVideos = videos.length > 0;

  return (
    <div className="page">
      <h1>四、爆款视频智能拆解</h1>
      <p className="muted">
        选择一条视频（或粘贴视频链接），自动调用视频解析大模型多模态拆解前3秒
        Hook、主要拍摄主体、完整视频结构、爆款原因，并生成可复制选题。两种入口的分析结果共用下方同一展示区，避免页面出现重复拆解内容。
      </p>

      {loading ? (
        <Spinner />
      ) : (
        <>
          {/* 入口一：视频链接直连分析（无需先入库） */}
          <Card title="🔗 用视频链接直接分析">
            <div className="row">
              <input
                placeholder="粘贴 TikTok / Instagram / YouTube / 小红书 / 微信视频号 视频链接…"
                value={urlInput}
                onChange={(e) => onUrlChange(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                className="primary"
                onClick={() => runBreakdownByUrl(urlInput)}
                disabled={activeState === "loading" || !urlDetected}
              >
                {activeState === "loading"
                  ? "拆解中…"
                  : "用链接拆解（当前模型）"}
              </button>
            </div>
            {urlDetected && (
              <p className="muted small">
                已识别平台：{platformLabel(urlDetected.platform)}
                {urlDetected.videoId
                  ? ` · 视频ID：${urlDetected.videoId}`
                  : " · 未解析到视频ID"}
              </p>
            )}
            {urlInput.trim() && !urlDetected && (
              <p className="muted small">
                未能识别链接平台，仅支持 TikTok / Instagram / YouTube / 小红书 /
                微信视频号。
              </p>
            )}
            {urlErr && <p className="err">{urlErr}</p>}
          </Card>

          {/* 入口二：从视频库选择 */}
          <Card title="📚 从视频库选择">
            {!hasVideos ? (
              <Empty text="暂无视频数据，请先在「二、视频数据库」抓取竞对视频" />
            ) : (
              <>
                <select
                  value={selId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSelId(id);
                    const r = savedRef.current[id];
                    const info = videos.find((x) => x.id === id) ?? null;
                    if (r) {
                      // 该视频已有拆解结果：切到统一展示区直接展示，不重复消耗 AI 额度
                      setActive({
                        source: "lib",
                        key: id,
                        info,
                        result: r,
                        note: "",
                      });
                      setActiveState("done");
                    } else {
                      setActive(null);
                      setActiveState("idle");
                    }
                  }}
                  style={{ width: "100%" }}
                >
                  {videos.map((v) => (
                    <option key={v.id} value={v.id}>
                      {platformLabel(v.platform)} · {v.title.slice(0, 24)}（
                      {v.viewsKnown === false ||
                      (v.platform === "wechat_channels" && v.views === 0)
                        ? "-"
                        : v.views.toLocaleString()}{" "}
                      播放）
                    </option>
                  ))}
                </select>
                <button
                  className="primary"
                  style={{ marginTop: 10 }}
                  onClick={() => selected && runBreakdown(selected)}
                  disabled={activeState === "loading"}
                >
                  {activeState === "loading"
                    ? "拆解中…"
                    : currentLibResult
                      ? "重新拆解（当前模型）"
                      : "开始拆解（当前模型）"}
                </button>
              </>
            )}
          </Card>

          {/* 统一拆解结果展示区（两个入口共用） */}
          <section className="breakdown-area">
            {activeState === "loading" && (
              <Card title="⏳ 拆解中">
                <Spinner />
              </Card>
            )}
            {activeState === "error" && activeErr && (
              <p className="err">{activeErr}</p>
            )}
            {activeState === "idle" && !active && (
              <p className="muted">
                选择视频库视频或粘贴链接后，点击「拆解」即可在此查看完整分析。
              </p>
            )}
            {activeState === "done" &&
              active &&
              active.result &&
              active.info && (
                <>
                  {active.note && (
                    <p className="muted small" style={{ marginBottom: 10 }}>
                      {active.note}
                    </p>
                  )}
                  {renderInfo(active.info)}
                  {renderResult(active.result, active.info)}
                </>
              )}
          </section>
        </>
      )}
    </div>
  );

  /** 视频基础信息卡片（两种入口共用） */
  function renderInfo(info: SocialVideo) {
    return (
      <Card title="📊 视频基础信息">
        <div className="info-grid">
          <div className="info-item">
            <span className="info-label">发布时间</span>
            <span className="info-value">
              {formatDateTime(info.publishTime)}
            </span>
          </div>
          <div className="info-item">
            <span className="info-label">浏览量</span>
            <span className="info-value">
              {info.viewsKnown === false ||
              (info.platform === "wechat_channels" && info.views === 0)
                ? "-"
                : (info.views ?? 0).toLocaleString()}
            </span>
          </div>
          <div className="info-item">
            <span className="info-label">点赞数</span>
            <span className="info-value">
              {(info.likes ?? 0).toLocaleString()}
            </span>
          </div>
          <div className="info-item">
            <span className="info-label">转发数</span>
            <span className="info-value">
              {(info.shares ?? 0).toLocaleString()}
            </span>
          </div>
          <div className="info-item">
            <span className="info-label">评论数</span>
            <span className="info-value">
              {(info.comments ?? 0).toLocaleString()}
            </span>
          </div>
        </div>
      </Card>
    );
  }

  function makeInfoFromKey(key: string): SocialVideo {
    const [platform, ...idParts] = key.split("_");
    return {
      id: key,
      platform: (platform as Platform) || "tiktok",
      authorId: "",
      authorName: "",
      url: "",
      publishTime: "",
      title: idParts.join("_") || "视频",
      caption: "",
      hook: "",
      views: 0,
      likes: 0,
      shares: 0,
      comments: 0,
      favorites: 0,
      durationSec: 0,
      structure: "",
      source: "",
      tags: [],
      bgm: "",
      isVideo: true,
      mediaType: "video",
    };
  }

  /** 爆款拆解结果网格（两种入口共用） */
  function renderResult(result: any, info: SocialVideo) {
    return (
      <div className="grid-2">
        <Card title="🎣 前3秒 Hook 总结">
          <div className="big-tag">{result.first3sHookSummary || "—"}</div>
          <p className="muted small">
            素材来源：{info.source || "原创"} · BGM：{info.bgm || "—"} · 时长：
            {info.durationSec}s
          </p>
        </Card>
        <Card title="🎯 主要拍摄主体">
          <p>{result.mainShootingSubject || "—"}</p>
        </Card>
        <Card title="🧠 爆款核心逻辑">
          <StructuredText text={result.coreHitLogic} />
        </Card>
        <Card title="🎬 完整视频结构">
          <StructuredText text={result.fullVideoStructure} />
        </Card>
        <Card title="🏷️ 爆款原因标签">
          <div className="tag-row">
            {(result.hitReasonTags || []).map((r: string, i: number) => (
              <span key={i} className="reason-chip">
                {r}
              </span>
            ))}
            {(result.hitReasonTags || []).length === 0 && (
              <span className="muted">—</span>
            )}
          </div>
          <div className="info-origin-tags" style={{ marginTop: 12 }}>
            <div className="muted small">原视频标签</div>
            <div className="tag-row" style={{ marginTop: 6 }}>
              {info && (info.tags || []).length > 0 ? (
                info.tags.map((t: string, i: number) => (
                  <span key={i} className="mini-tag">
                    #{t}
                  </span>
                ))
              ) : (
                <span className="muted">—</span>
              )}
            </div>
          </div>
        </Card>
        <Card title="📋 可复制选题生成">
          <ul className="kv">
            {(result.reproducibleTopics || []).map((t: string, i: number) => (
              <li key={i}>{t}</li>
            ))}
            {(result.reproducibleTopics || []).length === 0 && (
              <li className="muted">—</li>
            )}
          </ul>
        </Card>
      </div>
    );
  }
}
