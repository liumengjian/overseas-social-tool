// 实时工作流固定面板：常驻应用右下角，不随页面切换而消失。
// - 有工作进行时展示实时步骤（来自全局 workflowStore）；
// - 无工作时展示「当前暂无工作内容」；
// - 支持展开 / 收起：收起时只显示当前最新一步的步骤名称，展开时显示完整工作流。
import { useState } from 'react';
import { useWorkflow } from '../workflowStore';

export default function WorkflowDock() {
  const { state } = useWorkflow();
  const [expanded, setExpanded] = useState(true);

  // 有「进行中」的工作流才展示实时内容；否则展示「当前暂无工作内容」
  const busy = state.loading;
  const hasWork = busy;
  const latest = state.steps[state.steps.length - 1];

  return (
    <div className={`workflow-dock ${expanded ? 'expanded' : 'collapsed'}`}>
      <div className="wd-head" onClick={() => setExpanded((v) => !v)}>
        <span className="wd-title">
          <span className={`wd-dot ${busy ? 'live' : 'idle'}`} />
          实时工作流
        </span>
        <span className="wd-toggle">{expanded ? '收起' : '展开'}</span>
      </div>

      {!hasWork ? (
        <div className="wd-empty">当前暂无工作内容</div>
      ) : !expanded ? (
        <div className="wd-collapsed">
          {latest ? (
            <span className="wd-latest">{latest.title}</span>
          ) : (
            <span className="wd-latest muted">处理中…</span>
          )}
        </div>
      ) : (
        <div className="wd-body">
          {latest && <div className="wd-current">当前步骤：{latest.title}</div>}
          <ol className="wd-steps">
            {state.steps.map((s, i) => (
              <li key={i} className={`wd-step ${s.kind} ${s.ok ? 'ok' : 'fail'}`}>
                <span className="wd-badge">{s.kind === 'tikhub' ? 'TiKhub' : 'MiniMax'}</span>
                <span className="wd-step-title">{s.title}</span>
                <span className={`wd-step-status ${s.ok ? 'ok' : 'err'}`}>
                  {s.ok ? `✓ ${s.status}` : `✗ ${s.status}`}
                </span>
                {s.summary && <div className="wd-summary">{s.summary}</div>}
              </li>
            ))}
          </ol>
          {busy && <div className="wd-running">正在处理…</div>}
          {state.aiText && (
            <div className="wd-ai">
              <div className="wd-ai-head">MiniMax-M3 实时输出{busy && <span className="wd-live"> ●</span>}</div>
              <pre className="wd-ai-text">{state.aiText}{busy ? '▍' : ''}</pre>
            </div>
          )}
          {state.error && <div className="wd-error">{state.error}</div>}
        </div>
      )}
    </div>
  );
}
