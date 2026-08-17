import React, { useEffect, useState } from 'react';
import { Card, Badge, Spinner, Empty, platformLabel } from '../components/ui';
import { SocialVideo } from '../../shared/types';
import { useWorkflow } from '../workflowStore';

export default function ViralBreakdown() {
  const [videos, setVideos] = useState<SocialVideo[]>([]);
  const [selId, setSelId] = useState('');
  const [loading, setLoading] = useState(true);

  // AI 拆解状态（实时工作流）
  const [result, setResult] = useState<any>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [err, setErr] = useState('');
  const pipe = useWorkflow();

  useEffect(() => {
    window.api.getVideoDb().then((v) => { setVideos(v); setSelId(v[0]?.id ?? ''); setLoading(false); });
  }, []);

  const selected = videos.find((v) => v.id === selId);

  async function runBreakdown(v: SocialVideo) {
    if (!v) return;
    const runId = pipe.start();
    setState('loading'); setErr(''); setResult(null);
    try {
      const detail = await window.api.fetchVideoDetail({ platform: v.platform, videoId: v.id, runId });
      const mediaUrl = detail.mediaUrl || v.mediaUrl;
      const comments = (detail.comments || []).slice(0, 12).map((c) => c.text);
      const res = await window.api.runAiTask({
        task: 'breakdownViralVideo',
        payload: { title: v.title || v.caption, comments, url: mediaUrl },
        runId,
      });
      setResult(res);
      setState('done');
      pipe.finish();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setState('error');
      pipe.finish();
    }
  }

  // 切换视频自动拆解（仅在有素材时）
  useEffect(() => {
    if (selected && state === 'idle') runBreakdown(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId]);

  const hasVideos = videos.length > 0;

  return (
    <div className="page">
      <h1>四、爆款视频智能拆解</h1>
      <p className="muted">选择一条视频，自动调用 MiniMax-M3 多模态拆解前3秒 Hook、视频结构、爆款原因，并生成可复制选题。</p>

      {loading ? <Spinner /> : !hasVideos ? (
        <Empty text="暂无视频数据，请先在「二、视频数据库」抓取竞对视频" />
      ) : (
        <>
          <Card title="选择视频">
            <select value={selId} onChange={(e) => { setSelId(e.target.value); setState('idle'); }} style={{ width: '100%' }}>
              {videos.map((v) => <option key={v.id} value={v.id}>{platformLabel(v.platform)} · {v.title.slice(0, 24)}（{v.views.toLocaleString()} 播放）</option>)}
            </select>
            <button className="primary" style={{ marginTop: 10 }} onClick={() => selected && runBreakdown(selected)} disabled={state === 'loading'}>
              {state === 'loading' ? '拆解中…' : '重新拆解（MiniMax-M3）'}
            </button>
          </Card>

          {state === 'error' && <p className="err">{err}</p>}
          {state === 'done' && result && (
            <div className="grid-2">
              <Card title="前3秒 Hook 总结">
                <div className="big-tag">{result.first3sHookSummary || '—'}</div>
                <p className="muted small">素材来源：{selected!.source || '原创'} · BGM：{selected!.bgm || '—'} · 时长：{selected!.durationSec}s</p>
              </Card>
              <Card title="爆款核心逻辑">
                <p>{result.coreHitLogic || '—'}</p>
              </Card>
              <Card title="完整视频结构">
                <p>{result.fullVideoStructure || '—'}</p>
              </Card>
              <Card title="爆款原因标签">
                <div className="tag-row">
                  {(result.hitReasonTags || []).map((r: string, i: number) => <span key={i} className="reason-chip">{r}</span>)}
                  {(result.hitReasonTags || []).length === 0 && <span className="muted">—</span>}
                </div>
              </Card>
              <Card title="可复制选题生成">
                <ul className="kv">
                  {(result.reproducibleTopics || []).map((t: string, i: number) => <li key={i}>{t}</li>)}
                  {(result.reproducibleTopics || []).length === 0 && <li className="muted">—</li>}
                </ul>
              </Card>
            </div>
          )}
        </>
      )}

    </div>
  );
}
