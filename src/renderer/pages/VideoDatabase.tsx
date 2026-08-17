import React, { useEffect, useRef, useState } from 'react';
import { Card, platformLabel } from '../components/ui';
import { SocialVideo, AppConfig, Platform } from '../../shared/types';
import { useWorkflow } from '../workflowStore';
import { platformUnsupportedMessage } from '../../data/providers/unsupported';

type AnalysisState = 'idle' | 'loading' | 'done' | 'error';

function safeName(s: string): string {
  return (s || 'video').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
}

/** 解析一行 CSV（支持字段内逗号与双引号转义），返回字段数组 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** 把导出的 CSV 解析回 SocialVideo[]（按 id 合并到本地库，不覆盖历史） */
function parseVideoCsv(text: string): SocialVideo[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const idx = (name: string) => header.indexOf(name);
  const iPlatform = idx('platform'), iAuthor = idx('author'), iTitle = idx('title');
  const iViews = idx('views'), iLikes = idx('likes'), iComments = idx('comments');
  const iShares = idx('shares'), iFav = idx('favorites'), iDur = idx('durationSec');
  const iTags = idx('tags'), iUrl = idx('url');
  return lines.slice(1).map((l, n) => {
    const f = parseCsvLine(l);
    const url = (f[iUrl] ?? '').trim();
    const m = url.match(/video\/(\d+)/);
    const id = m ? `tiktok_${m[1]}` : `import_${n}_${safeName(f[iTitle] ?? '')}`;
    const title = (f[iTitle] ?? '').trim();
    return {
      id,
      platform: (f[iPlatform] || 'tiktok') as Platform,
      authorId: (f[iAuthor] ?? 'unknown').trim(),
      authorName: (f[iAuthor] ?? 'unknown').trim(),
      url: url || `https://www.tiktok.com/${id}`,
      publishTime: new Date().toISOString(),
      title,
      caption: title,
      hook: title.slice(0, 60),
      views: Number(f[iViews] || 0),
      likes: Number(f[iLikes] || 0),
      comments: Number(f[iComments] || 0),
      shares: Number(f[iShares] || 0),
      favorites: Number(f[iFav] || 0),
      durationSec: Number(f[iDur] || 0),
      structure: '',
      source: '',
      tags: (f[iTags] ?? '').split('|').map((t) => t.trim()).filter(Boolean),
      bgm: '',
      isVideo: true,
      mediaType: 'video',
    } as SocialVideo;
  });
}

