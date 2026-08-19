import React, { useEffect, useState, useRef } from 'react';
import { Card, Badge, Spinner, Empty, platformLabel, formatDateTime, StructuredText } from '../components/ui';
import { SocialVideo } from '../../shared/types';
import { useWorkflow } from '../workflowStore';
import { useViralTarget, clearViralTarget } from '../navStore';

export default function ViralBreakdown() {
  const [videos, setVideos] = useState<SocialVideo[]>([]);
  const [selId, setSelId] = useState('');
  const [loading, setLoading] = useState(true);

  // AI 拆解状态（实时工作流）
  const [result, setResult] = useState<any>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [err, setErr] = useState('');
  const pipe = useWorkflow('爆款视频拆解');
  const target = useViralTarget();
  // 拆解结果按视频 id 持久化，跨重启保留（viral_breakdown.byId）
  const savedRef = useRef<Record<string, any>>({});

  useEffect(() => {
    window.api.getVideoDb().then(async (v) => {
      setVideos(v);
      let initialId = v[0]?.id ?? '';
      try {
        const saved = await window.api.getJson('viral_breakdown');
        const byId = (saved && saved.byId) || {};
        savedRef.current = byId;
        const hit = v.find((x) => byId[x.id]);
        if (hit) initialId = hit.id;
      } catch { /* 持久化读取失败则忽略，回落到默认选中第一条 */ }
      setSelId(initialId);
      const r = initialId ? savedRef.current[initialId] : null;
      if (r) { setResult(r); setState('done'); }
      setLoading(false);
    });
  }, []);

  // 从视频库「AI 解析」跳转过来：自动选中目标视频并**直接开始拆解**（无需再点「开始拆解」）。
  // 拆解成功后清除目标，之后通过菜单 tab 重新进入页面时 target 为空 → 只默认选中、不自动触发。
  useEffect(() => {
    if (!target.id) return;
    const v = videos.find((x) => x.id === target.id);
    if (v) {
      setSelId(v.id);
      const r = savedRef.current[v.id];
      if (r) {
        // 该视频已有拆解结果：直接恢复展示，不重复消耗 AI 额度
        setResult(r); setState('done');
      } else {
        setResult(null); setState('idle');
        runBreakdown(v);
      }
      clearViralTarget();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id, target.nonce, videos]);

  const selected = videos.find((v) => v.id === selId);

  async function runBreakdown(v: SocialVideo) {
    if (!v) return;
    pipe.enqueue('爆款视频拆解', async (runId, signal) => {
      setState('loading'); setErr(''); setResult(null);
      try {
        const detail = await window.api.fetchVideoDetail({ platform: v.platform, videoId: v.id, runId });
        if (signal.aborted) return;
        const mediaUrl = detail.mediaUrl || v.mediaUrl;
        const comments = (detail.comments || []).slice(0, 12).map((c) => c.text);
        const res = await window.api.runAiTask({
          task: 'breakdownViralVideo',
          payload: { title: v.title || v.caption, comments, url: mediaUrl, videoId: v.id, platform: v.platform },
          runId,
        });
        if (signal.aborted) return;
        setResult(res);
        setState('done');
        // 按视频 id 持久化拆解结果，下次打开应用直接展示，无需重新消耗 AI 额度
        savedRef.current = { ...savedRef.current, [v.id]: res };
        window.api.setJson('viral_breakdown', { byId: savedRef.current }).catch(() => {});
      } catch (e: any) {
        if (signal.aborted) return;
        setErr(e?.message ?? String(e));
        setState('error');
        throw e;
      }
    });
  }

  const hasVideos = videos.length > 0;

  return (
    <div className="page">
      <h1>四、爆款视频智能拆解</h1>
      <p className="muted">选择一条视频，自动调用 MiniMax-M3 多模态拆解前3秒 Hook、主要拍摄主体、完整视频结构、爆款原因，并生成可复制选题。</p>

      {loading ? <Spinner /> : !hasVideos ? (
        <Empty text="暂无视频数据，请先在「二、视频数据库」抓取竞对视频" />
      ) : (
        <>
          <Card title="选择视频">
            <select value={selId} onChange={(e) => { const id = e.target.value; setSelId(id); setResult(null); setState('idle'); const r = savedRef.current[id]; if (r) { setResult(r); setState('done'); } }} style={{ width: '100%' }}>
              {videos.map((v) => <option key={v.id} value={v.id}>{platformLabel(v.platform)} · {v.title.slice(0, 24)}（{v.views.toLocaleString()} 播放）</option>)}
            </select>
            <button className="primary" style={{ marginTop: 10 }} onClick={() => selected && runBreakdown(selected)} disabled={state === 'loading'}>
              {state === 'loading' ? '拆解中…' : result ? '重新拆解（MiniMax-M3）' : '开始拆解（MiniMax-M3）'}
            </button>
          </Card>

          {selected && (
            <Card title="📊 视频基础信息">
              <div className="info-grid">
                <div className="info-item"><span className="info-label">发布时间</span><span className="info-value">{formatDateTime(selected.publishTime)}</span></div>
                <div className="info-item"><span className="info-label">浏览量</span><span className="info-value">{selected.views.toLocaleString()}</span></div>
                <div className="info-item"><span className="info-label">点赞数</span><span className="info-value">{selected.likes.toLocaleString()}</span></div>
                <div className="info-item"><span className="info-label">转发数</span><span className="info-value">{selected.shares.toLocaleString()}</span></div>
                <div className="info-item"><span className="info-label">评论数</span><span className="info-value">{selected.comments.toLocaleString()}</span></div>
              </div>
            </Card>
          )}

          {state === 'error' && <p className="err">{err}</p>}
          {state === 'done' && result && (
            <div className="grid-2">
              <Card title="🎣 前3秒 Hook 总结">
                <div className="big-tag">{result.first3sHookSummary || '—'}</div>
                <p className="muted small">素材来源：{selected!.source || '原创'} · BGM：{selected!.bgm || '—'} · 时长：{selected!.durationSec}s</p>
              </Card>
              <Card title="🎯 主要拍摄主体">
                <p>{result.mainShootingSubject || '—'}</p>
              </Card>
              <Card title="🧠 爆款核心逻辑">
                <StructuredText text={result.coreHitLogic} />
              </Card>
              <Card title="🎬 完整视频结构">
                <StructuredText text={result.fullVideoStructure} />
              </Card>
              <Card title="🏷️ 爆款原因标签">
                <div className="tag-row">
                  {(result.hitReasonTags || []).map((r: string, i: number) => <span key={i} className="reason-chip">{r}</span>)}
                  {(result.hitReasonTags || []).length === 0 && <span className="muted">—</span>}
                </div>
                <div className="info-origin-tags" style={{ marginTop: 12 }}>
                  <div className="muted small">原视频标签</div>
                  <div className="tag-row" style={{ marginTop: 6 }}>
                    {selected && (selected.tags || []).length > 0
                      ? selected.tags.map((t: string, i: number) => <span key={i} className="mini-tag">#{t}</span>)
                      : <span className="muted">—</span>}
                  </div>
                </div>
              </Card>
              <Card title="📋 可复制选题生成">
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
