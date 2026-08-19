// 实时工作流固定面板：常驻应用右下角，不随页面切换而消失。
// - 有工作进行时展示实时步骤（来自全局 workflowStore 队列）；
// - 无工作时展示「当前暂无工作内容」；
// - 支持展开 / 收起：收起时只显示当前最新一步的步骤名称，展开时显示完整工作流与排队任务。
// - 内容实时输出时自动跟随滚动到底部（面板整体 + MiniMax 输出区），若用户手动向上翻阅则暂停跟随，
//   滚回底部后自动恢复跟随。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWorkflow } from '../workflowStore';

/** 距离底部多少像素以内视为「贴底」，用户在此范围内滚动时保持自动跟随 */
const STICK_THRESHOLD = 28;

/** 把毫秒格式化为「Xs」/「Xm Ys」，供步骤耗时展示 */
function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

const STATUS_LABEL: Record<string, string> = {
  running: '进行中',
  done: '已完成',
  error: '失败',
  cancelled: '已取消',
  queued: '排队中',
};

export default function WorkflowDock() {
  const { state, cancel } = useWorkflow();
  const [expanded, setExpanded] = useState(true);
  const [openStep, setOpenStep] = useState<number | null>(null);

  const items = state.items;
  const active = items[0];
  const queued = items.slice(1);
  const hasWork = items.length > 0;
  const busy = active?.status === 'running';
  const latest = active?.steps[active.steps.length - 1];

  // 自动滚动：面板正文与 AI 输出区各自维护「是否贴底」，只有贴底时才跟随最新内容
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const aiRef = useRef<HTMLPreElement | null>(null);
  const bodyStick = useRef(true);
  const aiStick = useRef(true);

  const nearBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
  const toBottom = (el: HTMLElement | null) => {
    if (el) el.scrollTop = el.scrollHeight;
  };

  // 切换到新的工作流（或重新展开面板）时，重置为跟随底部
  useEffect(() => {
    bodyStick.current = true;
    aiStick.current = true;
  }, [active?.id, expanded]);

  // 内容变化（步骤新增 / AI 流式输出 / 进度更新 / 状态变化）后跟随滚动
  useLayoutEffect(() => {
    if (!expanded) return;
    if (bodyStick.current) toBottom(bodyRef.current);
    if (aiStick.current) toBottom(aiRef.current);
  }, [
    expanded,
    active?.id,
    active?.status,
    active?.steps.length,
    active?.aiText,
    active?.error,
    active?.progress?.current,
    queued.length,
  ]);

  return (
    <div className={`workflow-dock ${expanded ? 'expanded' : 'collapsed'}`}>
      <div className="wd-head" onClick={() => setExpanded((v) => !v)}>
        <span className="wd-title">
          <span className={`wd-dot ${busy ? 'live' : 'idle'}`} />
          实时工作流
          {active?.module && <span className="wd-subtitle">{active.module}</span>}
          {queued.length > 0 && <span className="wd-count">+{queued.length} 排队中</span>}
        </span>
        <span className="wd-toggle">{expanded ? '收起' : '展开'}</span>
      </div>

      {!hasWork ? (
        <div className="wd-empty">当前暂无工作内容</div>
      ) : (
        <div className="wd-collapsible">
          {!expanded ? (
            <div className="wd-collapsed">
              {latest ? (
                <span className="wd-latest">{latest.title}</span>
              ) : (
                <span className="wd-latest muted">处理中…</span>
              )}
              {active && (
                <span className={`wd-status ${active.status}`}>
                  {STATUS_LABEL[active.status] ?? active.status}
                </span>
              )}
            </div>
          ) : (
        <div
          className="wd-body"
          ref={bodyRef}
          onScroll={(e) => {
            bodyStick.current = nearBottom(e.currentTarget);
          }}
        >
          {active && (
            <div className="wd-active">
              <div className="wd-active-head">
                <span className="wd-active-title">{active.title || '工作流任务'}</span>
                <span className={`wd-status ${active.status}`}>
                  {STATUS_LABEL[active.status] ?? active.status}
                </span>
                {active.status === 'running' && (
                  <button
                    className="wd-cancel-btn"
                    onClick={() => cancel(active.runId)}
                    title="取消当前任务（3 秒后自动执行排队任务）"
                  >
                    取消
                  </button>
                )}
              </div>
              {active.status === 'running' && latest && <div className="wd-current">当前步骤：{latest.title}</div>}
              {active.progress && (
                <div className="wd-progress">
                  <div className="wd-progress-head">
                    <span>替换总进度</span>
                    <span className="wd-progress-count">{active.progress.current}/{active.progress.total}</span>
                  </div>
                  <div className="wd-progress-bar">
                    <div
                      className="wd-progress-fill"
                      style={{ width: `${active.progress.total > 0 ? Math.round((active.progress.current / active.progress.total) * 100) : 0}%` }}
                    />
                  </div>
                  {active.progress.label && <div className="wd-progress-label">{active.progress.label}</div>}
                </div>
              )}
              <ol className="wd-steps">
                {active.steps.map((s, i) => (
                  <li key={i} className={`wd-step ${s.kind} ${s.ok ? 'ok' : 'fail'} ${openStep === i ? 'open' : ''}`}>
                    <div
                      className="wd-step-head"
                      onClick={() => setOpenStep(openStep === i ? null : i)}
                      title="点击查看接口详情（请求参数 / 返回结果）"
                    >
                      <span className="wd-badge">{s.kind === 'tikhub' ? 'TiKhub' : 'MiniMax'}</span>
                      <span className="wd-step-title">{s.title}</span>
                      {s.durationMs > 0 && (
                        <span className="wd-duration" title="该步骤耗时">{formatDuration(s.durationMs)}</span>
                      )}
                      <span className="wd-step-toggle">{openStep === i ? '▾' : '▸'}</span>
                      <span className={`wd-step-status ${s.ok ? 'ok' : 'err'}`}>
                        {s.ok ? `✓ ${s.status}` : `✗ ${s.status}`}
                      </span>
                    </div>
                    {s.summary && <div className="wd-summary">{s.summary}</div>}
                    {openStep === i && (s.params || s.raw || s.endpoint) && (
                      <div className="wd-step-detail">
                        {s.endpoint && (
                          <div className="wd-detail-row">
                            <span className="wd-detail-key">接口</span>
                            <code className="wd-detail-val">{s.endpoint}</code>
                          </div>
                        )}
                        {s.params && Object.keys(s.params).length > 0 && (
                          <div className="wd-detail-row">
                            <span className="wd-detail-key">请求参数</span>
                            <pre className="wd-detail-val">{JSON.stringify(s.params, null, 2)}</pre>
                          </div>
                        )}
                        {s.raw && (
                          <div className="wd-detail-row">
                            <span className="wd-detail-key">返回结果</span>
                            <pre className="wd-detail-val wd-raw">{s.raw}</pre>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
              {active.status === 'running' && <div className="wd-running">正在处理…</div>}
              {active.aiText && (
                <div className="wd-ai">
                  <div className="wd-ai-head">MiniMax-M3 实时输出{active.status === 'running' && <span className="wd-live"> ●</span>}</div>
                  <pre
                    className="wd-ai-text"
                    ref={aiRef}
                    onScroll={(e) => {
                      aiStick.current = nearBottom(e.currentTarget);
                    }}
                  >{active.aiText}{active.status === 'running' ? '▍' : ''}</pre>
                </div>
              )}
              {active.error && <div className="wd-error">{active.error}</div>}
            </div>
          )}

          {queued.length > 0 && (
            <div className="wd-queue">
              <div className="wd-queue-head">排队中（{queued.length}）</div>
              <ul className="wd-queue-list">
                {queued.map((q) => (
                  <li key={q.id} className="wd-queue-item">
                    <span className="wd-queue-dot" />
                    <span className="wd-queue-name">{q.title || '工作流任务'}</span>
                    {q.module && <span className="wd-queue-module">{q.module}</span>}
                    <button
                      className="wd-queue-cancel"
                      onClick={() => cancel(q.runId)}
                      title="取消该排队任务"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        )}
        </div>
      )}
    </div>
  );
}
