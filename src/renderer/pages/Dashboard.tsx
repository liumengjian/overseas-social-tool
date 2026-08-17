import React, { useEffect, useState } from 'react';
import { Card, Stat, Badge, Spinner, platformLabel } from '../components/ui';
import { SocialVideo, TrendTopic } from '../../shared/types';

export default function Dashboard({ onNavigate }: { onNavigate: (t: any) => void }) {
  const [videos, setVideos] = useState<SocialVideo[] | null>(null);
  const [trends, setTrends] = useState<TrendTopic[]>([]);

  useEffect(() => {
    window.api.getVideoDb().then(setVideos);
    Promise.all(['tiktok', 'instagram', 'youtube', 'facebook', 'twitter'].map((p) => window.api.fetchTrends({ platform: p as any })))
      .then((arr) => setTrends(arr.flat()));
  }, []);

  if (!videos) return <Spinner />;

  const totalViews = videos.reduce((s, v) => s + v.views, 0);
  const convVideos = videos.filter((v) => v.isConversionOriented).length;
  const byPlatform: Record<string, number> = {};
  videos.forEach((v) => (byPlatform[v.platform] = (byPlatform[v.platform] ?? 0) + 1));

  return (
    <div className="page">
      <h1>总览仪表盘</h1>
      <p className="muted">竞对视频 {videos.length} 条 · 累计播放 {totalViews.toLocaleString()} · 覆盖平台 {Object.keys(byPlatform).length} 个</p>

      <div className="stat-row">
        <Card><Stat label="视频库总量" value={videos.length} /></Card>
        <Card><Stat label="累计播放" value={totalViews.toLocaleString()} /></Card>
        <Card><Stat label="转化导向视频" value={convVideos} sub={`占比 ${videos.length ? Math.round((convVideos / videos.length) * 100) : 0}%`} /></Card>
      </div>

      <div className="grid-2">
        <Card title="平台视频分布">
          <ul className="kv">
            {Object.entries(byPlatform).map(([p, n]) => (
              <li key={p}><span>{platformLabel(p)}</span><Badge kind="info">{n}</Badge></li>
            ))}
          </ul>
        </Card>
        <Card title="实时上升热点（Top 5）">
          <div className="tag-row">
            {trends.filter((t) => t.growth > 0).sort((a, b) => b.growth - a.growth).slice(0, 5).map((t) => (
              <span key={t.platform + t.keyword} className="trend-chip">{t.keyword} <em>+{t.growth}%</em></span>
            ))}
            {trends.filter((t) => t.growth > 0).length === 0 && <span className="muted">暂无上升热点（需多时段快照才能计算增长率）</span>}
          </div>
        </Card>
      </div>

      <div className="quick-nav">
        <button onClick={() => onNavigate('competitor')}>竞对分析 →</button>
        <button onClick={() => onNavigate('conversion')}>高转化分析 →</button>
        <button onClick={() => onNavigate('ai')}>AI 剪辑 →</button>
      </div>
    </div>
  );
}
