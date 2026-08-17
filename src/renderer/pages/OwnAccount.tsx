import React, { useState } from 'react';
import { Card, Badge, platformLabel } from '../components/ui';
import { Platform, SocialVideo, SocialAccount, AppConfig } from '../../shared/types';
import { useWorkflow } from '../workflowStore';
import { platformUnsupportedMessage } from '../../data/providers/unsupported';

export default function OwnAccount() {
  const [platform, setPlatform] = useState<Platform>('tiktok');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [account, setAccount] = useState<SocialAccount | null>(null);
  const [ownVideos, setOwnVideos] = useState<SocialVideo[]>([]);
  const [analysis, setAnalysis] = useState<any>(null);
  const pipe = useWorkflow();

  React.useEffect(() => { window.api.getConfig().then(setConfig); }, []);

  async function run() {
    if (!url.trim()) return;
    // TiKhub 暂不支持的平台（Facebook / Twitter）直接提示，避免发起无效请求
    const unsupportedMsg = platformUnsupportedMessage(platform);
    if (unsupportedMsg) {
      setError(unsupportedMsg);
      return;
    }
    const runId = pipe.start();
    setError('');
    setAccount(null);
    setOwnVideos([]);
    setAnalysis(null);
    try {
      // 仅输入账号链接：粉丝/简介/作品全部来自 TiKhub 实时拉取
      const acc: SocialAccount = await window.api.fetchAccount({ platform, url: url.trim(), runId });
      const videos: SocialVideo[] = await window.api.fetchVideos({ platform, url: url.trim(), limit: 2000, runId });
      setAccount(acc);
      setOwnVideos(videos);

      // 模块六：用 MiniMax-M3 聚合分析视频数据，输出优化建议
      const videoData = videos
        .map((v, i) => {
          const er = v.views > 0 ? ((v.likes + v.comments + v.shares) / v.views * 100).toFixed(2) : '0';
          return `视频${i + 1}：标题「${v.title || v.caption}」 播放${v.views} 赞${v.likes} 评论${v.comments} 分享${v.shares} 收藏${v.favorites} 互动率${er}% 时长${v.durationSec}s 标签${(v.tags || []).join('/') || '无'}`;
        })
        .join('\n');
      const res = await window.api.runAiTask({
        task: 'analyzeOwnAccount',
        payload: { videoData: `账号：${acc.name}｜粉丝：${acc.followers}｜作品数：${videos.length}\n${videoData}` },
        runId,
      });
      setAnalysis(res);
      pipe.finish();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      pipe.finish();
    }
  }

  const canAnalyze = config?.minimaxConfigured ?? false;

  return (
    <div className="page">
      <h1>六、自身账号数据分析</h1>
      <p className="muted">只需粘贴自身账号链接，粉丝、简介、视频与平均播放均由 TiKhub 接口实时拉取，并由 MiniMax-M3 聚合分析内容特征、输出运营优化建议。</p>

      <Card title="输入自身账号">
        <div className="row">
          <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
            <option value="tiktok">TikTok</option><option value="instagram">Instagram</option>
            <option value="youtube">YouTube</option><option value="facebook">Facebook</option><option value="twitter">Twitter</option>
          </select>
          <input placeholder="粘贴自身账号链接，如 https://www.tiktok.com/@yourname" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} />
          <button className="primary" onClick={run} disabled={pipe.state.loading || !url.trim() || !canAnalyze}>{pipe.state.loading ? '拉取中…' : '生成对标报告'}</button>
        </div>
        {!canAnalyze && <p className="muted" style={{ marginTop: 10 }}>未配置 MiniMax（在 .env 填写 MINIMAX_API_KEY 后重启即可启用 AI 分析）。</p>}
        {error && <p className="err" style={{ marginTop: 10 }}>{error}</p>}
      </Card>

      {account && (
        <div className="stat-row">
          <Card><div className="stat"><div className="stat-value">{account.followers?.toLocaleString() ?? 0}</div><div className="stat-label">{account.name} 粉丝</div></div></Card>
          <Card><div className="stat"><div className="stat-value">{ownVideos.length}</div><div className="stat-label">已抓取视频</div></div></Card>
          <Card><div className="stat"><div className="stat-value">{Math.round(ownVideos.reduce((s, v) => s + v.views, 0) / Math.max(ownVideos.length, 1)).toLocaleString()}</div><div className="stat-label">平均播放</div></div></Card>
        </div>
      )}

      {analysis && (
        <>
          <Card title="高表现内容共同特征">
            <p>{analysis.highPerformanceContentFeature || '—'}</p>
          </Card>
          <Card title="低表现内容存在问题">
            <p>{analysis.lowPerformanceProblem || '—'}</p>
          </Card>
          <Card title="AI 运营优化建议">
            <ul className="kv">
              {(analysis.optimizationSuggest || []).map((s: string, i: number) => <li key={i}>{s}</li>)}
              {(analysis.optimizationSuggest || []).length === 0 && <li className="muted">—</li>}
            </ul>
          </Card>
        </>
      )}

    </div>
  );
}
