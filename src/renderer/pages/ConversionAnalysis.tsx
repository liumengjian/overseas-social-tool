import React, { useEffect, useState } from "react";
import {
  Card,
  Empty,
  Spinner,
  StructuredText,
  formatDateTime,
  platformLabel,
} from "../components/ui";
import {
  AppConfig,
  Platform,
  SocialVideo,
  platformConfigured,
} from "../../shared/types";
import { parseVideoUrl } from "../../data/parse-url";
import { useWorkflow } from "../workflowStore";
import { onVideoDbUpdated } from "../videoDbEvents";

type ConversionResult = {
  productImplantMethod: string;
  conversionPath: string;
  potentialConversionLevel: "高" | "中" | "低";
  userConsultDemands: string[];
  summary: string;
};

function emptyVideo(platform: Platform, url: string, title = ""): SocialVideo {
  return {
    id: platform + "_url_" + Date.now(),
    platform,
    authorId: "",
    authorName: "",
    url,
    publishTime: "",
    title,
    caption: title,
    hook: "",
    views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    favorites: 0,
    durationSec: 0,
    structure: "",
    source: "链接",
    tags: [],
    bgm: "",
    isVideo: true,
    mediaType: "video",
  };
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export default function ConversionAnalysis() {
  const [videos, setVideos] = useState<SocialVideo[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [url, setUrl] = useState("");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [info, setInfo] = useState<SocialVideo | null>(null);
  const pipe = useWorkflow("高转化分析");

  useEffect(() => {
    Promise.all([window.api.getVideoDb(), window.api.getConfig()]).then(
      ([db, cfg]) => {
        setVideos(db);
        setConfig(cfg);
        if (db[0]) setSelectedId(db[0].id);
        setLoading(false);
      },
    );
  }, []);

  useEffect(
    () =>
      onVideoDbUpdated(() => {
        window.api.getVideoDb().then((db) => {
          setVideos(db);
          setSelectedId((current) =>
            current && db.some((v) => v.id === current)
              ? current
              : (db[0]?.id ?? ""),
          );
          setInfo((current) =>
            current
              ? (db.find((v) => v.id === current.id) ?? current)
              : current,
          );
        });
      }),
    [],
  );

  async function analyzeLibraryVideo(video: SocialVideo) {
    if (video.platform === "facebook") {
      setError("暂不支持 Facebook 平台的数据抓取与业务分析。");
      return;
    }
    await analyzeVideo(video);
  }

  async function analyzeUrl() {
    const parsed = parseVideoUrl(url);
    if (!parsed || !parsed.videoId) {
      setError("无法识别视频链接或未提取到视频 ID");
      return;
    }
    if (parsed.platform === "facebook") {
      setError("暂不支持 Facebook 平台的数据抓取与业务分析。");
      return;
    }
    if (config && !platformConfigured(config, parsed.platform)) {
      setError("未配置 TiKhub 令牌，请先在设置页填写 TIKHUB_API_TOKEN");
      return;
    }
    const fromDb = videos.find(
      (v) => normalizeUrl(v.url) === normalizeUrl(url),
    );
    await analyzeVideo(fromDb ?? emptyVideo(parsed.platform, url), url);
  }

  async function analyzeVideo(video: SocialVideo, sourceUrl?: string) {
    pipe.enqueue("高转化视频分析", async (runId, signal) => {
      setBusy(true);
      setError("");
      setResult(null);
      setInfo(video);
      try {
        const detail = await window.api.fetchVideoDetail({
          platform: video.platform,
          videoId: video.id,
          url: sourceUrl,
          runId,
        });
        if (signal.aborted) return;
        const detailVideo = detail.video;
        const merged: SocialVideo = detailVideo
          ? { ...video, ...detailVideo, url: video.url || detailVideo.url }
          : video;
        setInfo(merged);
        const mediaUrl = detail.mediaUrl || merged.mediaUrl;
        const comments = (detail.comments || [])
          .slice(0, 50)
          .map((c) => c.text);
        const ai = await window.api.runAiTask({
          task: "analyzeConversionVideo",
          payload: {
            desc: merged.caption || merged.title,
            title: merged.title,
            tags: merged.tags,
            comments,
            url: mediaUrl,
          },
          runId,
        });
        if (signal.aborted) return;
        setResult({
          productImplantMethod: ai?.productImplantMethod || "无植入",
          conversionPath: ai?.conversionPath || "未体现完整转化路径",
          potentialConversionLevel: ["高", "中", "低"].includes(
            ai?.potentialConversionLevel,
          )
            ? ai.potentialConversionLevel
            : "中",
          userConsultDemands: Array.isArray(ai?.userConsultDemands)
            ? ai.userConsultDemands
            : [],
          summary: ai?.summary || "",
        });
      } catch (e: any) {
        if (signal.aborted) return;
        setError(e?.message ?? String(e));
        throw e;
      } finally {
        setBusy(false);
      }
    });
  }

  const selected = videos.find((v) => v.id === selectedId);
  const levelClass =
    result?.potentialConversionLevel === "高"
      ? "badge-conv"
      : result?.potentialConversionLevel === "低"
        ? "badge-info"
        : "badge-warn";

  return (
    <div className="page">
      <h1>六、高转化视频分析</h1>
      <p className="muted">
        选择视频库中的单条作品，或粘贴视频链接。系统结合作品内容、文案和真实评论，分析产品植入方式与用户转化路径。
      </p>
      <Card title="使用视频链接分析">
        <div className="row">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="粘贴 TikTok / Instagram / YouTube / 小红书视频链接"
            style={{ flex: 1 }}
          />
          <button
            className="primary"
            onClick={analyzeUrl}
            disabled={busy || !url.trim()}
          >
            开始分析
          </button>
        </div>
      </Card>
      <Card title="从视频库选择">
        {loading ? (
          <Spinner />
        ) : videos.length === 0 ? (
          <Empty text="暂无视频数据，请先在视频数据库抓取视频" />
        ) : (
          <>
            <select
              value={selectedId}
              onChange={(e) => {
                setSelectedId(e.target.value);
                setResult(null);
                setInfo(null);
              }}
              style={{ width: "100%" }}
            >
              {videos.map((v) => (
                <option key={v.id} value={v.id}>
                  {platformLabel(v.platform)} ·{" "}
                  {(v.title.slice(0, 36) || v.id) +
                    "（" +
                    (v.viewsKnown === false ||
                    (v.platform === "wechat_channels" && v.views === 0)
                      ? "-"
                      : v.views.toLocaleString()) +
                    " 播放）"}
                </option>
              ))}
            </select>
            <button
              className="primary"
              style={{ marginTop: 10 }}
              onClick={() => selected && analyzeLibraryVideo(selected)}
              disabled={busy || !selected}
            >
              {busy ? "分析中…" : "分析选中视频"}
            </button>
          </>
        )}
      </Card>
      {error && <p className="err">{error}</p>}
      {busy && (
        <Card title="处理中">
          <Spinner />
        </Card>
      )}
      {info && result && (
        <>
          <Card title="视频基础信息">
            <div className="info-grid">
              <div className="info-item">
                <span className="info-label">标题</span>
                <span className="info-value">{info.title || "—"}</span>
              </div>
              <div className="info-item">
                <span className="info-label">平台</span>
                <span className="info-value">
                  {platformLabel(info.platform)}
                </span>
              </div>
              <div className="info-item">
                <span className="info-label">发布时间</span>
                <span className="info-value">
                  {formatDateTime(info.publishTime)}
                </span>
              </div>
              <div className="info-item">
                <span className="info-label">播放量</span>
                <span className="info-value">
                  {info.viewsKnown === false ||
                  (info.platform === "wechat_channels" && info.views === 0)
                    ? "-"
                    : info.views.toLocaleString()}
                </span>
              </div>
              <div className="info-item">
                <span className="info-label">评论数</span>
                <span className="info-value">
                  {info.comments.toLocaleString()}
                </span>
              </div>
            </div>
          </Card>
          <div className="grid-2">
            <Card title="产品植入方式">
              <StructuredText text={result.productImplantMethod} />
            </Card>
            <Card title="用户转化路径">
              <StructuredText text={result.conversionPath} />
            </Card>
            <Card title="转化潜力">
              <span className={levelClass}>
                {result.potentialConversionLevel}
              </span>
              <StructuredText text={result.summary} />
            </Card>
            <Card title="用户咨询诉求">
              {result.userConsultDemands.length ? (
                <ul className="kv">
                  {result.userConsultDemands.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              ) : (
                <span className="muted">评论中未识别到明确咨询诉求</span>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
