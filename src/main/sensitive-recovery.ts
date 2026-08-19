// 敏感内容自动脱敏恢复流程（主进程）
// 当视频解析被 MiniMax 判定为敏感内容时，依次尝试两种脱敏方案：
//   方案1（重新编码）：读取本地文件 → ffmpeg 去元数据/改分辨率码率/轻微裁剪/调帧率 → 重新上传 MiniMax 拿引用
//                      → 用新引用重新解析；成功则把「编码后的视频」另存到本地 encoded 文件夹并写回 localEncodedMediaUrl
//                      （后续分析优先用该编码文件），【不替换】原始 localMediaUrl / mediaUrl。
//   方案2（抽帧）：若方案1后仍敏感 → ffmpeg 每秒抽 1 帧 → 上传图片集 → 用图片集交给 MiniMax 分析。
// 两种方案均失败则抛出清晰中文错误，由 UI 提示人工分析。
//
// 关于「本地链接与 MiniMax 分析」：MiniMax 是云端服务，无法直接读取 Electron 本地协议 localmedia://，
// 因此分析时由主进程读取本地文件内容并上传到 MiniMax（拿到 mm_file:// 引用）后再做多模态理解，
// 这样既不依赖 TiKhub 临时直链（约 7 天过期），也能复用已下载到本地的视频。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { net } from 'electron';
import { MiniMaxClient } from '../data/minimax';
import { DataService } from '../data';
import { mediaDir } from '../data/store';
import { Platform, SocialVideo } from '../shared/types';
import { parseVideoSafe, parseVideoFramesSafe, VideoParseResult, breakdownViralVideoSafe, ViralBreakdownResult } from '../analysis/ai-tasks';
import { EditMaterial, EditPlan } from '../analysis/ai-edit';
import { sanitizeVideo, extractFramesPerSecond } from './ffmpeg';
import { trace } from '../shared/trace';

export interface RecoveryResult {
  analysis: VideoParseResult;
  method: 'direct' | 'sanitized' | 'frames' | 'text';
  sensitiveRecovered: boolean;
}

/** 文件名安全化：去掉本地落盘文件名中的非法字符 */
function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 脱敏编码文件的本地目录：mediaDir()/encoded，与原始落盘目录分开，避免混淆 */
function encodedDir(): string {
  const dir = path.join(mediaDir(), 'encoded');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 把 localmedia:// 协议地址解析为本地实际文件路径并读出字节。
 * 带目录穿越防护：仅允许访问 mediaDir() 内部文件。
 * 解析失败（协议不对/越权/文件缺失）返回 null。
 */
function resolveLocalMedia(url?: string): { filePath: string; bytes: Buffer; fileName: string } | null {
  if (!url || !url.startsWith('localmedia://')) return null;
  try {
    const rel = decodeURIComponent(url.replace('localmedia://', ''));
    const base = path.resolve(mediaDir());
    const filePath = path.resolve(base, rel);
    // 仅允许 mediaDir 内部文件，禁止 ../ 穿越
    if (filePath !== base && !filePath.startsWith(base + path.sep)) return null;
    if (!fs.existsSync(filePath)) return null;
    return { filePath, bytes: fs.readFileSync(filePath), fileName: path.basename(filePath) };
  } catch {
    return null;
  }
}

/**
 * 把远程直链下载为本地 Buffer（用 Electron net.fetch，Chromium 网络栈 + 浏览器 UA/Referer）。
 * Node 原生 http/https 请求常被 TikTok/Instagram CDN 重置连接（无浏览器指纹），
 * 用 net.fetch 才能可靠取到降级所需的原始视频字节。
 */
function downloadBuffer(url: string): Promise<Buffer> {
  return net
    .fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: 'https://www.tiktok.com/',
        Accept: 'video/mp4,video/*,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      // 60s 超时：避免单条媒体下载挂起卡住降级链
      signal: AbortSignal.timeout(60_000),
    })
    .then(async (res) => {
      if (!res.ok) throw new Error(`媒体下载失败 HTTP ${res.status} (${url})`);
      return Buffer.from(await res.arrayBuffer());
    });
}

