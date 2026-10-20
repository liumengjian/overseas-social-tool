import React, { useEffect, useState } from "react";
import {
  Card,
  Empty,
  Spinner,
  formatDateTime,
  platformLabel,
} from "../components/ui";
import { Platform, SocialVideo } from "../../shared/types";
import { parseVideoUrl } from "../../data/parse-url";
import { voiceoverCacheKey } from "../../shared/cache-keys";
import { useWorkflow } from "../workflowStore";
import { onVideoDbUpdated } from "../videoDbEvents";

type Segment = { start: number; end: number; text: string };
type Result = {
  transcript: { text: string; segments: Segment[] };
  analysis: {
    keyPoints: string[];
    hook: string;
    closingCta: string;
    opening: string;
    middle: string;
    ending: string;
  };
};

function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(milli).padStart(3, "0")}`;
}
function toSrt(segments: Segment[]): string {
  return (
    segments
      .map(
        (s, i) =>
          `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}`,
      )
      .join("\n\n") + (segments.length ? "\n" : "")
  );
}

export default function VoiceoverCapture() {
  const [videos, setVideos] = useState<SocialVideo[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [info, setInfo] = useState<SocialVideo | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );
  const [error, setError] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const pipe = useWorkflow("口播文案抓取");

  useEffect(() => {
    window.api.getVideoDb().then((v) => {
      setVideos(v);
      if (v[0]) setSelectedId(v[0].id);
    });
  }, []);
  useEffect(
    () =>
      onVideoDbUpdated(() => {
        window.api.getVideoDb().then((v) => {
          setVideos(v);
          setSelectedId((current) =>
            current && v.some((item) => item.id === current)
              ? current
              : (v[0]?.id ?? ""),
          );
        });
      }),
    [],
  );

  async function run(
    sourceUrl: string,
    videoInfo: SocialVideo,
    cacheUrl: string,
    enqueue = true,
    inherited?: { runId: string; signal: AbortSignal },
  ) {
    if (!sourceUrl) {
      setError("未获取到视频地址，请先在视频库下载视频或刷新视频直链");
      setState("error");
      return;
    }
    const task = async (runId: string, signal: AbortSignal) => {
      runId = inherited?.runId || runId;
      signal = inherited?.signal || signal;
      setState("loading");
      setError("");
      setResult(null);
      setInfo(videoInfo);
      try {
        const key = voiceoverCacheKey(videoInfo.platform, cacheUrl);
        const hit = await window.api.queryCache({
          key,
          type: "voiceover",
          runId,
        });
        if (signal.aborted) return;
        if (
          hit.hit &&
          hit.data?.result?.transcript &&
          hit.data?.result?.analysis
        ) {
          setResult(hit.data.result);
          setState("done");
          return;
        }
        const data = await window.api.extractVoiceover({
          sourceUrl,
          pageUrl: videoInfo.url,
          videoId: videoInfo.id,
          runId,
        });
        if (signal.aborted) return;
        setResult(data);
        setState("done");
        await window.api.saveCache({
          key,
          type: "voiceover",
          data: { result: data, info: videoInfo },
          refUrl: cacheUrl,
        });
      } catch (e: any) {
        if (!signal.aborted) {
          setError(e?.message ?? String(e));
          setState("error");
          throw e;
        }
      }
    };
    if (enqueue) pipe.enqueue("口播文案抓取", task);
    else await task("", new AbortController().signal);
  }

  async function runLibrary() {
    const v = videos.find((x) => x.id === selectedId);
    if (!v) return;
    if (v.platform === "facebook") {
      setError("暂不支持 Facebook 平台的数据抓取与业务分析。");
      setState("error");
      return;
    }
    // 本地视频直接读取；远程视频交给主进程 yt-dlp 下载，避免提前解析出易过期的 CDN 直链。
    const source = v.localMediaUrl || v.url || v.mediaUrl;
    await run(source || "", v, v.url || v.id);
  }

  async function runUrl() {
    const parsed = parseVideoUrl(url);
    if (!parsed) {
      setError("无法识别链接平台");
      setState("error");
      return;
    }
    if (parsed.platform === "facebook") {
      setError("暂不支持 Facebook 平台的数据抓取与业务分析。");
      setState("error");
      return;
    }
    pipe.enqueue("准备视频链接", async (runId, signal) => {
      try {
        const v = {
          id: `${parsed.platform}_${parsed.videoId}`,
          platform: parsed.platform,
          authorId: "",
          authorName: "",
          url,
          publishTime: "",
          title: "",
          caption: "",
          hook: "",
          views: 0,
          likes: 0,
          comments: 0,
          shares: 0,
          favorites: 0,
          durationSec: 0,
          structure: "",
          source: "link",
          tags: [],
          bgm: "",
          isVideo: true,
          mediaType: "video",
        } as SocialVideo;
        await run(url, v, url, false, { runId, signal });
      } catch (e: any) {
        setError(e?.message ?? String(e));
        setState("error");
        throw e;
      }
    });
  }

  async function copyAll() {
    if (!result?.transcript.text) return;
    try {
      await navigator.clipboard.writeText(result.transcript.text);
      setCopyNotice("口播文案已复制");
    } catch {
      setCopyNotice("复制失败，请手动复制");
    }
    window.setTimeout(() => setCopyNotice(""), 2200);
  }
  function downloadSrt() {
    if (!result) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([toSrt(result.transcript.segments)], {
        type: "text/plain;charset=utf-8",
      }),
    );
    a.download = `${(info?.title || "口播文案").replace(/[^\w\u4e00-\u9fff-]/g, "_")}.srt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  const selected = videos.find((v) => v.id === selectedId);
  return (
    <div className="page">
      <h1>五、口播文案抓取</h1>
      <p className="muted">
        选择视频或粘贴链接，系统会下载视频，使用本地 Whisper 转写，再用客服 SOP
        对话模型分析完整口播文案。
      </p>
      <Card title="🔗 用视频链接直接抓取">
        <div className="row">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="粘贴 TikTok / Instagram / YouTube / 小红书 / 微信视频号视频链接"
            style={{ flex: 1 }}
          />
          <button
            className="primary"
            onClick={runUrl}
            disabled={state === "loading" || !url.trim()}
          >
            {state === "loading" ? "抓取中…" : "开始抓取"}
          </button>
        </div>
      </Card>
      <Card title="📚 从视频库选择">
        {videos.length ? (
          <>
            <select
              value={selectedId}
              onChange={(e) => {
                setSelectedId(e.target.value);
                setResult(null);
                setState("idle");
              }}
              style={{ width: "100%" }}
            >
              {videos.map((v) => (
                <option key={v.id} value={v.id}>
                  {platformLabel(v.platform)} · {v.title.slice(0, 30)}（
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
              onClick={runLibrary}
              disabled={!selected || state === "loading"}
            >
              {state === "loading" ? "抓取中…" : "抓取口播文案"}
            </button>
          </>
        ) : (
          <Empty text="暂无视频数据，请先在「二、视频数据库」抓取视频" />
        )}
      </Card>
      {state === "loading" && (
        <Card title="⏳ 处理中">
          <Spinner />
        </Card>
      )}
      {state === "error" && error && <p className="err">{error}</p>}
      {state === "done" && result && info && (
        <>
          <Card title="📝 原始口播文案">
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button onClick={copyAll}>复制全部文本</button>
              <button onClick={downloadSrt}>导出 SRT</button>
            </div>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                lineHeight: 1.8,
                maxHeight: 520,
                overflow: "auto",
              }}
            >
              {result.transcript.text || "未识别到口播内容"}
            </pre>
          </Card>
          <Card title="🎯 核心要点提炼">
            <p>视频卖点：{result.analysis.keyPoints.join("；") || "未明确"}</p>
            <p>钩子：{result.analysis.hook}</p>
            <p>结尾引导话术：{result.analysis.closingCta}</p>
          </Card>
          <Card title="🧩 脚本结构拆解">
            <p>开头：{result.analysis.opening}</p>
            <p>中间内容：{result.analysis.middle}</p>
            <p>结尾 CTA 引导：{result.analysis.ending}</p>
          </Card>
        </>
      )}
      {copyNotice && (
        <div className="voiceover-toast" role="status">
          {copyNotice}
        </div>
      )}
    </div>
  );
}
