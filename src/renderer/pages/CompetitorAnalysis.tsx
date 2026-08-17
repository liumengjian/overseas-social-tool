import React, { useEffect, useState } from 'react';
import { Card, Badge, Empty, platformLabel, Pipeline } from '../components/ui';
import { Platform, SocialAccount, SocialVideo, AppConfig } from '../../shared/types';
import { useWorkflow } from '../workflowStore';
import { platformUnsupportedMessage } from '../../data/providers/unsupported';

export default function CompetitorAnalysis() {
  const [inputs, setInputs] = useState<{ platform: Platform; url: string }[]>([]);
  const [platform, setPlatform] = useState<Platform>('tiktok');
  const [url, setUrl] = useState('');
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState('');
  const [includeVideos, setIncludeVideos] = useState(true); // 自动拉取账号视频作为分析依据（消耗 TiKhub 额度）
  const pipe = useWorkflow();

  useEffect(() => { window.api.getConfig().then(setConfig); }, []);

  function add() {
    if (!url.trim()) return;
    setInputs((p) => [...p, { platform, url: url.trim() }]);
    setUrl('');
  }

  async function analyze() {
    // TiKhub 暂不支持的平台（Facebook / Twitter）：直接拦截，避免发起无效请求
    const bad = inputs.filter((i) => platformUnsupportedMessage(i.platform)).map((i) => `${platformLabel(i.platform)}（${i.url}）`);
    if (bad.length) {
      setError(`以下账号所属平台暂不支持（TiKhub 未提供接口）：${bad.join('；')}`);
      return;
    }
    const runId = pipe.start();
    setError('');
    setAccounts(null);
    try {
      const db: SocialVideo[] = await window.api.getVideoDb();
      const results: SocialAccount[] = [];
      for (const i of inputs) {
        const acc = await window.api.fetchAccount({ platform: i.platform, url: i.url, runId });
        // 优先复用视频库中已抓取的该账号视频；没有则（按需）自动拉取该账号视频作为分析依据
        let vids = db.filter((v) => v.platform === i.platform && (v.authorId === acc.uniqueId || v.url.includes(acc.uniqueId)));
        if (vids.length === 0 && includeVideos) {
          try {
            const fetched = await window.api.fetchVideos({ platform: i.platform, url: i.url, limit: 2000, runId });
            vids = fetched;
          } catch (ve: any) {
            setError((prev) => prev ? `${prev}\n拉取 ${acc.name} 视频失败：${ve?.message ?? ve}` : `拉取 ${acc.name} 视频失败：${ve?.message ?? ve}`);
          }
        }
        // 模块一：用 MiniMax-M3 多模态分析账号（依据简介 + 样本作品标题）
        const samplePosts = vids.slice(0, 3).map((v) => v.title || v.caption || v.hook).filter(Boolean);
        const analysis = await window.api.runAiTask({
          task: 'analyzeAccount',
          payload: { bio: acc.bio ?? '', samplePosts },
          runId,
        });
        const isConv = analysis?.account_type === '流量型账号' ? false : true;
        results.push({
          ...acc,
          category: isConv ? 'conversion' : 'traffic',
          categoryReason: analysis?.reason ?? 'AI 未返回分类依据',
          businessPosition: analysis?.account_business_position ?? '',
          targetAudience: analysis?.target_audience ?? '',
          drainageMethod: analysis?.drainage_method ?? '',
          categoryEvidence: [
            `粉丝：${(acc.followers ?? 0).toLocaleString()}`,
            `作品：${acc.videoCount ?? vids.length} 条`,
            samplePosts.length ? `样本作品：${samplePosts.length} 条` : '无作品样本',
          ],
        });
      }
      setAccounts(results);
      pipe.finish();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      pipe.finish();
    }
  }

  const conv = accounts?.filter((a) => a.category === 'conversion').length ?? 0;

  return (
    <div className="page">
      <h1>一、竞对账号智能分析</h1>
      <p className="muted">输入各平台竞对账号链接，系统自动解析并调用 MiniMax-M3 区分「转化型 / 流量型」账号，输出业务定位、目标客群与引流方式。</p>

      <Card title="添加竞对账号">
        <div className="row">
          <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
            <option value="tiktok">TikTok</option>
            <option value="instagram">Instagram</option>
            <option value="youtube">YouTube</option>
            <option value="facebook">Facebook</option>
            <option value="twitter">Twitter</option>
          </select>
          <input placeholder="粘贴账号链接，如 https://www.tiktok.com/@xxx" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} />
          <button onClick={add} disabled={!url.trim()}>添加</button>
        </div>
        {inputs.length === 0 ? (
          <p className="muted" style={{ marginTop: 10 }}>暂无竞对账号，粘贴链接后点击「添加」。</p>
        ) : (
          <ul className="kv">
            {inputs.map((i, idx) => (
              <li key={idx}><span className="muted">{platformLabel(i.platform)}</span> <code>{i.url}</code>
                <button className="link" onClick={() => setInputs((s) => s.filter((_, k) => k !== idx))}>移除</button></li>
            ))}
          </ul>
        )}
        <button className="primary" onClick={analyze} disabled={pipe.state.loading || inputs.length === 0 || !config?.tokenConfigured || !config?.minimaxConfigured}>
          {pipe.state.loading ? '分析中…' : '开始分析'}
        </button>
        <label className="check">
          <input type="checkbox" checked={includeVideos} onChange={(e) => setIncludeVideos(e.target.checked)} />
          同时拉取该账号视频作为分析依据（消耗 TiKhub 额度）
        </label>
        {config && (!config.tokenConfigured || !config.minimaxConfigured) && (
          <p className="muted" style={{ marginTop: 10 }}>
            {!config.tokenConfigured && '未配置 TiKhub 令牌（在 .env 填写 TIKHUB_API_TOKEN）。'}
            {!config.minimaxConfigured && '未配置 MiniMax（在 .env 填写 MINIMAX_API_KEY 用于 AI 账号分类）。'}
          </p>
        )}
      </Card>

      {error && <p className="err">{error}</p>}
      {accounts && accounts.length === 0 && <Empty text="未获取到竞对账号数据" />}
      {accounts && accounts.length > 0 && (
        <>
          <div className="stat-row">
            <Card><div className="stat"><div className="stat-value">{accounts.length}</div><div className="stat-label">竞对账号</div></div></Card>
            <Card><div className="stat"><div className="stat-value">{conv}</div><div className="stat-label">转化型账号</div></div></Card>
            <Card><div className="stat"><div className="stat-value">{accounts.length - conv}</div><div className="stat-label">流量型账号</div></div></Card>
          </div>
          <Card title="分类结果">
            <table className="tbl">
              <thead><tr><th>平台</th><th>账号</th><th>粉丝</th><th>分类</th><th>业务定位 / 客群 / 引流</th><th>依据</th></tr></thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td>{platformLabel(a.platform)}</td>
                    <td>{a.name}</td>
                    <td>{(a.followers ?? 0).toLocaleString()}</td>
                    <td>{a.category === 'conversion' ? <Badge kind="conv">转化型</Badge> : <Badge kind="traffic">流量型</Badge>}</td>
                    <td className="muted small">
                      <div><b>定位：</b>{a.businessPosition || '—'}</div>
                      <div><b>客群：</b>{a.targetAudience || '—'}</div>
                      <div><b>引流：</b>{a.drainageMethod || '—'}</div>
                    </td>
                    <td className="muted small">
                      <div>{a.categoryReason}</div>
                      {a.categoryEvidence && a.categoryEvidence.length > 0 && (
                        <ul className="ev">
                          {a.categoryEvidence.map((e, k) => <li key={k}>{e}</li>)}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

    </div>
  );
}