/** 下载并记录耗时到工作流面板（展示「下载原始视频」这一步花了多久） */
async function downloadBufferTraced(url: string, title: string): Promise<Buffer> {
  const start = Date.now();
  const buf = await downloadBuffer(url);
  trace.add({
    kind: 'minimax', title, endpoint: url.slice(0, 140), method: 'GET',
    model: '', status: 200, ok: true, durationMs: Date.now() - start,
    summary: `已下载 ${(buf.length / 1024 / 1024).toFixed(1)} MB（浏览器网络栈）`,
  });
  return buf;
}

async function analyzeVideoWithRecovery(
  client: MiniMaxClient,
  dataService: DataService,
  args: { platform: Platform; videoId: string },
): Promise<RecoveryResult> {
  const video: SocialVideo | undefined = dataService.getVideoDb().find((v) => v.id === args.videoId);
  const detail = await dataService.fetchVideoDetail(args.platform, args.videoId);
  const mediaUrl = detail.mediaUrl || video?.mediaUrl;
  const title = video?.title ?? detail.video?.title ?? '';
  const tags = video?.tags ?? [];
  const id = args.videoId;

  // 选择「用于分析的媒体源」优先级：已脱敏编码文件 > 原始本地文件 > 远程临时直链。
  // localmedia:// 仅在 Electron 内部有效，MiniMax 云端读不到，因此本地文件需由主进程读取字节后上传到 MiniMax。
  const encodedLocal = resolveLocalMedia(video?.localEncodedMediaUrl);
  const originalLocal = resolveLocalMedia(video?.localMediaUrl);

  /** 把本地视频字节上传到 MiniMax（拿 mm_file:// 引用）后做多模态解析 */
  async function analyzeLocal(bytes: Buffer, fileName: string): Promise<{ ok: boolean; sensitive?: boolean; error?: string; data?: VideoParseResult }> {
    const upStart = Date.now();
    const ref = await client.uploadVideo(bytes, fileName);
    trace.add({
      kind: 'minimax', title: '敏感内容处理：已上传本地视频到 MiniMax', endpoint: `${client.baseUrl}/files/upload`,
      method: 'POST', model: client.model, status: 200, ok: true, durationMs: Date.now() - upStart,
      summary: `获得引用 ${ref}（MiniMax 云端可读取，无需依赖 localmedia:// 协议或 TiKhub 临时直链）`,
    });
    return parseVideoSafe(client, { title, tags, url: ref });
  }

  // —— 第一步：解析（本地文件走上传引用，远程直链直接解析，都没有则纯文本）——
  let direct: { ok: boolean; sensitive?: boolean; error?: string; data?: VideoParseResult };
  if (encodedLocal) {
    direct = await analyzeLocal(encodedLocal.bytes, encodedLocal.fileName);
  } else if (originalLocal) {
    direct = await analyzeLocal(originalLocal.bytes, originalLocal.fileName);
  } else if (mediaUrl && /^https?:\/\//.test(mediaUrl)) {
    direct = await parseVideoSafe(client, { title, tags, url: mediaUrl });
  } else {
    direct = await parseVideoSafe(client, { title, tags, url: undefined });
  }

  if (direct.ok && direct.data) {
    // 命中编码文件说明此前已脱敏成功，归为 sanitized；否则为 direct
    return { analysis: direct.data, method: encodedLocal ? 'sanitized' : 'direct', sensitiveRecovered: !!encodedLocal };
  }

  // —— 任何失败（敏感 / 媒体不可达 / 网络）都尝试降级恢复 ——
  // 编码源优先级：原始本地文件 > 已编码文件（兜底）> 远程直链（先下载到内存）。
  // 注意：编码后另存到 encoded 目录并写回 localEncodedMediaUrl，【不替换】原 localMediaUrl / mediaUrl。
  let sourceBytes: Buffer | null = null;
  let sourceName = `${safeName(id)}.mp4`;
  if (originalLocal) {
    sourceBytes = originalLocal.bytes;
    sourceName = originalLocal.fileName;
  } else if (encodedLocal) {
    sourceBytes = encodedLocal.bytes;
    sourceName = encodedLocal.fileName;
  } else if (mediaUrl && /^https?:\/\//.test(mediaUrl)) {
    try {
      sourceBytes = await downloadBufferTraced(mediaUrl, '降级源：下载原始视频到内存');
      sourceName = `${safeName(id)}.mp4`;
    } catch {
      sourceBytes = null;
    }
  }
  if (!sourceBytes) {
    // 拿不到原始媒体字节：只能基于标题/标签做纯文本兜底
    const text = await parseVideoSafe(client, { title, tags, url: undefined });
    if (text.ok && text.data) return { analysis: text.data, method: 'text', sensitiveRecovered: false };
    throw new Error(
      text.error ||
        direct.error ||
        '视频解析失败，且本地没有可重新编码的视频文件、也没有可下载的远程直链，无法做脱敏预处理；纯文本兜底也失败。' +
        '建议：① 在「设置」中更换为内容限制更宽松的模型；② 仅基于标题/标签人工分析；③ 跳过该条视频。',
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ost-rec-'));
  try {
    const rawPath = path.join(tmp, 'raw.mp4');
    fs.writeFileSync(rawPath, sourceBytes);
    trace.add({
      kind: 'minimax', title: '敏感内容处理：已准备本地视频用于重新编码', endpoint: '', method: 'GET',
      model: client.model, status: 200, ok: true, durationMs: 0,
      summary: `源文件大小 ${(sourceBytes.length / 1024 / 1024).toFixed(1)} MB，准备进入脱敏预处理`,
    });

    // —— 方案1：重新编码脱敏 ——
    if (client.aborted) throw new Error('任务已取消');
    const sanitizedPath = path.join(tmp, 'sanitized.mp4');
    const encStart = Date.now();
    await sanitizeVideo(rawPath, sanitizedPath);
    const sanitizedBuf = fs.readFileSync(sanitizedPath);
    // 另存编码文件到 encoded 目录（与原始落盘分开），并写回 localEncodedMediaUrl（不替换原链接）
    const encFileName = `${safeName(id)}_encoded.mp4`;
    fs.writeFileSync(path.join(encodedDir(), encFileName), sanitizedBuf);
    // 注意：文件落在 mediaDir()/encoded/ 子目录下，引用需带 encoded/ 子路径，
    // 才能被 resolveLocalMedia（path.resolve(mediaDir(), rel)）与下载/删除逻辑正确解析到该子目录。
    const encRef = `localmedia://encoded/${encodeURIComponent(encFileName)}`;
    dataService.setVideoEncodedMediaUrl(id, encRef);
    trace.add({
      kind: 'minimax', title: '敏感内容处理：ffmpeg 重新编码完成，已另存到 encoded 目录', endpoint: '',
      method: 'POST', model: client.model, status: 200, ok: true, durationMs: Date.now() - encStart,
      summary: `编码文件已保存为 ${encRef}；后续分析将优先使用该本地编码文件（原 localMediaUrl / mediaUrl 保持不变）`,
    });

    const sanitized = await analyzeLocal(sanitizedBuf, encFileName);
    if (sanitized.ok && sanitized.data) {
      return { analysis: sanitized.data, method: 'sanitized', sensitiveRecovered: true };
    }

    // 方案1 后仍失败（敏感或其它原因）→ 方案2：抽帧
    const frameDir = path.join(tmp, 'frames');
    if (client.aborted) throw new Error('任务已取消');
    const frStart = Date.now();
    const frames = await extractFramesPerSecond(sanitizedPath, frameDir, 30);
    trace.add({
      kind: 'minimax', title: `敏感内容处理：ffmpeg 抽帧（每秒1帧，共 ${frames.length} 张）`, endpoint: '',
      model: client.model, status: 200, ok: true, durationMs: Date.now() - frStart,
      summary: '原视频脱敏重编码后仍被拦截，改用抽帧图片集分析',
    });
    if (!frames.length) {
      throw new Error('已对视频抽帧，但未得到任何帧图片，无法继续分析。');
    }
    // 上传图片集（最多取前 12 张，控制请求体积）
    const upFramesStart = Date.now();
    const imageRefs: string[] = [];
    for (const f of frames.slice(0, 12)) {
      if (client.aborted) throw new Error('任务已取消');
      imageRefs.push(await client.uploadImage(fs.readFileSync(f), path.basename(f)));
    }
    trace.add({
      kind: 'minimax', title: `敏感内容处理：已上传 ${imageRefs.length} 张帧图片到 MiniMax`, endpoint: `${client.baseUrl}/files/upload`,
      method: 'POST', model: client.model, status: 200, ok: true, durationMs: Date.now() - upFramesStart,
      summary: '将以图片集方式交给 MiniMax 做内容分析',
    });

    const framesRes = await parseVideoFramesSafe(client, { title, tags, imageUrls: imageRefs });
    if (framesRes.ok && framesRes.data) {
      return { analysis: framesRes.data, method: 'frames', sensitiveRecovered: true };
    }
    // —— 方案3：纯文本兜底（基于标题/标签元数据）——
    const text = await parseVideoSafe(client, { title, tags, url: undefined });
    if (text.ok && text.data) return { analysis: text.data, method: 'text', sensitiveRecovered: false };
    throw new Error(
      text.error ||
        '视频经「重新编码脱敏」与「抽帧图片集」两种方式分析仍失败，且纯文本兜底也失败，无法生成 AI 分析。' +
        '建议：① 更换内容限制更宽松的模型；② 仅基于标题/标签人工分析；③ 跳过该条视频。',
    );
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ===========================================================================
// 模块七：AI 视频剪辑 —— 视频被判敏感/媒体不可达时的降级恢复
// 与「视频分析」共享同一套 ffmpeg 脱敏脚本（重新编码 / 抽帧），但关键约束不同：
//   - 脱敏后的新链接【只用于生成剪辑方案（让 MiniMax 看懂内容）】；
//   - 通过降级才分析成功的视频，会把「过审资源」（重编码文件）本地保存并写回视频库
//     localEncodedMediaUrl 字段（页面上不展示），后续该视频再被分析时优先复用该过审资源；
//   - 最终 ffmpeg 渲染成片时，始终使用【原始素材】（用户传入的 url / filePath），保证成品内容是原始视频。
// ===========================================================================

export interface EditPlanRecoveryResult {
  plans: EditPlan[];
  method: 'direct' | 'sanitized' | 'frames' | 'text';
  sensitiveRecovered: boolean;
}

/** 可脱敏素材源：优先视频库已保存的「过审资源」，其次本地文件，最后远程可下载直链 */
interface MediaSource {
  videoId?: string;
  name: string;
  filePath?: string;
  url?: string;
}

/**
 * 构建可脱敏素材源：
 * - 素材关联了视频库行（videoId 或 mediaUrl 匹配）且该行已保存过审资源（localEncodedMediaUrl）时，优先使用过审文件；
 * - 其次本地文件（filePath）；
 * - 最后远程可下载直链（url）。
 */
function prepareSources(materials: EditMaterial[], dataService: DataService): MediaSource[] {
  const db = dataService.getVideoDb();
  const byUrl = new Map<string, SocialVideo>();
  for (const v of db) if (v.mediaUrl) byUrl.set(v.mediaUrl, v);
  const sources: MediaSource[] = [];
  for (const m of materials) {
    let row: SocialVideo | undefined = m.videoId ? db.find((v) => v.id === m.videoId) : undefined;
    if (!row && m.url) row = byUrl.get(m.url);
    const videoId = row?.id ?? m.videoId;
    const encoded = row?.localEncodedMediaUrl ? resolveLocalMedia(row.localEncodedMediaUrl) : null;
    const s: MediaSource = {
      videoId,
      name: m.name,
      filePath: encoded ? encoded.filePath : (m.filePath || undefined),
      url: !encoded && m.url && /^https?:\/\//.test(m.url) ? m.url : undefined,
    };
    if ((s.filePath && fs.existsSync(s.filePath)) || (s.url && /^https?:\/\//.test(s.url))) sources.push(s);
  }
  return sources;
}

/** 读取素材字节：本地文件优先，其次下载远程直链 */
async function readSourceBytes(s: MediaSource): Promise<{ bytes: Buffer; fileName: string }> {
  if (s.filePath && fs.existsSync(s.filePath)) {
    return { bytes: fs.readFileSync(s.filePath), fileName: path.basename(s.filePath) };
  }
  const bytes = await downloadBufferTraced(s.url!, `剪辑降级：下载素材「${s.name}」到内存`);
  const m = s.url!.match(/\/([^/?]+)(?:\?|$)/);
  return { bytes, fileName: m ? m[1] : `source_${Date.now()}.mp4` };
}

/** 把素材逐一上传到 MiniMax（mm_file:// 引用），供多模态画面理解；返回成功上传的媒体列表 */
async function uploadAllSources(
  client: MiniMaxClient,
  sources: MediaSource[],
): Promise<{ type: 'video'; url: string }[]> {
  const uploaded: { type: 'video'; url: string }[] = [];
  for (const s of sources) {
    if (client.aborted) throw new Error('任务已取消');
    try {
      const { bytes, fileName } = await readSourceBytes(s);
      const ref = await client.uploadVideo(bytes, `edit_src_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
      uploaded.push({ type: 'video', url: ref });
      trace.add({
        kind: 'minimax', title: '已上传素材视频到 MiniMax（用于画面理解）',
        endpoint: `${client.baseUrl}/files/upload`, method: 'POST', model: client.model,
        status: 200, ok: true, durationMs: 0,
        summary: `素材「${s.name}」已上传，获得引用 ${ref}`,
      });
    } catch (e: any) {
      trace.add({
        kind: 'minimax', title: `素材「${s.name}」上传失败`, endpoint: `${client.baseUrl}/files/upload`,
        method: 'POST', model: client.model, status: 500, ok: false, durationMs: 0,
        summary: e?.message ?? String(e),
      });
    }
  }
  return uploaded;
}

/**
 * 降级成功时，把重编码后的「过审资源」另存到本地 encoded 目录，并写回视频库 localEncodedMediaUrl 字段
 * （页面上不展示）。后续该视频再被分析时，prepareSources 会优先复用该文件，无需重新降级。
 */
function saveEncoded(dataService: DataService, videoId: string | undefined, sanBuf: Buffer): void {
  if (!videoId) return;
  try {
    const encFileName = `${safeName(videoId)}_encoded.mp4`;
    fs.writeFileSync(path.join(encodedDir(), encFileName), sanBuf);
    dataService.setVideoEncodedMediaUrl(videoId, `localmedia://encoded/${encodeURIComponent(encFileName)}`);
  } catch { /* 保存失败不影响本次分析结果 */ }
}

/**
 * 生成剪辑方案。流程（对「敏感」与「媒体不可达(500)」一视同仁，按用户要求顺序）：
 *   1) 先把素材上传到 MiniMax（本地读字节/远程下载 → mm_file://），再做多模态直连生成；
 *   2) 失败 → ffmpeg 重新编码 → 重新上传 → 用新链接重新生成（成功即保存过审资源）；
 *   3) 仍失败 → 抽帧（每秒 1 帧）→ 上传图片集 → 用图片集重新生成；
 *   4) 仍失败 → 基于素材元数据做纯文本兜底。
 * 全程不修改传入的 materials（渲染仍用原始素材）。
 */
export async function generateEditPlansSafe(
  client: MiniMaxClient,
  dataService: DataService,
  materials: EditMaterial[],
): Promise<EditPlanRecoveryResult> {
  const sources = prepareSources(materials, dataService);

  // —— 第一步：上传素材后直连生成（严格多模态，失败不降级）——
  const uploadedMedia = await uploadAllSources(client, sources);
  const direct = await client.generateEditPlansSafe(materials, uploadedMedia.length ? uploadedMedia : undefined);
  if (direct.ok && direct.data && direct.data.length > 0) {
    return { plans: direct.data, method: uploadedMedia.length ? 'direct' : 'text', sensitiveRecovered: false };
  }

  // 没有任何可降级素材源（纯元数据素材）：只能纯文本兜底
  if (!sources.length) {
    const text = await client.generateEditPlansSafe(materials, []);
    if (text.ok && text.data && text.data.length > 0) return { plans: text.data, method: 'text', sensitiveRecovered: false };
    throw new Error(text.error || direct.error || '剪辑方案生成失败');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ost-edit-rec-'));
  try {
    // —— 方案1：重新编码脱敏（仅用于生成方案，渲染仍用原始素材）——
    try {
      const sanitizedMedia: { type: 'video'; url: string }[] = [];
      for (const s of sources) {
        if (client.aborted) throw new Error('任务已取消');
        const { bytes: rawBuf, fileName } = await readSourceBytes(s);
        const rawPath = path.join(tmp, `raw_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
        fs.writeFileSync(rawPath, rawBuf);
        const sanPath = path.join(tmp, `san_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
        await sanitizeVideo(rawPath, sanPath);
        const sanBuf = fs.readFileSync(sanPath);
        // 保存过审资源（供后续复用）
        saveEncoded(dataService, s.videoId, sanBuf);
        const ref = await client.uploadVideo(sanBuf, `edit_sanitized_${Date.now()}.mp4`);
        sanitizedMedia.push({ type: 'video', url: ref });
        trace.add({
          kind: 'minimax',
          title: '剪辑降级：ffmpeg 重新编码并重新上传 MiniMax',
          endpoint: `${client.baseUrl}/files/upload`,
          method: 'POST',
          model: client.model,
          status: 200,
          ok: true,
          durationMs: 0,
          summary: `已重编码（去元数据/改分辨率码率/轻微裁剪/调帧率）并上传，获得新链接 ${ref}（渲染阶段仍使用原始素材）`,
        });
      }
      const r2 = await client.generateEditPlansSafe(materials, sanitizedMedia);
      if (r2.ok && r2.data && r2.data.length > 0) {
        return { plans: r2.data, method: 'sanitized', sensitiveRecovered: true };
      }
    } catch (e: any) {
      if (client.aborted) throw new Error('任务已取消');
      /* 重编码分支失败，继续尝试抽帧 */
    }

    // —— 方案2：抽帧图片集 ——
    try {
      const frameMedia: { type: 'image'; url: string }[] = [];
      for (const s of sources) {
        if (client.aborted) throw new Error('任务已取消');
        const { bytes: rawBuf } = await readSourceBytes(s);
        const rawPath = path.join(tmp, `raw2_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
        fs.writeFileSync(rawPath, rawBuf);
        const sanPath = path.join(tmp, `san2_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
        await sanitizeVideo(rawPath, sanPath);
        const frameDir = path.join(tmp, `frames_${Date.now()}`);
        const frames = await extractFramesPerSecond(sanPath, frameDir, 30);
        trace.add({
          kind: 'minimax',
          title: `剪辑降级：ffmpeg 抽帧（每秒1帧，共 ${frames.length} 张）`,
          model: client.model,
          status: 200,
          ok: true,
          durationMs: 0,
          summary: '重新编码后仍不可用，改用抽帧图片集生成方案（渲染仍用原始素材）',
        });
        for (const f of frames.slice(0, 12)) {
          const buf = fs.readFileSync(f);
          frameMedia.push({ type: 'image', url: await client.uploadImage(buf, path.basename(f)) });
        }
      }
      if (frameMedia.length) {
        const r3 = await client.generateEditPlansSafe(materials, frameMedia);
        if (r3.ok && r3.data && r3.data.length > 0) {
          return { plans: r3.data, method: 'frames', sensitiveRecovered: true };
        }
      }
    } catch (e: any) {
      if (client.aborted) throw new Error('任务已取消');
      /* 抽帧分支失败，继续纯文本兜底 */
    }

    // —— 方案3：纯文本兜底（基于素材元数据，作为最后手段）——
    const r4 = await client.generateEditPlansSafe(materials, []);
    if (r4.ok && r4.data && r4.data.length > 0) {
      return { plans: r4.data, method: 'text', sensitiveRecovered: false };
    }
    throw new Error(
      r4.error ||
        '视频经「重新编码」与「抽帧图片集」两种降级方式生成剪辑方案仍失败，且纯文本兜底也失败。' +
        '建议：① 更换内容限制更宽松的模型；② 改用本地素材；③ 人工规划剪辑方案。',
    );
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ===========================================================================
// 模块四：爆款视频拆解 —— 同样接入「降级恢复」流程（完整卡片展示 + 保存过审资源）
// ===========================================================================

export interface ViralBreakdownRecoveryResult {
  result: ViralBreakdownResult;
  method: 'direct' | 'sanitized' | 'frames' | 'text';
  sensitiveRecovered: boolean;
}

/**
 * 爆款视频拆解 + 降级恢复：
 *   1) 优先使用视频库已保存的过审资源（localEncodedMediaUrl）；
 *   2) 直连（先上传到 MiniMax）→ 失败 → ffmpeg 重新编码 → 抽帧 → 纯文本兜底；
 *   3) 重编码成功后保存过审资源回写视频库。
 * 每个阶段都有独立 trace 卡片，供工作流弹窗完整展示处理流程。
 */
export async function breakdownViralVideoWithRecovery(
  client: MiniMaxClient,
  dataService: DataService,
  payload: { videoId: string; platform: Platform; title: string; comments: string[]; url?: string },
): Promise<ViralBreakdownRecoveryResult> {
  const video: SocialVideo | undefined = dataService.getVideoDb().find((v) => v.id === payload.videoId);
  const mediaUrl = payload.url || video?.mediaUrl;
  const title = payload.title || video?.title || '';
  const comments = payload.comments ?? [];
  const id = payload.videoId;

  const encodedLocal = resolveLocalMedia(video?.localEncodedMediaUrl);
  const originalLocal = resolveLocalMedia(video?.localMediaUrl);

  /** 把本地字节上传到 MiniMax 后用引用做严格拆解 */
  async function analyzeLocal(bytes: Buffer, fileName: string) {
    const upStart = Date.now();
    const ref = await client.uploadVideo(bytes, fileName);
    trace.add({
      kind: 'minimax', title: '已上传视频到 MiniMax（用于爆款拆解）', endpoint: `${client.baseUrl}/files/upload`,
      method: 'POST', model: client.model, status: 200, ok: true, durationMs: Date.now() - upStart,
      summary: `获得引用 ${ref}（MiniMax 云端可读取）`,
    });
    return breakdownViralVideoSafe(client, { title, comments, url: ref });
  }

  // —— 直连：过审资源 > 本地落盘 > 远程直链（严格多模态，不自动降级）——
  let direct;
  if (encodedLocal) direct = await analyzeLocal(encodedLocal.bytes, encodedLocal.fileName);
  else if (originalLocal) direct = await analyzeLocal(originalLocal.bytes, originalLocal.fileName);
  else if (mediaUrl && /^https?:\/\//.test(mediaUrl)) {
    // 远程直链也先下载上传，避免 MiniMax 服务端拉取失败
    try {
      const buf = await downloadBufferTraced(mediaUrl, '爆款拆解：下载原始视频到内存');
      direct = await analyzeLocal(buf, `${safeName(id)}.mp4`);
    } catch {
      direct = await breakdownViralVideoSafe(client, { title, comments, url: mediaUrl });
    }
  } else {
    direct = await breakdownViralVideoSafe(client, { title, comments });
  }
  if (direct.ok && direct.data) {
    return { result: direct.data, method: encodedLocal ? 'sanitized' : 'direct', sensitiveRecovered: !!encodedLocal };
  }

  // —— 降级源：本地文件 > 已编码文件 > 远程直链 ——
  let sourceBytes: Buffer | null = null;
  let sourceName = `${safeName(id)}.mp4`;
  if (originalLocal) { sourceBytes = originalLocal.bytes; sourceName = originalLocal.fileName; }
  else if (encodedLocal) { sourceBytes = encodedLocal.bytes; sourceName = encodedLocal.fileName; }
  else if (mediaUrl && /^https?:\/\//.test(mediaUrl)) {
    try { sourceBytes = await downloadBufferTraced(mediaUrl, '爆款拆解降级：下载原始视频到内存'); } catch { sourceBytes = null; }
  }
  if (!sourceBytes) {
    const text = await breakdownViralVideoSafe(client, { title, comments });
    if (text.ok && text.data) return { result: text.data, method: 'text', sensitiveRecovered: false };
    throw new Error(text.error || direct.error || '爆款拆解失败');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ost-breakdown-rec-'));
  try {
    // —— 方案1：ffmpeg 重新编码 ——
    if (client.aborted) throw new Error('任务已取消');
    const rawPath = path.join(tmp, 'raw.mp4');
    fs.writeFileSync(rawPath, sourceBytes);
    const sanPath = path.join(tmp, 'sanitized.mp4');
    const encStart = Date.now();
    await sanitizeVideo(rawPath, sanPath);
    const sanBuf = fs.readFileSync(sanPath);
    saveEncoded(dataService, id, sanBuf); // 保存过审资源
    trace.add({
      kind: 'minimax', title: '爆款拆解降级：ffmpeg 重新编码并上传 MiniMax', endpoint: `${client.baseUrl}/files/upload`,
      method: 'POST', model: client.model, status: 200, ok: true, durationMs: Date.now() - encStart,
      summary: `已重编码（去元数据/改分辨率码率/轻微裁剪/调帧率）并保存为过审资源`,
    });
    const san = await analyzeLocal(sanBuf, `${safeName(id)}_encoded.mp4`);
    if (san.ok && san.data) return { result: san.data, method: 'sanitized', sensitiveRecovered: true };

    // —— 方案2：抽帧图片集 ——
    if (client.aborted) throw new Error('任务已取消');
    const frameDir = path.join(tmp, 'frames');
    const frStart = Date.now();
    const frames = await extractFramesPerSecond(sanPath, frameDir, 30);
    trace.add({
      kind: 'minimax', title: `爆款拆解降级：ffmpeg 抽帧（每秒1帧，共 ${frames.length} 张）`,
      model: client.model, status: 200, ok: true, durationMs: Date.now() - frStart,
      summary: '重新编码后仍不可用，改用抽帧图片集拆解',
    });
    const upFramesStart = Date.now();
    const imageRefs: string[] = [];
    for (const f of frames.slice(0, 12)) {
      if (client.aborted) throw new Error('任务已取消');
      imageRefs.push(await client.uploadImage(fs.readFileSync(f), path.basename(f)));
    }
    if (imageRefs.length) {
      trace.add({
        kind: 'minimax', title: `爆款拆解降级：已上传 ${imageRefs.length} 张帧图片到 MiniMax`, endpoint: `${client.baseUrl}/files/upload`,
        method: 'POST', model: client.model, status: 200, ok: true, durationMs: Date.now() - upFramesStart,
        summary: '将以图片集方式交给 MiniMax 做内容拆解',
      });
      const framesRes = await breakdownViralVideoSafe(
        client,
        { title, comments },
        imageRefs.map((u) => ({ type: 'image' as const, url: u })),
      );
      if (framesRes.ok && framesRes.data) return { result: framesRes.data, method: 'frames', sensitiveRecovered: true };
    }

    // —— 方案3：纯文本兜底 ——
    const text = await breakdownViralVideoSafe(client, { title, comments });
    if (text.ok && text.data) return { result: text.data, method: 'text', sensitiveRecovered: false };
    throw new Error(
      text.error ||
        '视频经「重新编码」与「抽帧图片集」两种降级方式拆解仍失败，且纯文本兜底也失败。' +
        '建议：① 更换内容限制更宽松的模型；② 跳过该条视频。',
    );
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export { analyzeVideoWithRecovery };
