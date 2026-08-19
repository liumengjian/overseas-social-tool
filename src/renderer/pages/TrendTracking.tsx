import React, { useEffect, useState } from 'react';
import { Card, Badge, platformLabel } from '../components/ui';
import { Platform } from '../../shared/types';
import { summarizeTrends } from '../../analysis/trend-tracker';
import { useWorkflow } from '../workflowStore';
import { FACEBOOK_UNSUPPORTED_MESSAGE } from '../../data/providers/facebook';
import { InstagramProvider } from '../../data/providers/instagram';
import { platformUnsupportedMessage } from '../../data/providers/unsupported';
import { useTrendCache, refresh, ensureLoaded } from '../hotspotStore';

const COLORS: Record<string, string> = {
  tiktok: '#25F4EE',
  instagram: '#E1306C',
  youtube: '#FF0000',
  facebook: '#1877F2',
  twitter: '#1DA1F2',
};

// 所有可选平台（Facebook 仍不支持；Twitter 现已接到真实接口）
const PLATFORMS: Platform[] = ['tiktok', 'instagram', 'youtube', 'facebook', 'twitter'];

export default function TrendTracking() {
  const [platform, setPlatform] = useState<Platform>('tiktok');
  const [unsupported, setUnsupported] = useState(false);
  // Instagram 无搜索/hashtag 接口，热点由其「参考账号」Reels 聚合得到；这里允许用户在页面上实时调整
  const [igAccounts, setIgAccounts] = useState<string>(InstagramProvider.DEFAULT_ACCOUNTS.join(', '));
  const [config, setConfig] = useState<{ minimaxConfigured?: boolean } | null>(null);

  // 模块三：AI 标签清洗与关联推荐
  const [cleanResult, setCleanResult] = useState<any>(null);
  const [cleanError, setCleanError] = useState('');
  const pipe = useWorkflow('热点与Tag追踪');

  // 热点数据来自全局后台缓存（进入应用即已预拉取）：直接从缓存读取，不重复请求
  const tc = useTrendCache(platform);
  const trends = tc.trends;
  const hashtags = tc.hashtags;
  const loading = tc.loading;

  useEffect(() => { window.api.getConfig().then(setConfig); }, []);

  // 切换平台：优先用后台缓存；若缓存尚未就绪则兜底拉取一次（不重复请求已在加载中的平台）
  useEffect(() => {
    const unsupportedMsg = platformUnsupportedMessage(platform);
    if (unsupportedMsg) {
      setUnsupported(true);
      setCleanResult(null); setCleanError('');
      return;
    }
    setUnsupported(false);
    const accounts = platform === 'instagram'
      ? igAccounts.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    ensureLoaded(platform, accounts);
    setCleanResult(null); setCleanError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  async function runClean() {
    const raw = new Set<string>();
    trends.forEach((t) => t.relatedTags.forEach((x) => raw.add(x.replace(/^#/, ''))));
    hashtags.forEach((h) => raw.add(h.tag.replace(/^#/, '')));
    if (raw.size === 0) {
      setCleanError('暂无可清洗的标签（请先拉取热点数据）');
      return;
    }
    pipe.enqueue('清洗标签', async (runId, signal) => {
      setCleanError('');
      try {
        const res = await window.api.runAiTask({
          task: 'cleanTags',
          payload: { rawTags: Array.from(raw), business: '面向海外用户的中国入境旅游内容' },
          runId,
        });
        if (signal.aborted) return;
        setCleanResult(res);
      } catch (e: any) {
        if (signal.aborted) return;
        setCleanError(e?.message ?? String(e));
        throw e;
      }
    });
  }

  const summary = summarizeTrends(trends, hashtags);
  const canClean = config?.minimaxConfigured ?? false;
  // 「上升热点话题」：优先展示真正上升的；为空时回退展示该平台 Top 热门话题，避免一直空白
  const risingTopics = summary.rising.length > 0
    ? summary.rising
    : (summary.topByPlatform[platform] ?? []).slice(0, 8);
  const showRisingFallbackHint = summary.rising.length === 0 && risingTopics.length > 0;

  async function onRefresh() {
    const accounts = platform === 'instagram'
      ? igAccounts.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    await refresh(platform, accounts);
  }

  return (
    <div className="page">
      <h1>三、海外社媒热点与 Tag 追踪</h1>
      <p className="muted">基于 TiKhub 接口聚合中国旅游相关热点与 Hashtag（多时段快照计算增长率），并用 MiniMax-M3 清洗噪声标签、推荐关联标签。数据在应用启动时已在后台预拉取，切换平台直接展示。</p>

      <div className="row">
        {PLATFORMS.map((p) => {
          const active = platform === p;
          const isUnsupported = !!platformUnsupportedMessage(p);
          return (
            <button
              key={p}
              className={`pill ${active ? 'active' : ''}`}
              onClick={() => setPlatform(p)}
              style={{
                borderColor: COLORS[p],
                background: active ? COLORS[p] : 'transparent',
                color: active ? '#fff' : undefined,
                fontWeight: active ? 700 : 400,
                opacity: isUnsupported ? 0.85 : 1,
              }}
            >
              {platformLabel(p)}{isUnsupported ? '（不支持）' : ''}
            </button>
          );
        })}
        <button
          className="primary"
          style={{ marginLeft: 'auto' }}
          onClick={onRefresh}
          disabled={loading || unsupported}
          title="忽略缓存，重新向 TiKhub 拉取最新数据"
        >
          {loading ? '获取中…' : '重新获取数据'}
        </button>
      </div>

      {platform === 'instagram' && !unsupported && (
        <div className="row" style={{ marginTop: 12 }}>
          <label className="small" style={{ minWidth: 120 }}>Instagram 参考账号（逗号分隔）：</label>
          <input
            style={{ flex: 1 }}
            value={igAccounts}
            onChange={(e) => setIgAccounts(e.target.value)}
            placeholder="gotochinanow, natgeotravel, ..."
          />
          <button onClick={onRefresh} disabled={loading}>重新聚合</button>
        </div>
      )}

      {unsupported ? (
        <Card title="该平台暂不支持">
          <p className="muted">{platform === 'facebook' ? FACEBOOK_UNSUPPORTED_MESSAGE : platformUnsupportedMessage(platform)}</p>
          <p>热点与 Tag 追踪目前支持：TikTok（真实热门搜索词）、YouTube（关键词搜索）、Instagram（参考账号 Reels 聚合）、Twitter（真实热门趋势）。</p>
        </Card>
      ) : (
        <div className="grid-2">
          <Card title="上升热点话题">
            {loading && <p className="muted">加载中…</p>}
            <ul className="trend-list">
              {!loading && risingTopics.length === 0 && <li className="muted">暂无热点数据（请检查 TiKhub 令牌或点击「重新获取数据」）</li>}
              {risingTopics.slice(0, 8).map((t) => (
                <li key={t.keyword}>
                  <span>{t.keyword}</span>
                  {t.growth > 0
                    ? <Badge kind="ok">+{t.growth}%</Badge>
                    : t.isNew
                      ? <Badge kind="info">新</Badge>
                      : null}
                </li>
              ))}
            </ul>
            {showRisingFallbackHint && (
              <p className="muted small" style={{ marginTop: 8 }}>（首次获取，再次点击「重新获取数据」后将显示上升幅度）</p>
            )}
          </Card>

          <Card title="Hashtag 热度排行">
            {loading && <p className="muted">加载中…</p>}
            {!loading && hashtags.length === 0 ? (
              <p className="muted">暂无 Hashtag 数据</p>
            ) : (
              <div className="hbar-list">
                {hashtags.slice(0, 8).map((h) => {
                  const max = Math.max(...hashtags.map((x) => x.views), 1);
                  const pct = Math.round((h.views / max) * 100);
                  return (
                    <div key={h.tag} className="hbar-row">
                      <span className="hbar-tag">{h.tag}</span>
                      <span className="hbar-track"><span className="hbar-fill" style={{ width: `${pct}%`, background: COLORS[platform] }} /></span>
                      <span className="hbar-val">{(h.views / 1e6).toFixed(1)}M</span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card title="关联 Tag 推荐（规则聚合）">
            {summary.relatedTagSuggestions.length === 0 ? (
              <p className="muted">暂无关联 Tag 推荐</p>
            ) : (
              <div className="tag-row">
                {summary.relatedTagSuggestions.map((t) => <span key={t} className="trend-chip">{t}</span>)}
              </div>
            )}
          </Card>

          <Card title="跨平台 Tag 表现对比">
            {summary.platformComparison.length === 0 ? (
              <p className="muted">暂无对比数据</p>
            ) : (
              <table className="tbl">
                <thead><tr><th>平台</th><th>总播放</th><th>平均增长</th></tr></thead>
                <tbody>
                  {summary.platformComparison.map((c) => (
                    <tr key={c.platform}><td>{platformLabel(c.platform)}</td><td>{c.totalViews.toLocaleString()}</td><td><Badge kind={c.avgGrowth >= 0 ? 'ok' : 'warn'}>{c.avgGrowth >= 0 ? '+' : ''}{c.avgGrowth.toFixed(0)}%</Badge></td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}

      <Card title="AI 标签清洗与关联推荐">
        <button className="primary" onClick={runClean} disabled={!canClean || loading || unsupported}>
          {loading && !cleanResult ? 'AI 清洗中…' : 'AI 清洗噪声标签 + 推荐关联标签'}
        </button>
        {!canClean && <p className="muted" style={{ marginTop: 8 }}>未配置 MiniMax（在 .env 填写 MINIMAX_API_KEY 后启用 AI 清洗）。</p>}
        {cleanError && <p className="err">{cleanError}</p>}
        {cleanResult && (
          <div className="grid-2" style={{ marginTop: 12 }}>
            <div>
              <h4>有效标签（已过滤噪声）</h4>
              <ul className="kv small">
                {(cleanResult.validTagList ?? []).map((t: any, i: number) => (
                  <li key={i}><b>#{t.tagName}</b>：{t.tagTopicDesc}</li>
                ))}
                {(cleanResult.validTagList ?? []).length === 0 && <li className="muted">无有效标签</li>}
              </ul>
            </div>
            <div>
              <h4>关联推荐标签</h4>
              <div className="tag-row">
                {(cleanResult.relatedRecommendTags ?? []).map((t: string, i: number) => <span key={i} className="trend-chip">#{t}</span>)}
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
