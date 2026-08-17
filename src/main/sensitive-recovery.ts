// 敏感内容自动脱敏恢复流程（主进程）
// 当视频直连解析被 MiniMax 判定为敏感内容时，依次尝试两种脱敏方案：
//   方案1（重新编码）：下载视频 → ffmpeg 去元数据/改分辨率码率/轻微裁剪/调帧率 → 重新上传 MiniMax 拿新链接
//                      → 用新链接重新解析；成功则把数据库 mediaUrl 替换为新链接（后续解析直接使用脱敏版本）。
//   方案2（抽帧）：若方案1后仍敏感 → ffmpeg 每秒抽 1 帧 → 上传图片集 → 用图片集交给 MiniMax 分析。
// 两种方案均失败则抛出清晰中文错误，由 UI 提示人工分析。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { MiniMaxClient } from '../data/minimax';
import { DataService } from '../data';
import { Platform, SocialVideo } from '../shared/types';
import { parseVideoSafe, parseVideoFramesSafe, VideoParseResult } from '../analysis/ai-tasks';
import { EditMaterial, EditPlan } from '../analysis/ai-edit';
import { sanitizeVideo, extractFramesPerSecond } from './ffmpeg';
import { trace } from '../shared/trace';

export interface RecoveryResult {
  analysis: VideoParseResult;
  method: 'direct' | 'sanitized' | 'frames';
  updatedMediaUrl?: string;
  sensitiveRecovered: boolean;
}

