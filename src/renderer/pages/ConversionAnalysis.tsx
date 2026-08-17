import React, { useEffect, useState } from 'react';
import { Card, Badge, Spinner, Empty, platformLabel } from '../components/ui';
import { SocialVideo } from '../../shared/types';
import { useWorkflow } from '../workflowStore';

interface ConversionRow {
  videoId: string;
  title: string;
  platform: string;
  engagementRate: number;
  productImplantMethod: string;
  potentialConversionLevel: '高' | '中' | '低';
  userConsultDemands: string[];
  summary: string;
  score: number;
}

const LEVEL_SCORE: Record<string, number> = { '高': 85, '中': 60, '低': 35 };

export default function ConversionAnalysis() {
  const [videos, setVideos] = useState<SocialVideo[]>([]);
  const [rows, setRows] = useState<ConversionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pipe = useWorkflow();

  useEffect(() => {
    window.api.getVideoDb().then((v) => { setVideos(v); setLoading(false); });
  }, []);

  async function analyze() {
    const runId = pipe.start();
    setError('');
    const results: ConversionRow[] = [];
    for (const v of videos) {
      try {
        const detail = await window.api.fetchVideoDetail({ platform: v.platform, videoId: v.id, runId });
        const mediaUrl = detail.mediaUrl || v.mediaUrl;
        const comments = (detail.comments || []).slice(0, 12).map((c) => c.text);
        const r = await window.api.runAiTask({
          task: 'analyzeConversionVideo',
          payload: { desc: v.caption, comments, url: mediaUrl },
          runId,
        });
        const er = v.views > 0 ? Math.round(((v.likes + v.comments + v.shares) / v.views) * 10000) / 100 : 0;
        results.push({
          videoId: v.id,
          title: v.title || v.caption,
          platform: v.platform,
          engagementRate: er,
          productImplantMethod: r?.productImplantMethod ?? '无植入',
          potentialConversionLevel: (['高', '中', '低'].includes(r?.potentialConversionLevel) ? r.potentialConversionLevel : '中') as '高' | '中' | '低',
          userConsultDemands: Array.isArray(r?.userConsultDemands) ? r.userConsultDemands : [],
          summary: r?.summary ?? '',
          score: (LEVEL_SCORE[r?.potentialConversionLevel] ?? 60) + Math.min(15, Math.round(er)),
        });
      } catch (e: any) {
        // 单条失败不影响其余，但仍记录其处理流程（已通过 progress 事件推送到前端）
        setError((prev) => prev ? `${prev}\n部分视频分析失败：${e?.message ?? e}` : `部分视频分析失败：${e?.message ?? e}`);
      }
    }
    results.sort((a, b) => b.score - a.score);
    setRows(results);
    pipe.finish();
  }

  const highCount = rows.filter((r) => r.potentialConversionLevel === '高').length;

  return (
    <div className="page">
      <h1>五、高转化视频分析（重点）</h1>
      <p className="muted">针对旅行社 / 定制游转化型账号视频，调用 MiniMax-M3 多模态识别产品植入方式、判断潜在咨询转化强度，挖掘高转化内容规律。</p>

      {loading ? <Spinner /> : videos.length === 0 ? (
        <Empty text="暂无视频数据，请先在「二、视频数据库」抓取竞对视频" />
      ) : (
        <>
          <div className="stat-row">
            <Card><div className="stat"><div className="stat-value">{videos.length}</div><div className="stat-label">分析视频</div></div></Card>
            <Card><div className="stat"><div className="stat-value">{highCount}</div><div className="stat-label">高转化潜力</div></div></Card>
            <Card><div className="stat"><div className="stat-value">{rows[0]?.score ?? 0}</div><div className="stat-label">最高转化潜力</div></div></Card>
          </div>

          <Card title="AI 转化分析">
            <button className="primary" onClick={analyze} disabled={pipe.state.loading || rows.length > 0}>
              {pipe.state.loading ? '分析中（逐条调用 MiniMax-M3）…' : rows.length ? '重新分析' : '开始分析'}
            </button>
            {error && <p className="err" style={{ marginTop: 8 }}>{error}</p>}
            {rows.length === 0 && !pipe.state.loading && (
              <p className="muted" style={{ marginTop: 8 }}>点击上方按钮，对视频库全部视频逐条做转化潜力分析。</p>
            )}
          </Card>

          {rows.length > 0 && (
            <Card title="转化潜力排行（按评分）">
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>视频</th><th>平台</th><th>互动率</th><th>产品植入方式</th><th>转化强度</th><th>用户咨询诉求</th><th>评分</th></tr></thead>
                  <tbody>
                    {rows.slice(0, 20).map((r) => (
                      <tr key={r.videoId}>
                        <td className="small">{r.title}</td>
                        <td>{platformLabel(r.platform)}</td>
                        <td>{r.engagementRate}%</td>
                        <td>{r.productImplantMethod === '无植入' ? <Badge>无植入</Badge> : <Badge kind="conv">{r.productImplantMethod}</Badge>}</td>
                        <td>
                          {r.potentialConversionLevel === '高' ? <Badge kind="conv">高</Badge> : r.potentialConversionLevel === '中' ? <Badge kind="warn">中</Badge> : <Badge kind="info">低</Badge>}
                        </td>
                        <td className="small muted">{(r.userConsultDemands || []).slice(0, 3).join('；') || '—'}</td>
                        <td><b>{r.score}</b></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {rows.length > 0 && (
            <Card title="转化核心结论">
              <ul className="kv">
                <li><b>高转化视频（{highCount} 条）</b>普遍采用 <b>{[...new Set(rows.filter((r) => r.potentialConversionLevel === '高').map((r) => r.productImplantMethod))].join(' / ') || '—'}</b> 作为承接入口。</li>
                <li>产品植入方式多样：{ [...new Set(rows.map((r) => r.productImplantMethod))].join('、') || '—'}。</li>
                <li>建议：把高转化视频的 Hook 与结构沉淀为模板，批量复用于新内容。</li>
              </ul>
            </Card>
          )}
        </>
      )}

    </div>
  );
}