export default function VideoDatabase() {
  const [platform, setPlatform] = useState<Platform>('tiktok');
  const [url, setUrl] = useState('');
  const [videos, setVideos] = useState<SocialVideo[]>([]);
  const [filter, setFilter] = useState('');
  const [onlyConv, setOnlyConv] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [fetchError, setFetchError] = useState('');
  const [syncResult, setSyncResult] = useState('');

  // AI 分析状态
  const [analysis, setAnalysis] = useState<any>(null);
  const [analysisVideo, setAnalysisVideo] = useState<SocialVideo | null>(null);
  const [analysisState, setAnalysisState] = useState<AnalysisState>('idle');
  const [analysisError, setAnalysisError] = useState('');

  // 预览 / 下载
  const [preview, setPreview] = useState<SocialVideo | null>(null);
  const [downloadingId, setDownloadingId] = useState('');

  // 分页（每页 20 条）
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);
  // AI 解析采用方式（direct=直连；sanitized=脱敏重编码后；frames=抽帧图片集）
  const [analysisMethod, setAnalysisMethod] = useState<'direct' | 'sanitized' | 'frames' | null>(null);

  const csvInputRef = useRef<HTMLInputElement | null>(null);
  const pipe = useWorkflow();

  useEffect(() => { window.api.getConfig().then(setConfig); }, []);
  async function loadDb() {
    const db = await window.api.getVideoDb();
    setVideos(db);
  }
  useEffect(() => { loadDb(); }, []);

  async function fetchVideos() {
    if (!url.trim()) return;
    // TiKhub 暂不支持的平台（Facebook / Twitter）直接提示，避免发起无效请求
    const unsupportedMsg = platformUnsupportedMessage(platform);
    if (unsupportedMsg) {
      setFetchError(unsupportedMsg);
      return;
    }
    const runId = pipe.start();
    setFetchError('');
    try {
      // fetchVideos 已返回「合并后的本地库」（含历史抓取），不会覆盖旧数据
      const res = await window.api.fetchVideos({ platform, url: url.trim(), limit: 2000, runId });
      setVideos(res);
      if (res.length === 0) {
        setFetchError('未抓取到视频。若接口返回 402，通常是 TiKhub 账户余额/免费额度不足，请到 https://tikhub.io 充值后重试（详见下方「实时处理流程」）。');
      }
      pipe.finish();
    } catch (e: any) {
      setFetchError(e?.message ?? String(e));
      pipe.finish();
    }
  }

  // 模块二：调用 MiniMax-M3 多模态解析（模块内分析，不跳转）。
  // 使用「自动脱敏恢复」流程：直连解析被判定敏感时，自动重新编码/抽帧脱敏后重试，
  // 成功后回写数据库媒体链接，保证该视频后续也能正常解析。
  async function runAnalysis(v: SocialVideo) {
    const runId = pipe.start();
    setAnalysisVideo(v);
    setAnalysisState('loading');
    setAnalysisError('');
    setAnalysis(null);
    setAnalysisMethod(null);
    try {
      const res = await window.api.analyzeVideoSafe({ platform: v.platform, videoId: v.id, runId });
      setAnalysis(res.analysis);
      setAnalysisMethod(res.method);
      setAnalysisState('done');
      pipe.finish();
    } catch (e: any) {
      setAnalysisError(e?.message ?? String(e));
      setAnalysisState('error');
      pipe.finish();
    }
  }

  async function download(v: SocialVideo) {
    const mediaUrl = v.mediaUrl;
    if (!mediaUrl) {
      setFetchError('该视频没有可用的直链，无法下载。可尝试在浏览器中打开原链接。');
      return;
    }
    setDownloadingId(v.id);
    try {
      const r = await window.api.downloadVideo({
        url: mediaUrl,
        filename: `${safeName(v.authorName)}-${safeName(v.title || v.id)}.mp4`,
      });
      if (!r.saved) setFetchError(`下载失败：${r.error ?? '未知错误'}`);
    } catch (e: any) {
      setFetchError(e?.message ?? String(e));
    } finally {
      setDownloadingId('');
    }
  }

  // 批量把视频库直链上传到 MiniMax，并把 mediaUrl 切换为 mm_file:// 引用（解决 MiniMax 拉不到临时直链的问题）
  async function syncToMiniMax() {
    const runId = pipe.start();
    setSyncResult('');
    try {
      const res = await window.api.uploadVideosToMiniMax({ runId });
      setSyncResult(`同步完成：成功 ${res.uploaded} 个，失败 ${res.failed} 个（共 ${res.total} 个待上传）。失败多为下载超时，可重试。`);
      pipe.finish();
    } catch (e: any) {
      setSyncResult(`同步失败：${e?.message ?? String(e)}`);
      pipe.finish();
    }
  }

  // 导入 CSV（与导出格式一致；按 id 合并到本地库，不覆盖历史）
  async function onImportCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseVideoCsv(text);
      if (!parsed.length) {
        setFetchError('CSV 解析为空，请确认文件格式与导出一致（含表头 platform,author,title,...）。');
        return;
      }
      const res = await window.api.importVideos(parsed);
      await loadDb();
      setFetchError('');
      setSyncResult(`已导入 ${res.imported} 条视频到本地库（按 id 合并，不覆盖历史）。`);
    } catch (err: any) {
      setFetchError(`CSV 导入失败：${err?.message ?? String(err)}`);
    }
  }

  function exportCsv() {
    const header = ['platform', 'author', 'title', 'views', 'likes', 'comments', 'shares', 'favorites', 'durationSec', 'tags', 'url'];
    const rows = filtered.map((v) => [v.platform, v.authorName, `"${v.title.replace(/"/g, '')}"`, v.views, v.likes, v.comments, v.shares, v.favorites, v.durationSec, v.tags.join('|'), v.url]);
    const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'video_db.csv';
    a.click();
  }

  const filtered = videos.filter((v) => {
    if (onlyConv && !v.isConversionOriented) return false;
    if (filter && !(`${v.title} ${v.caption} ${v.tags.join(' ')}`.toLowerCase().includes(filter.toLowerCase()))) return false;
    return true;
  });

  // 默认按发布时间倒序（最新拉取的视频排在最前）
  const sorted = React.useMemo(
    () => [...filtered].sort((a, b) => new Date(b.publishTime).getTime() - new Date(a.publishTime).getTime()),
    [filtered],
  );

  // 分页：每页 20 条
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const pageItems = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // 筛选条件变化时回到第 1 页
  React.useEffect(() => { setPage(1); }, [filter, onlyConv, videos.length]);

  const canAnalyze = config?.minimaxConfigured ?? false;

  return (
    <div className="page">
      <h1>二、竞对视频数据抓取与视频库</h1>
      <p className="muted">抓取竞对账号全部视频基础数据（仅视频类型，剔除图文/相册帖），构建旅游行业视频数据库；并调用 MiniMax-M3 多模态解析视频 Hook、结构、主体与用户关注点。支持本地下载、预览与批量上传到 MiniMax。</p>

      <Card title="抓取竞对视频">
        <div className="row">
          <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
            <option value="tiktok">TikTok</option>
            <option value="instagram">Instagram</option>
            <option value="youtube">YouTube</option>
            <option value="facebook">Facebook</option>
            <option value="twitter">Twitter</option>
          </select>
          <input value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} placeholder="输入竞对账号链接，如 https://www.tiktok.com/@vietravelofficial" />
          <button onClick={fetchVideos} disabled={pipe.state.loading || !url.trim()}>{pipe.state.loading ? '抓取中…' : '抓取全部视频'}</button>
          <button className="ghost" onClick={loadDb}>载入本地库</button>
        </div>
        {fetchError && <p className="err">{fetchError}</p>}
        {!canAnalyze && (
          <p className="muted" style={{ marginTop: 10 }}>
            未配置 MiniMax（在 <code>.env</code> 填写 <code>MINIMAX_API_KEY</code> 后重启即可启用 AI 视频解析）。当前仅做指标分析。
          </p>
        )}
      </Card>

      <Card title={`视频库（${filtered.length} 条）`} right={<>
        <input placeholder="搜索标题/文案/标签" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 180 }} />
        <label className="check"><input type="checkbox" checked={onlyConv} onChange={(e) => setOnlyConv(e.target.checked)} /> 仅转化导向</label>
        <button className="ghost" onClick={exportCsv}>导出 CSV</button>
        <button className="ghost" onClick={() => csvInputRef.current?.click()}>导入 CSV</button>
        <input ref={csvInputRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={onImportCsv} />
        <button className="primary" onClick={syncToMiniMax} disabled={pipe.state.loading}>同步到 MiniMax</button>
      </>}>
        {syncResult && <p className="muted" style={{ marginBottom: 8 }}>{syncResult}</p>}
        {filtered.length === 0 ? (
          <p className="empty">暂无视频数据。请在上方输入竞对账号链接并点击「抓取全部视频」，或点击「载入本地库」查看已抓取记录，或通过「导入 CSV」恢复导出数据。</p>
        ) : (<>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>平台</th><th>类型</th><th>作者</th><th>标题/Hook</th><th>播放</th><th>赞</th><th>评</th><th>分享</th><th>时长</th><th>标签</th><th>操作</th></tr></thead>
              <tbody>
                {pageItems.map((v) => (
                  <tr key={v.id}>
                    <td>{platformLabel(v.platform)}</td>
                    <td>{v.mediaType === 'image' ? <span className="mini-tag">图文</span> : v.mediaType === 'audio' ? '音频' : v.mediaType === 'music' ? '音乐' : '视频'}</td>
                    <td>{v.authorName}</td>
                    <td className="small">{v.title}<div className="muted">{(v.hook ?? '').slice(0, 30)}…</div></td>
                    <td>{v.views.toLocaleString()}</td>
                    <td>{v.likes.toLocaleString()}</td>
                    <td>{v.comments.toLocaleString()}</td>
                    <td>{v.shares.toLocaleString()}</td>
                    <td>{v.durationSec ? `${v.durationSec}s` : '—'}</td>
                    <td className="small">{v.tags.slice(0, 3).map((t) => <span key={t} className="mini-tag">#{t}</span>)}</td>
                    <td className="row-actions">
                      <button className="mini" onClick={() => setPreview(v)} disabled={!v.mediaUrl}>预览</button>
                      <button className="mini" onClick={() => download(v)} disabled={v.mediaType !== 'video' || !v.mediaUrl || downloadingId === v.id}>{downloadingId === v.id ? '下载中…' : '下载'}</button>
                      <button className="mini" disabled={!canAnalyze || v.mediaType !== 'video' || !v.mediaUrl || (analysisVideo?.id === v.id && analysisState === 'loading')} onClick={() => runAnalysis(v)}>
                        {analysisVideo?.id === v.id && analysisState === 'loading' ? '解析中…' : 'AI 解析'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="pager">
              <button className="ghost" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>上一页</button>
              <span className="pager-info">第 {safePage} / {totalPages} 页 · 共 {sorted.length} 条</span>
              <button className="ghost" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>下一页</button>
              <div className="pager-pages">
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter((p) => Math.abs(p - safePage) <= 2 || p === 1 || p === totalPages)
                  .map((p, idx, arr) => (
                    <span key={p}>
                      {idx > 0 && p - arr[idx - 1] > 1 ? <span className="pager-ellipsis">…</span> : null}
                      <button className={p === safePage ? 'pager-num active' : 'pager-num'} onClick={() => setPage(p)}>{p}</button>
                    </span>
                  ))}
              </div>
            </div>
          )}
        </>)}
      </Card>

      {analysisVideo && analysisState !== 'idle' && (
        <Card title={`MiniMax-M3 视频内容解析 · ${analysisVideo.title || analysisVideo.authorName}`}>
          {analysisState === 'loading' && (
            <div className="analysis-stream">
              <div className="pl-ai-head">MiniMax-M3 实时生成中…<span className="pl-live">● 流式输出</span></div>
              <pre className="pl-ai-text">{pipe.state.aiText}{pipe.state.loading ? '▍' : ''}</pre>
            </div>
          )}
          {analysisState === 'error' && <p className="err">{analysisError}</p>}
          {analysisState === 'done' && analysis && (
            <>
              {analysisMethod === 'sanitized' && (
                <p className="muted warn-note">⚠️ 原视频被 MiniMax 判定为敏感内容。已通过「重新编码脱敏」（去元数据 / 改分辨率码率 / 轻微裁剪 / 调帧率）后重新上传并成功解析，并已更新该视频的媒体链接——后续解析将直接使用脱敏版本。</p>
              )}
              {analysisMethod === 'frames' && (
                <p className="muted warn-note">⚠️ 原视频被判定为敏感，脱敏重编码后仍被拦截。已改用「按秒抽帧生成图片集」的方式完成内容分析。</p>
              )}
              <div className="analysis-section">
                <h4>🎣 前3秒 Hook</h4>
                <p>{analysis.first3sHook || '—'}</p>
              </div>
              <div className="analysis-section">
                <h4>🎬 视频结构</h4>
                <p>{analysis.videoStructure || '—'}</p>
              </div>
              <div className="analysis-section">
                <h4>🎯 主要拍摄主体</h4>
                <p>{analysis.mainSceneSubject || '—'}</p>
              </div>
              <div className="analysis-section">
                <h4>💡 用户关注点</h4>
                <p>{analysis.userConcern || '—'}</p>
              </div>
              {analysis._raw && <p className="muted">（模型未返回标准 JSON，已回退展示原始文本）</p>}
            </>
          )}
        </Card>
      )}

      {/* 视频预览弹层（模块内，不跳转） */}
      {preview && (
        <div className="modal-mask" onClick={() => setPreview(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{preview.authorName} · {preview.title}</span>
              <button className="link" onClick={() => setPreview(null)}>关闭</button>
            </div>
            <div className="modal-body">
              {preview.mediaUrl ? (
                preview.mediaType === 'image' ? (
                  <img src={preview.mediaUrl} style={{ width: '100%', maxHeight: '60vh', objectFit: 'contain', background: '#000' }} alt={preview.title} />
                ) : (
                  <video src={preview.mediaUrl} controls autoPlay style={{ width: '100%', maxHeight: '60vh', background: '#000' }} />
                )
              ) : (
                <p className="muted">该内容没有可用直链，无法预览。</p>
              )}
            </div>
            <div className="modal-foot">
              <button className="primary" onClick={() => download(preview)} disabled={!preview.mediaUrl}>下载到本地</button>
              {preview.mediaUrl && <button className="ghost" onClick={() => window.open(preview.mediaUrl, '_blank')}>新窗口打开</button>}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