/** 把远程直链下载为本地 Buffer（递归跟随重定向） */
function downloadBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadBuffer(res.headers.location).then(resolve, reject);
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`媒体下载失败 HTTP ${res.statusCode} (${url})`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
  });
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

  // —— 第一步：直连解析 ——
  const direct = await parseVideoSafe(client, { title, tags, url: mediaUrl });
  if (direct.ok && direct.data) {
    return { analysis: direct.data, method: 'direct', sensitiveRecovered: false };
  }
  if (!direct.sensitive) {
    // 非敏感类错误（如网络/参数）直接抛出，由上层展示
    throw new Error(direct.error || '视频解析失败');
  }

  // —— 命中敏感：需要本地文件才能做 ffmpeg 预处理 ——
  if (!mediaUrl || !/^https?:\/\//.test(mediaUrl)) {
    throw new Error(
      '该视频被 MiniMax 判定为敏感内容，但其媒体链接不是可下载的临时直链（已是 MiniMax 引用或缺失），无法在本地做脱敏预处理。' +
      '建议：① 在「设置」中更换为内容限制更宽松的模型；② 仅基于标题/标签人工分析；③ 跳过该条视频。',
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ost-rec-'));
  try {
    // 下载原始视频
    const rawBuf = await downloadBuffer(mediaUrl);
    const rawPath = path.join(tmp, 'raw.mp4');
    fs.writeFileSync(rawPath, rawBuf);
    trace.add({
      kind: 'minimax', title: '敏感内容处理：已下载原始视频到本地', endpoint: mediaUrl, method: 'GET',
      model: client.model, status: 200, ok: true, durationMs: 0,
      summary: `原始文件大小 ${(rawBuf.length / 1024 / 1024).toFixed(1)} MB，准备进入脱敏预处理`,
    });

    // —— 方案1：重新编码脱敏 ——
    const sanitizedPath = path.join(tmp, 'sanitized.mp4');
    await sanitizeVideo(rawPath, sanitizedPath);
    const sanitizedBuf = fs.readFileSync(sanitizedPath);
    const newRef = await client.uploadVideo(sanitizedBuf, `${id}_sanitized.mp4`);
    trace.add({
      kind: 'minimax', title: '敏感内容处理：ffmpeg 重新编码并重新上传 MiniMax', endpoint: `${client.baseUrl}/files/upload`,
      method: 'POST', model: client.model, status: 200, ok: true, durationMs: 0,
      summary: `已重新编码（去元数据/改分辨率码率/轻微裁剪/调帧率）并上传，获得新链接 ${newRef}`,
    });

    const sanitized = await parseVideoSafe(client, { title, tags, url: newRef });
    if (sanitized.ok && sanitized.data) {
      // 回写数据库：用脱敏后的新链接替换，保证后续解析直接使用
      dataService.updateVideoMediaUrl(id, newRef);
      trace.add({
      kind: 'minimax', title: '敏感内容处理：脱敏后解析成功，已更新数据库媒体链接', endpoint: '',
      model: client.model, status: 200, ok: true, durationMs: 0,
        summary: `已把视频 ${id} 的 mediaUrl 替换为脱敏版本 ${newRef}`,
      method: 'POST',
      });
      return { analysis: sanitized.data, method: 'sanitized', updatedMediaUrl: newRef, sensitiveRecovered: true };
    }

    // 方案1 后仍敏感 → 方案2：抽帧
    if (!sanitized.sensitive) {
      throw new Error(sanitized.error || '脱敏后视频解析失败（非敏感原因）');
    }
    const frameDir = path.join(tmp, 'frames');
    const frames = await extractFramesPerSecond(sanitizedPath, frameDir, 30);
    trace.add({
      kind: 'minimax', title: `敏感内容处理：ffmpeg 抽帧（每秒1帧，共 ${frames.length} 张）`, endpoint: '',
      model: client.model, status: 200, ok: true, durationMs: 0,
      summary: '原视频脱敏重编码后仍被拦截，改用抽帧图片集分析',
    });
    if (!frames.length) {
      throw new Error('已对视频抽帧，但未得到任何帧图片，无法继续分析。');
    }
    // 上传图片集（最多取前 12 张，控制请求体积）
    const imageRefs: string[] = [];
    for (const f of frames.slice(0, 12)) {
      const buf = fs.readFileSync(f);
      imageRefs.push(await client.uploadImage(buf, path.basename(f)));
    }
    trace.add({
      kind: 'minimax', title: `敏感内容处理：已上传 ${imageRefs.length} 张帧图片到 MiniMax`, endpoint: `${client.baseUrl}/files/upload`,
      method: 'POST', model: client.model, status: 200, ok: true, durationMs: 0,
      summary: '将以图片集方式交给 MiniMax 做内容分析',
    });

    const framesRes = await parseVideoFramesSafe(client, { title, tags, imageUrls: imageRefs });
    if (framesRes.ok && framesRes.data) {
      return { analysis: framesRes.data, method: 'frames', sensitiveRecovered: true };
    }
    if (!framesRes.sensitive) {
      throw new Error(framesRes.error || '抽帧图片集分析失败');
    }
    throw new Error(
      '视频经「重新编码脱敏」与「抽帧图片集」两种方式分析，仍被 MiniMax 内容安全策略判定为敏感，无法生成 AI 分析。' +
      '建议：① 更换内容限制更宽松的模型；② 仅基于标题/标签人工分析；③ 跳过该条视频。',
    );
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ===========================================================================
// 模块七：AI 视频剪辑 —— 视频被判敏感时的脱敏恢复
// 与「视频分析」共享同一套 ffmpeg 脱敏脚本（重新编码 / 抽帧），但关键约束不同：
//   - 脱敏后的新链接【只用于生成剪辑方案（让 MiniMax 看懂内容）】，绝不写回数据库；
//   - 最终 ffmpeg 渲染成片时，始终使用【原始素材】（用户传入的 url / filePath），保证成品内容是原始视频。
// ===========================================================================

export interface EditPlanRecoveryResult {
  plans: EditPlan[];
  method: 'direct' | 'sanitized' | 'frames';
  sensitiveRecovered: boolean;
}

/**
 * 生成剪辑方案，并在视频被 MiniMax 判定为敏感时自动脱敏恢复：
 *   1) 直连生成 → 成功直接返回；
 *   2) 敏感 → 下载本地 → ffmpeg 重新编码 → 重新上传 MiniMax → 用新链接重新生成；
 *   3) 仍敏感 → 抽帧 → 上传图片集 → 用图片集重新生成。
 * 全程不修改传入的 materials（渲染仍用原始素材）。
 */
export async function generateEditPlansSafe(
  client: MiniMaxClient,
  materials: EditMaterial[],
): Promise<EditPlanRecoveryResult> {
  const videoUrls = materials
    .filter((m) => m.url && /^https?:\/\//.test(m.url))
    .map((m) => m.url!);

  // 第一步：直连生成
  const direct = await client.generateEditPlansSafe(materials);
  if (direct.ok && direct.data) {
    return { plans: direct.data, method: 'direct', sensitiveRecovered: false };
  }
  if (!direct.sensitive) {
    throw new Error(direct.error || '剪辑方案生成失败');
  }

  if (!videoUrls.length) {
    throw new Error(
      '视频被 MiniMax 判定为敏感，但素材中没有可下载的临时直链，无法在本地做脱敏预处理。' +
      '建议：① 在「设置」中更换为内容限制更宽松的模型；② 使用本地视频文件作为素材；③ 仅用元数据素材。',
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ost-edit-rec-'));
  try {
    // 方案1：重新编码脱敏（仅用于生成方案）
    const sanitizedMedia: { type: 'video'; url: string }[] = [];
    for (const u of videoUrls) {
      const rawBuf = await downloadBuffer(u);
      const rawPath = path.join(tmp, `raw_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
      fs.writeFileSync(rawPath, rawBuf);
      const sanPath = path.join(tmp, `san_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
      await sanitizeVideo(rawPath, sanPath);
      const sanBuf = fs.readFileSync(sanPath);
      const ref = await client.uploadVideo(sanBuf, `edit_sanitized_${Date.now()}.mp4`);
      sanitizedMedia.push({ type: 'video', url: ref });
      trace.add({
        kind: 'minimax',
        title: '剪辑脱敏：ffmpeg 重新编码并重新上传 MiniMax（仅用于生成方案）',
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
    if (r2.ok && r2.data) {
      return { plans: r2.data, method: 'sanitized', sensitiveRecovered: true };
    }
    if (!r2.sensitive) {
      throw new Error(r2.error || '脱敏后剪辑方案生成失败');
    }

    // 方案2：抽帧图片集
    const frameMedia: { type: 'image'; url: string }[] = [];
    for (const u of videoUrls) {
      const rawBuf = await downloadBuffer(u);
      const rawPath = path.join(tmp, `raw2_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
      fs.writeFileSync(rawPath, rawBuf);
      const sanPath = path.join(tmp, `san2_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
      await sanitizeVideo(rawPath, sanPath);
      const frameDir = path.join(tmp, `frames_${Date.now()}`);
      const frames = await extractFramesPerSecond(sanPath, frameDir, 30);
      trace.add({
        kind: 'minimax',
        title: `剪辑脱敏：ffmpeg 抽帧（每秒1帧，共 ${frames.length} 张）`,
        model: client.model,
        status: 200,
        ok: true,
        durationMs: 0,
        summary: '重新编码后仍被拦截，改用抽帧图片集生成方案（渲染仍用原始素材）',
      });
      for (const f of frames.slice(0, 12)) {
        const buf = fs.readFileSync(f);
        frameMedia.push({ type: 'image', url: await client.uploadImage(buf, path.basename(f)) });
      }
    }
    const r3 = await client.generateEditPlansSafe(materials, frameMedia);
    if (r3.ok && r3.data) {
      return { plans: r3.data, method: 'frames', sensitiveRecovered: true };
    }
    throw new Error(
      '视频经「重新编码」与「抽帧图片集」两种脱敏方式生成剪辑方案，仍被 MiniMax 判定为敏感，无法生成。' +
      '建议：① 更换内容限制更宽松的模型；② 改用本地素材；③ 人工规划剪辑方案。',
    );
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export { analyzeVideoWithRecovery };
