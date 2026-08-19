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
  const [busy, setBusy] = useState(false);
  const pipe = useWorkflow('自身账号分析');

  React.useEffect(() => { window.api.getConfig().then(setConfig); }, []);

  // 跨重启恢复上次操作数据
  React.useEffect(() => {
    window.api.getJson('own_account').then((s: any) => {
      if (!s) return;
      if (s.platform) setPlatform(s.platform);
      if (typeof s.url === 'string') setUrl(s.url);
      if (s.account) setAccount(s.account);
      if (Array.isArray(s.ownVideos)) setOwnVideos(s.ownVideos);
      if (s.analysis) setAnalysis(s.analysis);
    }).catch(() => {});
  }, []);

  async function run() {
    if (!url.trim()) return;
    // TiKhub 暂不支持的平台（Facebook / Twitter）直接提示，避免发起无效请求
    const unsupportedMsg = platformUnsupportedMessage(platform);
    if (unsupportedMsg) {
      setError(unsupportedMsg);
      return;
    }
    setBusy(true);
    pipe.enqueue('自身账号分析', async (runId, signal) => {
      setError('');
      setAccount(null);
      setOwnVideos([]);
      setAnalysis(null);
      try {
        // 仅输入账号链接：粉丝/简介/作品全部来自 TiKhub 实时拉取
        const acc: SocialAccount = await window.api.fetchAccount({ platform, url: url.trim(), runId });
        if (signal.aborted) return;
        // 抓取上限取设置中的「默认抓取视频数量」（1~50，默认 50）；不足则全部抓取
        const crawlLimit = Math.min(50, Math.max(1, config?.fetchVideoCount ?? 50));
        const videos: SocialVideo[] = await window.api.fetchVideos({ platform, url: url.trim(), limit: crawlLimit, runId });
        if (signal.aborted) return;
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
        if (signal.aborted) return;
        setAnalysis(res);
        // 持久化本次操作数据（输入 + 结果），下次打开直接展示
        window.api.setJson('own_account', { platform, url: url.trim(), account: acc, ownVideos: videos, analysis: res }).catch(() => {});
      } catch (e: any) {
        if (signal.aborted) return;
        setError(e?.message ?? String(e));
        throw e;
      } finally {
        setBusy(false);
      }
    });
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
          <button className="primary" onClick={run} disabled={busy || !url.trim() || !canAnalyze}>{busy ? '拉取中…' : '生成对标报告'}</button>
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
