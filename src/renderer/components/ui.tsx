import React from "react";
import type { TraceStep } from "../../shared/trace";
import type { PipelineState } from "../hooks/usePipeline";

export function Card({
  title,
  children,
  right,
}: {
  title?: React.ReactNode;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="card">
      {(title || right) && (
        <div className="card-head">
          <div className="card-title">{title}</div>
          <div>{right}</div>
        </div>
      )}
      <div className="card-body">{children}</div>
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Badge({
  kind,
  children,
}: {
  kind?: "conv" | "traffic" | "ok" | "warn" | "info";
  children: React.ReactNode;
}) {
  return <span className={`badge badge-${kind ?? "info"}`}>{children}</span>;
}

export function Spinner({ text }: { text?: string }) {
  return (
    <div className="spinner">
      <span className="dot" />
      {text ?? "加载中…"}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

export function platformLabel(p: string): string {
  return (
    {
      tiktok: "TikTok",
      instagram: "Instagram",
      youtube: "YouTube",
      facebook: "Facebook",
      xiaohongshu: "小红书",
      wechat_channels: "微信视频号",
    }[p] ?? p
  );
}

/** 将 ISO 字符串格式化为「YYYY-MM-DD HH:mm」本地展示（失败回退为原始值） */
export function formatDateTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 从任意 IPC 返回值/错误对象中安全取出 trace 步骤 */
export function extractTrace(x: any): TraceStep[] {
  const t = x?.trace;
  return Array.isArray(t) ? t : [];
}

/**
 * 将视频解析大模型返回的结构化文本逐行展示。
 * 只按模型返回的换行拆分，避免把播放量、点赞数等正文数字误判为建议编号。
 */
export function StructuredText({
  text,
  empty = "—",
}: {
  text?: string | null;
  empty?: string;
}) {
  if (!text || !text.trim()) return <span className="muted">{empty}</span>;
  const segs = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segs.length === 0) return <span className="muted">{empty}</span>;
  return (
    <div className="struct-block">
      {segs.map((s, i) => (
        <div key={i} className="struct-line">
          {s}
        </div>
      ))}
    </div>
  );
}

/**
 * 处理流程面板：折叠展示本次分析「数据抓取（TiKhub）/ AI 推理（视频解析大模型）」的实际调用。
 * 每个步骤展示：调用的接口或模型、请求参数、返回摘要、原始响应（可展开）。
 */
export function TracePanel({ steps }: { steps: TraceStep[] }) {
  if (!steps || steps.length === 0) return null;
  return (
    <div className="trace-panel">
      <details open>
        <summary className="trace-summary">
          🔍 处理流程（{steps.length} 步）
        </summary>
        <div className="trace-steps">
          {steps.map((s, i) => (
            <div
              key={i}
              className={`trace-step ${s.kind} ${s.ok ? "" : "fail"}`}
            >
              <div className="trace-head">
                <span className={`trace-badge ${s.kind}`}>
                  {s.kind === "tikhub"
                    ? "TiKhub 接口"
                    : s.kind === "cache"
                      ? "⚡ 缓存命中"
                      : s.kind === "ytdlp"
                        ? "yt-dlp 解析"
                        : s.kind === "ffmpeg"
                          ? "ffmpeg"
                          : s.kind === "whisper"
                            ? "Whisper"
                            : s.kind === "text"
                              ? "文本分析"
                              : "视频解析大模型"}
                </span>
                <span className="trace-title">{s.title}</span>
                <span className={`trace-status ${s.ok ? "ok" : "err"}`}>
                  {s.ok ? `成功 ${s.status}` : `失败 ${s.status}`}
                </span>
                <span className="trace-dur">{s.durationMs}ms</span>
              </div>
              {s.endpoint && (
                <div className="trace-line">
                  <b>接口：</b>
                  <code>{s.endpoint}</code>
                  {s.method && <span className="trace-method">{s.method}</span>}
                </div>
              )}
              {s.model && (
                <div className="trace-line">
                  <b>模型：</b>
                  <code>{s.model}</code>
                </div>
              )}
              {s.params && (
                <div className="trace-line">
                  <b>请求参数：</b>
                  <pre className="trace-json">
                    {JSON.stringify(s.params, null, 2)}
                  </pre>
                </div>
              )}
              {s.summary && (
                <div className="trace-line">
                  <b>返回摘要：</b>
                  {s.summary}
                </div>
              )}
              {s.error && (
                <div className="trace-line trace-err">
                  <b>错误：</b>
                  {s.error}
                </div>
              )}
              {s.raw && (
                <details className="trace-raw">
                  <summary>原始返回（{s.raw.length} 字）</summary>
                  <pre>{s.raw}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

/**
 * 实时工作流面板：把主进程经 IPC 推送的「处理流程（progress）」与「AI 流式输出（aichunk）」
 * 以类似 AI 对话的方式实时呈现——每调用一个 TiKhub 接口 / 一次大模型推理就实时长出一步，
 * 模型生成的文本边生成边滚动显示。取代原来静态的「加载中」Spinner。
 */
export function Pipeline({
  state,
  title,
}: {
  state: PipelineState;
  title?: string;
}) {
  if (
    !state.loading &&
    state.steps.length === 0 &&
    !state.aiText &&
    !state.error
  )
    return null;
  return (
    <div className="pipeline">
      {title && <div className="pipeline-title">{title}</div>}
      <ol className="pl-steps">
        {state.steps.map((s, i) => (
          <li key={i} className={`pl-step ${s.kind} ${s.ok ? "ok" : "fail"}`}>
            <span className={`pl-badge ${s.kind}`}>
              {s.kind === "tikhub"
                ? "TiKhub"
                : s.kind === "cache"
                  ? "缓存"
                  : s.kind === "ytdlp"
                    ? "yt-dlp"
                    : s.kind === "ffmpeg"
                      ? "ffmpeg"
                      : s.kind === "whisper"
                        ? "Whisper"
                        : s.kind === "text"
                          ? "文本分析"
                          : "视频解析大模型"}
            </span>
            <div className="pl-main">
              <div className="pl-line">
                <span className="pl-title">{s.title}</span>
                <span className={`pl-status ${s.ok ? "ok" : "err"}`}>
                  {s.ok ? `✓ ${s.status}` : `✗ ${s.status}`}
                </span>
                <span className="pl-dur">{s.durationMs}ms</span>
              </div>
              {s.summary && <div className="pl-summary">{s.summary}</div>}
              {s.error && <div className="pl-err">{s.error}</div>}
              {(s.endpoint || s.model || s.params || s.raw) && (
                <details className="pl-raw">
                  <summary>详情</summary>
                  {s.endpoint && (
                    <div className="pl-kv">
                      <b>接口：</b>
                      <code>{s.endpoint}</code>
                      {s.method && (
                        <span className="pl-method">{s.method}</span>
                      )}
                    </div>
                  )}
                  {s.model && (
                    <div className="pl-kv">
                      <b>模型：</b>
                      <code>{s.model}</code>
                    </div>
                  )}
                  {s.params && (
                    <pre className="pl-json">
                      {JSON.stringify(s.params, null, 2)}
                    </pre>
                  )}
                  {s.raw && <pre className="pl-rawbody">{s.raw}</pre>}
                </details>
              )}
            </div>
          </li>
        ))}
      </ol>
      {state.loading && (
        <div className="pl-step running">
          <span className="pl-spinner" />
          <div className="pl-main">
            <div className="pl-line">
              <span className="pl-title">正在处理…</span>
            </div>
          </div>
        </div>
      )}
      {state.aiText && (
        <div className="pl-ai">
          <div className="pl-ai-head">
            视频解析大模型实时输出
            {state.loading && <span className="pl-live">● 流式生成中</span>}
          </div>
          <pre className="pl-ai-text">
            {state.aiText}
            {state.loading ? "▍" : ""}
          </pre>
        </div>
      )}
      {state.error && <p className="err">{state.error}</p>}
    </div>
  );
}
