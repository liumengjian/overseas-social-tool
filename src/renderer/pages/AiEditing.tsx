import React, { useEffect, useState } from 'react';
import { Card, Badge, Spinner } from '../components/ui';
import { AppConfig, SocialVideo } from '../../shared/types';
import { EditMaterial, EditPlan, DIRECTION_LABEL } from '../../analysis/ai-edit';
import { useWorkflow } from '../workflowStore';

type GenState = 'idle' | 'loading' | 'done' | 'error';
type RenderState = 'idle' | 'loading' | 'done' | 'error';

interface RenderOutcome {
  direction: string;
  platform: string;
  outputPath: string;
  error?: string;
}

// 视频库平台 -> 剪辑平台（YouTube 不在剪辑平台范围内）
function toEditPlatform(p: SocialVideo['platform']) {
  return (['tiktok', 'instagram', 'facebook'].includes(p) ? p : undefined) as EditMaterial['platform'];
}

function videoToMaterial(v: SocialVideo): EditMaterial {
  return {
    name: `${v.authorName} · ${v.title || v.id}`.slice(0, 60),
    url: v.mediaUrl && /^https?:\/\//.test(v.mediaUrl) ? v.mediaUrl : undefined,
    videoId: v.id,
    title: v.title,
    caption: v.caption,
    tags: v.tags,
    platform: toEditPlatform(v.platform),
    durationSec: v.durationSec,
  };
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export default function AiEditing() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [db, setDb] = useState<SocialVideo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState<EditMaterial[]>([]);
  const [manualUrl, setManualUrl] = useState('');
  const [manualName, setManualName] = useState('');
  const [localPaths, setLocalPaths] = useState<string[]>([]);

  const [plans, setPlans] = useState<EditPlan[] | null>(null);
  const [genState, setGenState] = useState<GenState>('idle');
  const [genError, setGenError] = useState('');
  const pipe = useWorkflow('AI批量视频剪辑');

  const [burnCaptions, setBurnCaptions] = useState(false);
  const [renderState, setRenderState] = useState<RenderState>('idle');
  const [renderResults, setRenderResults] = useState<RenderOutcome[]>([]);
  const [renderError, setRenderError] = useState('');

  useEffect(() => {
    window.api.getConfig().then(setConfig);
    window.api.getVideoDb().then(setDb);
  }, []);

  const canGenerate = config?.minimaxConfigured ?? false;

  const selectedMaterials = db.filter((v) => selected.has(v.id)).map(videoToMaterial);
  const localMaterials: EditMaterial[] = localPaths.map((p) => ({ name: basename(p), filePath: p }));
  const materials = [...selectedMaterials, ...manual, ...localMaterials];
  const hasMaterials = materials.length > 0;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    setPlans(null);
    setGenState('idle');
  }

  function addManual() {
    const url = manualUrl.trim();
    if (!url) return;
    const name = manualName.trim() || url.split('/').pop()?.slice(0, 40) || '素材';
    setManual((m) => [...m, { name, url, platform: undefined }]);
    setManualUrl('');
    setManualName('');
    setPlans(null);
    setGenState('idle');
  }

  function removeManual(i: number) {
    setManual((m) => m.filter((_, k) => k !== i));
    setPlans(null);
    setGenState('idle');
  }

  async function pickFiles() {
    try {
      const paths = await window.api.pickVideoFiles();
      if (paths?.length) setLocalPaths((p) => [...p, ...paths]);
      setPlans(null);
      setGenState('idle');
    } catch (e: any) {
      setGenError(e?.message ?? String(e));
    }
  }

  async function generate() {
    pipe.enqueue('生成剪辑方案', async (runId, signal) => {
      setGenState('loading');
      setGenError('');
      setPlans(null);
      setRenderResults([]);
      try {
        const res = await window.api.generateEditPlan(materials, runId);
        if (signal.aborted) return;
        const arr = Array.isArray(res) ? res : [];
        if (arr.length === 0) {
          // 模型有返回但解析不出有效方案：给出模型原始返回摘要，便于定位（避免只显示空提示）
          const last = ((res as any)?.trace ?? [])[(res as any)?.trace?.length - 1];
          const hint = last?.summary ? `（模型原始返回：${last.summary}）` : '';
          setPlans([]);
          setGenError(`模型未返回有效方案，请调整素材后重试。${hint}`);
          setGenState('error');
          return;
        }
        setPlans(arr);
        setGenState('done');
      } catch (e: any) {
        if (signal.aborted) return;
        setGenError(e?.message ?? String(e));
        setGenState('error');
        throw e;
      }
    });
  }

  async function render(which: EditPlan[] | null) {
    if (!which || !which.length) return;
    pipe.enqueue('导出成片（ffmpeg）', async (_runId, signal) => {
      setRenderState('loading');
      setRenderError('');
      setRenderResults([]);
      try {
        const res = await window.api.renderEditPlan({ materials, plans: which, burnCaptions });
        if (signal.aborted) return;
        setRenderResults(res as RenderOutcome[]);
        setRenderState('done');
      } catch (e: any) {
        if (signal.aborted) return;
        setRenderError(e?.message ?? String(e));
        setRenderState('error');
        throw e;
      }
    });
  }

  return (
    <div className="page">
      <h1>七、AI 批量视频剪辑（真实渲染）</h1>
      <p className="muted">
        选取真实素材（本地视频 / 视频库已抓取且含直链的 / 手动链接），由 MiniMax-M3 生成分平台、分方向的成片方案，
        再由 ffmpeg 按方案对真实素材做裁剪、缩放、拼接并（可选）烧录字幕，输出 mp4。无 LLM 配置时本功能不可用。
      </p>

      {!canGenerate && (
        <p className="muted" style={{ marginTop: 10 }}>
          未配置 MiniMax（在 <code>.env</code> 填写 <code>MINIMAX_API_KEY</code> 后重启即可启用 AI 剪辑方案生成）。
        </p>
      )}

      <Card title="选择素材（真实来源，无任何示例数据）">
        <div className="row">
          <button className="ghost" onClick={pickFiles}>选择本地视频</button>
          <span className="muted small">已选本地文件 {localPaths.length} 个</span>
        </div>
        {localPaths.length > 0 && (
          <ul className="kv small">
            {localPaths.map((p, i) => (
              <li key={i}><span>{basename(p)}</span>
                <button className="mini" onClick={() => setLocalPaths((arr) => arr.filter((_, k) => k !== i))}>移除</button></li>
            ))}
          </ul>
        )}

        <div className="row" style={{ marginTop: 8 }}>
          <input placeholder="视频可直链 URL（https）" value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} style={{ flex: 1 }} />
          <input placeholder="素材名（可选）" value={manualName} onChange={(e) => setManualName(e.target.value)} style={{ width: 160 }} />
          <button className="ghost" onClick={addManual} disabled={!manualUrl.trim()}>添加链接</button>
        </div>
        {manual.length > 0 && (
          <ul className="kv small">
            {manual.map((m, i) => (
              <li key={i}><span>{m.name}</span><span className="muted"> · {m.url}</span>
                <button className="mini" onClick={() => removeManual(i)}>移除</button></li>
            ))}
          </ul>
        )}

        <div className="muted small" style={{ marginTop: 8 }}>
          从视频库勾选（含直链可做画面理解）：已选 {selected.size}
        </div>
        {db.length === 0 ? (
          <p className="empty">视频库为空。可先在「竞对视频数据抓取与视频库」抓取竞对视频，或从上方选择本地视频。</p>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 220, overflow: 'auto' }}>
            <table className="tbl tbl-ai">
              <thead><tr><th></th><th>作者</th><th>标题</th><th>平台</th><th>直链</th></tr></thead>
              <tbody>
                {db.map((v) => (
                  <tr key={v.id}>
                    <td><input type="checkbox" checked={selected.has(v.id)} onChange={() => toggle(v.id)} /></td>
                    <td>{v.authorName}</td>
                    <td className="small">{v.title}</td>
                    <td>{v.platform}</td>
                    <td>{v.mediaUrl && /^https?:\/\//.test(v.mediaUrl) ? <Badge kind="ok">有</Badge> : <Badge kind="warn">无</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`待剪辑素材（${materials.length}）`}>
        {!hasMaterials ? (
          <p className="empty">尚未选择任何素材。请选择本地视频、添加链接，或从视频库勾选。</p>
        ) : (
          <>
            <ul className="kv small">
              {materials.map((m, i) => (
                <li key={i}><span>{m.name}</span>
                  <span className="muted"> · {m.filePath ? '本地文件' : m.url ? '含直链(可画面理解)' : '仅元数据'}</span></li>
              ))}
            </ul>
            <button className="primary" onClick={generate} disabled={!canGenerate || genState === 'loading'}>
              {genState === 'loading' ? 'AI 生成方案中…' : '生成剪辑方案'}
            </button>
          </>
        )}
      </Card>

      {genState === 'error' && <p className="err">{genError}</p>}

      {genState === 'done' && plans && (
        plans.length === 0 ? (
          <p className="empty">模型未返回有效方案，请调整素材后重试。</p>
        ) : (
          <>
            <Card title="AI 成片方案（真实素材将被剪辑为此结构）">
              <label className="check" style={{ marginBottom: 10 }}>
                <input type="checkbox" checked={burnCaptions} onChange={(e) => setBurnCaptions(e.target.checked)} />
                烧录字幕（在画面上叠加文案，需要系统字体；无字体时自动跳过）
              </label>
              <div className="grid-2">
                {plans.map((p, i) => (
                  <div key={i} className="kv small">
                    <li><b>{DIRECTION_LABEL[p.direction]} · {p.platform.toUpperCase()}</b> · {p.durationSec}s</li>
                    <li className="muted">Hook：{p.hook}</li>
                    <li className="muted">选用：{p.clips.join('、') || '—'}</li>
                  </div>
                ))}
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="primary" onClick={() => render(plans)} disabled={renderState === 'loading'}>
                  {renderState === 'loading' ? '渲染中…' : '导出全部成片（ffmpeg）'}
                </button>
              </div>
            </Card>

            {renderState === 'loading' && <Spinner />}
            {renderState === 'error' && <p className="err">{renderError}</p>}
            {renderState === 'done' && renderResults.length > 0 && (
              <Card title="成片输出">
                <ul className="kv small">
                  {renderResults.map((r, i) => (
                    <li key={i}>
                      <span>{DIRECTION_LABEL[r.direction as keyof typeof DIRECTION_LABEL] ?? r.direction} · {r.platform.toUpperCase()}</span>
                      {r.outputPath ? (
                        <>
                          <span className="muted"> · {r.outputPath}</span>
                          <button className="mini" onClick={() => window.api.openPath(r.outputPath)}>打开文件夹</button>
                        </>
                      ) : (
                        <span><Badge kind="warn">渲染失败</Badge> <span className="muted small">{r.error}</span></span>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )
      )}

    </div>
  );
}
