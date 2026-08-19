import React, { useEffect, useRef, useState } from 'react';
import { Card, platformLabel, formatDateTime } from '../components/ui';
import { SocialVideo, AppConfig, Platform } from '../../shared/types';
import { useWorkflow } from '../workflowStore';
import { navigateTo, setViralTarget } from '../navStore';
import { platformUnsupportedMessage } from '../../data/providers/unsupported';

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
  const iTags = idx('tags'), iUrl = idx('url'), iPublish = idx('publish'), iMedia = idx('mediaUrl');
  return lines.slice(1).map((l, n) => {
    const f = parseCsvLine(l);
    const url = (f[iUrl] ?? '').trim();
    const m = url.match(/video\/(\d+)/);
    const id = m ? `tiktok_${m[1]}` : `import_${n}_${safeName(f[iTitle] ?? '')}`;
    const title = (f[iTitle] ?? '').trim();
    const publishRaw = (f[iPublish] ?? '').trim();
    return {
      id,
      platform: (f[iPlatform] || 'tiktok') as Platform,
      authorId: (f[iAuthor] ?? 'unknown').trim(),
      authorName: (f[iAuthor] ?? 'unknown').trim(),
      url: url || `https://www.tiktok.com/${id}`,
      publishTime: publishRaw ? new Date(publishRaw).toISOString() : new Date().toISOString(),
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
      // 媒体直链（原始远程直链，可为空）：由 CSV 导出/导入往返，绝不含 localmedia:// 本地链接
      mediaUrl: (f[iMedia] ?? '').trim() || undefined,
    } as SocialVideo;
  });
}

export default function VideoDatabase() {
  const [platform, setPlatform] = useState<Platform>('tiktok');
  const [url, setUrl] = useState('');
  const [videos, setVideos] = useState<SocialVideo[]>([]);
  const [filter, setFilter] = useState('');
  const [filterPlatform, setFilterPlatform] = useState<Platform | 'all'>('all');
  const [filterAccount, setFilterAccount] = useState<string>('all');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [fetchError, setFetchError] = useState('');
  // 批量把视频链接替换为本地路径（localmedia:// 协议，永不过期）的结果提示
  const [localResult, setLocalResult] = useState('');
  // 多选删除：被选中的视频 id 集合
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 删除二次确认：待确认删除的视频 id 集合（null 表示无确认弹层）
  const [confirmDelete, setConfirmDelete] = useState<{ ids: string[]; count: number } | null>(null);

  // 预览 / 下载
  const [preview, setPreview] = useState<SocialVideo | null>(null);
  const [downloadingId, setDownloadingId] = useState('');

  // 图文（图片）解析结果弹层
  const [imageAnalysis, setImageAnalysis] = useState<{
    video: SocialVideo;
    result: { composition: string; subject: string; styleTone: string; userAppeal: string; captionSuggestion: string };
  } | null>(null);

  // 分页（每页 20 条）
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);

  const csvInputRef = useRef<HTMLInputElement | null>(null);
  const [busyFetch, setBusyFetch] = useState(false);
  const [busyReplace, setBusyReplace] = useState(false);
  const pipe = useWorkflow('竞对视频数据库');

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
    setBusyFetch(true);
    pipe.enqueue('抓取视频', async (runId, signal) => {
      setFetchError('');
      try {
        // fetchVideos 已返回「合并后的本地库」（含历史抓取），不会覆盖旧数据
        // 抓取上限取设置中的「默认抓取视频数量」（1~50，默认 50）；不足 50 条则全部抓取
        const crawlLimit = Math.min(50, Math.max(1, config?.fetchVideoCount ?? 50));
        const res = await window.api.fetchVideos({ platform, url: url.trim(), limit: crawlLimit, runId });
        if (signal.aborted) return;
        setVideos(res);
        if (res.length === 0) {
          setFetchError('未抓取到视频。若接口返回 402，通常是 TiKhub 账户余额/免费额度不足，请到 https://tikhub.io 充值后重试（详见下方「实时处理流程」）。');
        }
      } catch (e: any) {
        if (signal.aborted) return;
        setFetchError(e?.message ?? String(e));
        throw e;
      } finally {
        setBusyFetch(false);
      }
    });
  }

  async function download(v: SocialVideo) {
    const mediaUrl = playUrl(v);
    if (!mediaUrl) {
      setFetchError(`该${v.mediaType === 'image' ? '图文' : '视频'}没有可用的直链，无法下载。可尝试在浏览器中打开原链接。`);
      return;
    }
    const ext = v.mediaType === 'image'
      ? (mediaUrl.match(/\.(jpg|jpeg|png|webp|gif)(?:\?.*)?$/i)?.[1] || 'jpg')
      : 'mp4';
    setDownloadingId(v.id);
    try {
      const r = await window.api.downloadVideo({
        url: mediaUrl,
        filename: `${safeName(v.authorName)}-${safeName(v.title || v.id)}.${ext}`,
      });
      if (!r.saved) setFetchError(`下载失败：${r.error ?? '未知错误'}`);
    } catch (e: any) {
      setFetchError(e?.message ?? String(e));
    } finally {
      setDownloadingId('');
    }
  }

  // 图文（图片）解析：只分析图片构图、主体、风格色调、用户吸引力、配文建议
  async function runImageAnalysis(v: SocialVideo) {
    pipe.enqueue('图文内容解析', async (runId, signal) => {
      try {
        const res = await window.api.runAiTask({
          task: 'analyzeImage',
          runId,
          payload: { title: v.title, url: v.mediaUrl, localMediaUrl: v.localMediaUrl },
        });
        if (signal.aborted) return;
        setImageAnalysis({ video: v, result: res });
      } catch (e: any) {
        if (signal.aborted) return;
        setFetchError(`图文解析失败：${e?.message ?? String(e)}`);
        throw e;
      }
    });
  }

  // 批量把所有视频链接下载到本地，并把可播放地址替换为本地路径（永不过期）。
  // 仅替换「播放用」地址，AI 分析仍走原先的远程/MiniMax 链接，互不影响。
  async function replaceToLocal() {
    setBusyReplace(true);
    pipe.enqueue('全部替换为本地路径', async (runId, signal) => {
      setLocalResult('');
      try {
        const res = await window.api.replaceMediaWithLocal({ runId });
        if (signal.aborted) return;
        setLocalResult(`替换完成：新下载到本地 ${res.downloaded} 个，已本地/无直链跳过 ${res.skipped} 个，失败 ${res.failed} 个（共 ${res.total} 个）。本地视频经 localmedia:// 协议播放，永不过期。`);
        await loadDb();
      } catch (e: any) {
        if (signal.aborted) return;
        setLocalResult(`替换失败：${e?.message ?? String(e)}`);
        throw e;
      } finally {
        setBusyReplace(false);
      }
    });
  }

  // 播放/预览/下载优先用本地路径（永不过期）；本地文件缺失（localMediaMissing）时回退远程 mediaUrl
  function playUrl(v: SocialVideo): string {
    if (v.localMediaUrl && !v.localMediaMissing) return v.localMediaUrl;
    return v.mediaUrl ?? '';
  }

  // 导入 CSV（与导出格式一致；按 id 合并到本地库，不覆盖历史）
  async function onImportCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const fileName = file.name;
    pipe.enqueue(`导入CSV（${fileName}）`, async () => {
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
        setLocalResult(`已导入 ${res.imported} 条视频到本地库（按 id 合并，不覆盖历史）。`);
      } catch (err: any) {
        setFetchError(`CSV 导入失败：${err?.message ?? String(err)}`);
      }
    });
  }

  // 多选：切换单条选中状态
  function toggleOne(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  // 多选：表头全选/取消（作用于当前筛选结果集）
  function toggleAll() {
    const allSelected = filtered.length > 0 && filtered.every((v) => selected.has(v.id));
    setSelected(allSelected ? new Set() : new Set(filtered.map((v) => v.id)));
  }

  // 弹出删除二次确认（批量 / 单条都先走到这里）
  function askDelete(ids: string[]) {
    if (ids.length === 0) return;
    setConfirmDelete({ ids, count: ids.length });
  }

  // 实际执行删除：通过工作流队列发起，若当前有其它工作流进行中则排队；本地落盘的视频会同时清理本地文件
  function doDelete(ids: string[]) {
    if (ids.length === 0) return;
    setConfirmDelete(null);
    pipe.enqueue(`删除视频（${ids.length}）`, async () => {
      const res = await window.api.deleteVideos({ ids });
      await loadDb();
      setSelected((prev) => {
        const n = new Set(prev);
        ids.forEach((id) => n.delete(id));
        return n;
      });
      setLocalResult(`已删除 ${res.removed} 条视频${res.localDeleted ? `，并清理本地文件 ${res.localDeleted} 个` : ''}。`);
    });
  }

  function exportCsv() {
    // 媒体链接列只导出「原始远程直链」（mediaUrl），绝不导出本地 localmedia:// 链接——
    // 本地链接仅在本机安装目录有效，导出到别处再导入会失效。
    const header = ['platform', 'author', 'title', 'publish', 'views', 'likes', 'comments', 'shares', 'favorites', 'durationSec', 'tags', 'url', 'mediaUrl'];
    const rows = filtered.map((v) => [
      v.platform,
      v.authorName,
      `"${v.title.replace(/"/g, '')}"`,
      v.publishTime,
      v.views,
      v.likes,
      v.comments,
      v.shares,
      v.favorites,
      v.durationSec,
      v.tags.join('|'),
      v.url,
      v.mediaUrl && /^https?:\/\//.test(v.mediaUrl) ? v.mediaUrl : '',
    ]);
    const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'video_db.csv';
    a.click();
  }

  // 视频库中出现的去重作者列表（用于「账号」筛选下拉）
  const accountOptions = React.useMemo(() => {
    const set = new Set<string>();
    for (const v of videos) if (v.authorName) set.add(v.authorName);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [videos]);

  const filtered = videos.filter((v) => {
    if (filterPlatform !== 'all' && v.platform !== filterPlatform) return false;
    if (filterAccount !== 'all' && v.authorName !== filterAccount && v.authorId !== filterAccount) return false;
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
  React.useEffect(() => { setPage(1); setSelected(new Set()); }, [filter, filterPlatform, filterAccount, videos.length]);

  return (
    <div className="page">
      <h1>二、竞对视频数据抓取与视频库</h1>
      <p className="muted">抓取竞对账号全部视频基础数据（仅视频类型，剔除图文/相册帖），构建旅游行业视频数据库；并调用 MiniMax-M3 多模态解析视频 Hook、结构、主体与用户关注点。支持本地下载、预览；可将视频替换为<strong>本地永久链接</strong>长期保存。</p>

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
          <button onClick={fetchVideos} disabled={busyFetch || !url.trim()}>{busyFetch ? '抓取中…' : '抓取全部视频'}</button>
        </div>
        {fetchError && <p className="err">{fetchError}</p>}
      </Card>

      <Card title={`视频库（${filtered.length} 条）`} right={<>
        <button className="primary" onClick={replaceToLocal} disabled={busyReplace || filtered.length === 0}>
          全部替换为本地路径
        </button>
        {selected.size > 0 && (
          <button style={{marginLeft: 8}} className="danger" onClick={() => askDelete(Array.from(selected))}>
            批量删除（{selected.size}）
          </button>
        )}
      </>}>
        {/* 临时链接有效期提示 */}
        <div className="vd-hint">
          <span className="vd-hint-icon">ℹ️</span>
          <span>当前视频为平台临时链接，有效期 <strong>7 天</strong>，到期后可能无法播放。点击「全部替换为本地路径」可下载到本地（安装目录 <code>video_files</code> 文件夹），保存为<strong>永久链接</strong>。</span>
        </div>

        {localResult && <p className="muted" style={{ margin: '0 0 10px' }}>{localResult}</p>}

        {/* 工具栏：筛选条件 + 操作按钮 */}
        <div className="vd-toolbar">
          <div className="vd-filters">
            <select value={filterPlatform} onChange={(e) => setFilterPlatform(e.target.value as Platform | 'all')}>
              <option value="all">全部平台</option>
              <option value="tiktok">TikTok</option>
              <option value="instagram">Instagram</option>
              <option value="youtube">YouTube</option>
              <option value="facebook">Facebook</option>
              <option value="twitter">Twitter</option>
            </select>
            <select value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)}>
              <option value="all">全部账号</option>
              {accountOptions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <input className="vd-search" placeholder="搜索标题 / 文案 / 标签" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div className="vd-actions">
            <button className="ghost" onClick={loadDb} title="重新读取本地库，刷新列表数据状态">刷新</button>
            <button className="ghost" onClick={exportCsv}>导出 CSV</button>
            <button className="ghost" onClick={() => csvInputRef.current?.click()}>导入 CSV</button>
            <input ref={csvInputRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={onImportCsv} />
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="empty">暂无视频数据。请在上方输入竞对账号链接并点击「抓取全部视频」，或通过「导入 CSV」恢复导出数据。</p>
        ) : (<>
          <div className="table-wrap">
            <table className="tbl tbl-vdb">
              <thead><tr>
                <th className="col-check"><input type="checkbox" checked={filtered.length > 0 && filtered.every((v) => selected.has(v.id))} onChange={toggleAll} title="全选 / 取消" /></th>
                <th>平台</th><th>类型</th><th>作者</th><th>发布</th><th className="col-title">标题/Hook</th><th>链接</th><th>播放</th><th>赞</th><th>评</th><th>分享</th><th>时长</th><th>标签</th><th>操作</th>
              </tr></thead>
              <tbody>
                {pageItems.map((v) => (
                  <tr key={v.id} className={selected.has(v.id) ? 'row-selected' : ''}>
                    <td className="col-check"><input type="checkbox" checked={selected.has(v.id)} onChange={() => toggleOne(v.id)} /></td>
                    <td>{platformLabel(v.platform)}</td>
                    <td>{v.mediaType === 'image' ? <span className="mini-tag">图文</span> : v.mediaType === 'audio' ? '音频' : v.mediaType === 'music' ? '音乐' : '视频'}</td>
                    <td>{v.authorName}</td>
                    <td className="col-publish" title={v.publishTime}>{formatDateTime(v.publishTime)}</td>
                    <td
                      className="col-title"
                      title={[v.title, v.hook].filter(Boolean).join('\n')}
                    >
                      <div className="ct-title">{v.title}</div>
                      {v.hook ? <div className="muted ct-hook">{v.hook}</div> : null}
                    </td>
                    <td>
                      {v.localMediaUrl && !v.localMediaMissing ? (
                        <span className="tag-local">本地</span>
                      ) : v.localMediaUrl ? (
                        <span className="tag-temp" title="本地文件已丢失，重新点击「全部替换为本地路径」可再次下载">临时(失效)</span>
                      ) : (
                        <span className="tag-temp">临时</span>
                      )}
                    </td>
                    <td>{v.views.toLocaleString()}</td>
                    <td>{v.likes.toLocaleString()}</td>
                    <td>{v.comments.toLocaleString()}</td>
                    <td>{v.shares.toLocaleString()}</td>
                    <td>{v.durationSec ? `${v.durationSec}s` : '—'}</td>
                    <td
                      className="col-tags"
                      title={v.tags.length ? v.tags.map((t) => '#' + t).join(' ') : undefined}
                    >
                      <span className="tags-inner">{v.tags.map((t) => <span key={t} className="mini-tag">#{t}</span>)}</span>
                    </td>
                    <td className="row-actions">
                      <button className="mini" onClick={() => setPreview(v)} disabled={!playUrl(v)}>预览</button>
                      <button className="mini" onClick={() => download(v)} disabled={!playUrl(v) || downloadingId === v.id}>{downloadingId === v.id ? '下载中…' : '下载'}</button>
                      {v.mediaType === 'image' ? (
                        <button className="mini" disabled={!playUrl(v)} onClick={() => runImageAnalysis(v)}>AI 解析</button>
                      ) : (
                        <button className="mini" disabled={!playUrl(v)} onClick={() => { setViralTarget(v.id); navigateTo('viral'); }}>AI 解析</button>
                      )}
                      <button className="mini danger" onClick={() => askDelete([v.id])}>删除</button>
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

      {/* 视频预览弹层（模块内，不跳转） */}
      {preview && (
        <div className="modal-mask" onClick={() => setPreview(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{preview.authorName} · {preview.title}</span>
              <button className="link" onClick={() => setPreview(null)}>关闭</button>
            </div>
            <div className="modal-body">
              {playUrl(preview) ? (
                preview.mediaType === 'image' ? (
                  <img src={playUrl(preview)} style={{ width: '100%', maxHeight: '60vh', objectFit: 'contain', background: '#000' }} alt={preview.title} />
                ) : (
                  <video src={playUrl(preview)} controls autoPlay style={{ width: '100%', maxHeight: '60vh', background: '#000' }} />
                )
              ) : (
                <p className="muted">该内容没有可用直链，无法预览。</p>
              )}
            </div>
            <div className="modal-foot">
              <button className="primary" onClick={() => download(preview)} disabled={!playUrl(preview)}>下载到本地</button>
              {playUrl(preview) && <button className="ghost" onClick={() => window.open(playUrl(preview), '_blank')}>新窗口打开</button>}
            </div>
          </div>
        </div>
      )}

      {/* 图文（图片）解析结果弹层 */}
      {imageAnalysis && (
        <div className="modal-mask" onClick={() => setImageAnalysis(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>🖼️ 图文内容解析 · {imageAnalysis.video.title || imageAnalysis.video.authorName}</span>
              <button className="link" onClick={() => setImageAnalysis(null)}>关闭</button>
            </div>
            <div className="modal-body">
              <div className="analysis-section">
                <h4>📐 图片构图</h4>
                <p>{imageAnalysis.result.composition || '—'}</p>
              </div>
              <div className="analysis-section">
                <h4>🎯 拍摄主体</h4>
                <p>{imageAnalysis.result.subject || '—'}</p>
              </div>
              <div className="analysis-section">
                <h4>🎨 风格与色调</h4>
                <p>{imageAnalysis.result.styleTone || '—'}</p>
              </div>
              <div className="analysis-section">
                <h4>💡 用户吸引力</h4>
                <p>{imageAnalysis.result.userAppeal || '—'}</p>
              </div>
              <div className="analysis-section">
                <h4>✍️ 英文社媒文案建议</h4>
                <p>{imageAnalysis.result.captionSuggestion || '—'}</p>
              </div>
            </div>
            <div className="modal-foot">
              <button className="primary" onClick={() => setImageAnalysis(null)}>知道了</button>
            </div>
          </div>
        </div>
      )}

      {/* 删除二次确认弹层 */}
      {confirmDelete && (
        <div className="modal-mask" onClick={() => setConfirmDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>确认删除视频</span>
              <button className="link" onClick={() => setConfirmDelete(null)}>关闭</button>
            </div>
            <div className="modal-body">
              <p>确定要删除选中的 <b>{confirmDelete.count}</b> 条视频吗？此操作不可恢复，已下载到本地的视频文件也会一并删除。</p>
            </div>
            <div className="modal-foot">
              <button className="ghost" onClick={() => setConfirmDelete(null)}>取消</button>
              <button className="danger" onClick={() => doDelete(confirmDelete.ids)}>
                确认删除（{confirmDelete.count}）
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
