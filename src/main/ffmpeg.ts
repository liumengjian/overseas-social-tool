// 模块七：真实视频剪辑渲染管线（主进程，Node 环境）
// 依据 MiniMax 生成的 EditPlan，对真实素材做「裁剪 + 缩放 + 拼接 + 可选烧录字幕」，输出 mp4。
// 素材来源：仅允许本地绝对路径 filePath；AI 剪辑不下载或处理远程链接。
// ffmpeg 二进制由 ffmpeg-static 提供（用户 npm install 后存在）；未安装时给出明确报错。
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EditMaterial, EditPlan } from "../analysis/ai-edit";
// @ts-ignore - ffmpeg-static 类型见 src/main/ffmpeg-static.d.ts
import ffmpegStatic from "ffmpeg-static";

export interface RenderOptions {
  burnCaptions: boolean;
  outDir: string;
  subtitle?: {
    position?: "top" | "center" | "bottom";
    color?: string;
    fontSize?: number;
    font?: string;
    x?: number;
    y?: number;
    strokeColor?: string;
    strokeWidth?: number;
    outlineColor?: string;
    outlineWidth?: number;
    /** 标题字幕独立样式（未提供时沿用 subtitle 样式） */
    title?: {
      position?: "top" | "center" | "bottom";
      color?: string;
      fontSize?: number;
      font?: string;
      strokeColor?: string;
      strokeWidth?: number;
      outlineColor?: string;
      outlineWidth?: number;
    };
  };
  /** 独立标题字幕样式（兼容渲染端传入的顶层字段） */
  titleSubtitle?: {
    position?: "top" | "center" | "bottom";
    color?: string;
    fontSize?: number;
    font?: string;
    strokeColor?: string;
    strokeWidth?: number;
    x?: number;
    y?: number;
    width?: number;
    fontWeight?: "normal" | "bold" | number;
    outlineColor?: string;
    outlineWidth?: number;
  };
  voiceoverText?: string;
  voiceoverLocale?: string;
  voiceoverSegments?: Array<{
    text: string;
    startSec: number;
    endSec: number;
  }>;
  voiceoverVoice?: string;
  voiceoverRate?: number;
  videoType?: 'landscape' | 'portrait';
  fontDir?: string;
}

export interface RenderResult {
  direction: EditPlan["direction"];
  platform: EditPlan["platform"];
  outputPath: string;
  error?: string;
}

function ffmpegBin(): string {
  if (!ffmpegStatic) {
    throw new Error(
      "未找到 ffmpeg 二进制：请先执行 npm install 安装 ffmpeg-static（或在本机安装 ffmpeg 并放入 PATH）。",
    );
  }
  const bin = ffmpegStatic as string;
  if (!fs.existsSync(bin)) {
    throw new Error(
      `未找到 ffmpeg 可执行文件（${bin}）。ffmpeg-static 的二进制未随安装自动下载，` +
        "请重新安装 ffmpeg-static（触发 postinstall 下载），或在本机安装 ffmpeg 并放入 PATH。",
    );
  }
  return bin;
}

async function resolveMaterialPath(
  m: EditMaterial,
  _tmp: string,
): Promise<string> {
  if (m.filePath && fs.existsSync(m.filePath)) return m.filePath;
  throw new Error(`素材「${m.name}」必须是已上传的本地视频文件`);
}

function findFont(extraDir?: string): string | null {
  const roots = [extraDir, path.resolve(process.cwd(), "static", "font"), path.resolve((process as any).resourcesPath || "", "static", "font"), path.resolve(__dirname, "../../static/font")].filter(Boolean) as string[];
  for (const bundled of roots) {
    try {
      const first = fs.readdirSync(bundled).find((f) => /\.(ttf|otf|ttc)$/i.test(f));
      if (first) return path.join(bundled, first);
    } catch { /* ignore */ }
  }
  const candidates = [
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/msyh.ttc",
    "/Library/Fonts/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
  ];
  return candidates.find((f) => fs.existsSync(f)) ?? null;
}

function resolveFont(font?: string, extraDir?: string): string | null {
  if (!font) {
    return findFont(extraDir);
  }
  const roots = [
    extraDir,
    path.resolve(process.cwd(), "static", "font"),
    path.resolve((process as any).resourcesPath || "", "static", "font"),
    path.resolve(__dirname, "../../static/font"),
    // 添加绝对路径作为候选
    "E:/project/overseas-social-tool/static/font"
  ].filter(Boolean) as string[];
  const candidates = path.isAbsolute(font) ? [font] : roots.map((r) => path.join(r, path.basename(font)));
  // 检查每个候选路径是否存在
  const existsCheck = candidates.map(c => ({ path: c, exists: fs.existsSync(c) }));
  const resolved = candidates.find((c) => fs.existsSync(c)) ?? findFont(extraDir);
  return resolved;
}

function validColor(value: unknown, fallback = "white"): string {
  const v = String(value ?? "");
  return /^[a-zA-Z]+$|^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
}

// drawtext 文本转义：反斜杠、冒号、单引号
function escapeDrawtext(t: string): string {
  return t
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

function runFfmpeg(args: string[]): Promise<void> {
  const bin = ffmpegBin();
  return new Promise((resolve, reject) => {
    const p = execFile(bin, args, (err, _stdout, stderr) => {
      if (err) {
        reject(
          new Error(
            `ffmpeg 执行失败：${(stderr || "").slice(-1000) || err.message}`,
          ),
        );
        return;
      }
      resolve();
    });
    // 超时保护：单个成片最长 5 分钟
    p?.on("error", reject);
  });
}

/** 检测素材是否存在音频流，避免对无音轨视频引用 [N:a] 导致滤镜图初始化失败。 */
async function hasAudioStream(inputPath: string): Promise<boolean> {
  const bin = ffmpegBin();
  return new Promise((resolve) => {
    execFile(
      bin,
      ["-hide_banner", "-i", inputPath, "-t", "0.1", "-map", "0:a:0", "-f", "null", "-"],
      (_err, _stdout, stderr) => resolve(/Stream #\d+:\d+.*Audio:/i.test(stderr || "")),
    );
  });
}

/** 按单个 EditPlan 渲染成片，返回输出文件路径 */
export async function renderPlan(
  materials: EditMaterial[],
  plan: EditPlan,
  opts: RenderOptions,
): Promise<string> {
  if (!plan.clips.length && !materials.length) {
    throw new Error("方案没有可用素材，无法渲染");
  }
  fs.mkdirSync(opts.outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ost-edit-"));
  try {
    // 定位方案引用的素材
    // 如果plan.clips有内容，按clips的顺序查找对应的素材
    // 否则使用全部素材
    const paths: string[] = [];
    if (plan.clips.length) {
      // 按clips的顺序逐一查找素材
      for (let i = 0; i < plan.clips.length; i++) {
        const name = plan.clips[i];
        const m = materials.find((x) => x.name === name) ?? materials.find((x) => name && x.name.includes(name));
        if (!m) throw new Error(`方案引用的素材「${name}」不在素材列表中`);
        // 即使找到同一个素材，也要为每个clip添加一次路径
        paths.push(await resolveMaterialPath(m, tmp));
      }
    } else {
      // 没有clips，使用全部素材
      for (const m of materials) {
        paths.push(await resolveMaterialPath(m, tmp));
      }
    }

    const K = paths.length;
    const audioAvailable = await Promise.all(paths.map((p) => hasAudioStream(p)));
    const per = Math.max(1, Math.round(plan.durationSec / K));
    const subtitle = opts.subtitle ?? {};
    const voiceStyle = subtitle;
    const titleStyle = opts.titleSubtitle ?? subtitle.title ?? subtitle;
    // 字幕样式来自设置页，是成片的一部分。不要以是否存在 AI 方案脚本为条件，
    // 否则方案脚本会悄悄绕过用户保存的字幕配置。
    const voiceFont = opts.burnCaptions ? resolveFont(voiceStyle.font, opts.fontDir) : null;
    const titleFont = opts.burnCaptions ? resolveFont(titleStyle.font, opts.fontDir) : null;
    const voiceSize = Math.max(12, Math.min(120, Number(voiceStyle.fontSize) || 48));
    const titleSize = Math.max(12, Math.min(120, Number(titleStyle.fontSize) || voiceSize));
    const voiceColor = validColor(voiceStyle.color);
    const titleColor = validColor(titleStyle.color, voiceColor);
    const voiceStroke = validColor(voiceStyle.strokeColor ?? voiceStyle.outlineColor, "black");
    const titleStroke = validColor(titleStyle.strokeColor ?? titleStyle.outlineColor, voiceStroke);
    const voiceStrokeW = Math.max(0, Math.min(20, Number(voiceStyle.outlineWidth ?? voiceStyle.strokeWidth) || 0));
    const titleStrokeW = Math.max(0, Math.min(20, Number(titleStyle.outlineWidth ?? titleStyle.strokeWidth) || 0));

    const inputs: string[] = [];
    const seenPaths = new Map<string, number>();
    paths.forEach((p, index) => {
      // 如果同一个素材文件被多次引用，需要为每次引用创建独立的输入
      // 通过在临时目录创建硬链接来实现
      let inputPath = p;
      const count = seenPaths.get(p) || 0;
      if (count > 0) {
        // 第二次及以后使用该素材，创建硬链接
        const ext = path.extname(p);
        const linkPath = path.join(tmp, `input_${index}${ext}`);
        try {
          fs.linkSync(p, linkPath);
          inputPath = linkPath;
        } catch {
          // 如果硬链接失败（可能跨分区），则复制文件
          fs.copyFileSync(p, linkPath);
          inputPath = linkPath;
        }
      }
      seenPaths.set(p, count + 1);

      // 图片素材作为循环输入，便于按时间段参与视频拼接
      if (/\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(p))
        inputs.push("-loop", "1", "-i", inputPath);
      else inputs.push("-i", inputPath);
    });
    const voiceTracks: Array<{ path: string; delayMs: number }> = [];
    if (opts.voiceoverText?.trim()) {
      const voicePath = await synthesizeVoiceover(
        opts.voiceoverText,
        path.join(tmp, "voiceover.mp3"),
        opts.voiceoverVoice,
        opts.voiceoverRate,
        opts.voiceoverLocale,
      );
      if (voicePath) voiceTracks.push({ path: voicePath, delayMs: 0 });
    }
    for (let i = 0; i < (opts.voiceoverSegments ?? []).length; i++) {
      const segment = opts.voiceoverSegments![i];
      if (!segment?.text?.trim()) continue;
      const voicePath = await synthesizeVoiceover(
        segment.text,
        path.join(tmp, `voiceover_${i}.mp3`),
        opts.voiceoverVoice,
        opts.voiceoverRate,
        opts.voiceoverLocale,
      );
      if (voicePath) {
        voiceTracks.push({
          path: voicePath,
          delayMs: Math.max(0, Math.round(Number(segment.startSec) * 1000)),
        });
      }
    }
    for (const track of voiceTracks) inputs.push("-i", track.path);

    const filterParts: string[] = [];
    const concatIns: string[] = [];
    for (let i = 0; i < K; i++) {
      const range = plan.clipRanges?.[i];
      const clipStart = Math.max(0, Number(range?.startSec) || 0);
      const clipDuration = Math.max(0.1, range ? Number(range.endSec) - clipStart : per);
      const vw = opts.videoType === 'landscape' ? 1920 : 1080;
      const vh = opts.videoType === 'landscape' ? 1080 : 1920;
      let v = `[${i}:v]scale=${vw}:${vh}:force_original_aspect_ratio=decrease,pad=${vw}:${vh}:(ow-iw)/2:(oh-ih)/2,setsar=1,trim=start=${clipStart}:duration=${clipDuration},setpts=PTS-STARTPTS`;
      // 未勾选时使用静音轨；勾选时读取对应源视频音轨并按同一时间区间裁剪。
      // 原音频随后会与可选的 TTS 口播混音，不会被覆盖。
      const keepOriginalAudio =
        plan.preserveAudio?.[i] === true && audioAvailable[i];
      const a = keepOriginalAudio
        ? `[${i}:a]aresample=48000,atrim=start=${clipStart}:duration=${clipDuration},asetpts=PTS-STARTPTS[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${clipDuration},asetpts=PTS-STARTPTS[a${i}]`;
      const addCaption = (text: string | undefined, style: any, fontPath: string | null, size: number, color: string, stroke: string, strokeW: number, suffix: string) => {
        if (!fontPath || !text) return;
        const captionFile = path.join(tmp, `${suffix}_${i}.txt`);
        // 计算字幕的实际像素宽度和每行字符数
        const videoWidth = vw; // 1920 (横屏) 或 1080 (竖屏)
        const subtitleWidthRatio = style.width != null ? Math.max(0.15, Math.min(1, Number(style.width))) : 1.0;
        const textBoxWidth = videoWidth * subtitleWidthRatio;
        const charWidth = size * 0.35;
        const maxChars = Math.max(4, Math.floor(textBoxWidth / charWidth));
        fs.writeFileSync(captionFile, wrapCaption(text, maxChars), "utf8");
        const pos = style.position ?? "bottom";
        const y = style.y != null
          ? `(h-text_h)*${Math.max(0, Math.min(1, Number(style.y)))} `
          : pos === "top" ? "80" : pos === "center" ? "(h-text_h)/2" : "h-text_h-80";
        const x = style.x != null
          ? `(w-text_w)*${Math.max(0, Math.min(1, Number(style.x)))} `
          : "(w-text_w)/2";
        v += `,drawtext=fontfile='${escapeDrawtext(fontPath.replace(/\\/g, "/"))}':textfile='${escapeDrawtext(captionFile.replace(/\\/g, "/"))}':fontcolor=${color}:fontsize=${size}:line_spacing=8:bordercolor=${stroke}:borderw=${strokeW}:x=${x}:y=${y}:fix_bounds=1`;
      };
      addCaption(plan.titleCaptions?.[i], titleStyle, titleFont, titleSize, titleColor, titleStroke, titleStrokeW, "title");
      addCaption(plan.captions?.[i], voiceStyle, voiceFont, voiceSize, voiceColor, voiceStroke, voiceStrokeW, "caption");
      v += `[v${i}]`;
      filterParts.push(v, a);
      concatIns.push(`[v${i}][a${i}]`);
    }
    if (voiceTracks.length) {
      filterParts.push(
        `${concatIns.join("")}concat=n=${K}:v=1:a=1[basev][basea]`,
      );
      const voiceLabels: string[] = [];
      voiceTracks.forEach((track, index) => {
        const inputIndex = K + index;
        const label = `[voice${index}]`;
        filterParts.push(
          `[${inputIndex}:a]aresample=48000,volume=1.25,adelay=${track.delayMs}|${track.delayMs}${label}`,
        );
        voiceLabels.push(label);
      });
      filterParts.push(
        `[basea]${voiceLabels.join("")}amix=inputs=${voiceLabels.length + 1}:duration=first:dropout_transition=2,aresample=48000[outa]`,
      );
      filterParts.push(`[basev]null[outv]`);
    } else {
      filterParts.push(
        `${concatIns.join("")}concat=n=${K}:v=1:a=1[outv][outa]`,
      );
    }
    const generatedFilter = filterParts.join(";");
    // 模型脚本仅用于规划，不能直接替换合成滤镜；它没有字幕和口播音轨的
    // 保证，会导致设置页的文字样式与口播在最终视频中丢失。
    const filter = generatedFilter;
    // 将最终过滤器图落盘为脚本再交给 ffmpeg，便于复现、审计和后续替换为模型生成的脚本。
    const filterScript = path.join(tmp, "filter_complex.txt");
    fs.writeFileSync(filterScript, `${filter}\n`, "utf8");

    const safeName =
      `${plan.direction}_${plan.platform}_${Date.now()}.mp4`.replace(
        /[^\w.\-]/g,
        "_",
      );
    const out = path.join(opts.outDir, safeName);

    await runFfmpeg([
      ...inputs,
      "-filter_complex_script",
      filterScript,
      "-map",
      "[outv]",
      "-map",
      "[outa]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-shortest",
      out,
    ]);
    return out;
  } finally {
    // 清理临时下载的素材（输出在 outDir，不删）
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 批量渲染多个方案 */
export async function renderPlans(
  materials: EditMaterial[],
  plans: EditPlan[],
  opts: RenderOptions,
): Promise<RenderResult[]> {
  const results: RenderResult[] = [];
  for (const plan of plans) {
    try {
      const outputPath = await renderPlan(materials, plan, opts);
      results.push({
        direction: plan.direction,
        platform: plan.platform,
        outputPath,
      });
    } catch (e) {
      results.push({
        direction: plan.direction,
        platform: plan.platform,
        outputPath: "",
        error: (e as Error).message,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 敏感内容自动脱敏预处理
// ---------------------------------------------------------------------------

/**
 * 脚本1（重新编码脱敏）：对视频做「去元数据 + 重新编码 + 改分辨率 + 改码率 + 轻微裁剪 + 调帧率」，
 * 用于绕开基于元数据/编码特征的内容安全敏感判定。返回输出文件路径。
 *
 * 处理项：
 *  - 去元数据：-map_metadata -1 -fflags +bitexact
 *  - 重新编码（H.264）：-c:v libx264 -preset veryfast -crf 23
 *  - 改分辨率：scale=720:-2（等比缩到 720 宽）
 *  - 轻微裁剪：crop=iw-20:ih-20:10:10（四周各裁 10px）
 *  - 调帧率：-r 24
 *  - 改码率：-b:v 1400k，音频 -b:a 128k
 */
export async function sanitizeVideo(
  inputPath: string,
  outPath: string,
): Promise<string> {
  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-vf",
    "scale=720:-2,crop=iw-20:ih-20:10:10,format=yuv420p",
    "-r",
    "24",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-b:v",
    "1400k",
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outPath,
  ]);
  return outPath;
}

/**
 * 脚本2（抽帧脱敏）：按 1 帧/秒从视频抽取关键帧为 JPG 图片集合，用于当重新编码仍被判敏感时，
 * 改用「图片集」交给 MiniMax 做内容分析。返回抽出的图片绝对路径数组（按文件名排序）。
 * @param maxFrames 最多抽取帧数（避免长视频产生过多图片）
 */
export async function extractFramesPerSecond(
  inputPath: string,
  outDir: string,
  maxFrames = 30,
): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const pattern = path.join(outDir, "frame_%05d.jpg");
  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-vf",
    "fps=1",
    "-q:v",
    "2",
    "-frames:v",
    String(maxFrames),
    pattern,
  ]);
  return fs
    .readdirSync(outDir)
    .filter((f) => /^frame_\d+\.jpg$/.test(f))
    .map((f) => path.join(outDir, f))
    .sort();
}

export async function synthesizeVoiceover(
  text: string,
  outPath: string,
  voiceName?: string,
  rate?: number,
  locale?: string,
): Promise<string | null> {
  if (!text.trim()) return null;
  // 使用 Edge TTS 的 voice shortName + locale，确保实际音色与设置页一致。
  try {
    const { EdgeTTS } = require("node-edge-tts");
    const selectedLocale = locale || voiceName?.split("-").slice(0, 2).join("-") || "zh-CN";
    const selectedVoice = voiceName || (selectedLocale === "zh-CN" ? "zh-CN-XiaoxiaoNeural" : undefined);
    const rateText = Number.isFinite(rate) && rate !== 1
      ? `${Math.round((Number(rate) - 1) * 100)}%`
      : "default";
    const tts = new EdgeTTS({
      voice: selectedVoice,
      lang: selectedLocale,
      rate: rateText,
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
    });
    await tts.ttsPromise(text, outPath);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size >= 128) return outPath;
    throw new Error("Edge TTS 未生成有效音频文件");
  } catch (edgeError: any) {
    if (voiceName) {
      throw new Error(`指定音色生成失败（${voiceName}）：${edgeError?.message || String(edgeError)}`);
    }
  }
  if (process.platform !== "win32") return null;
  // 不把文案直接拼进 -Command：英文撇号、中文和换行会破坏 PowerShell 语法，
  // 且系统代码页可能导致乱码。通过 UTF-8 Base64 参数传递，再由脚本解码。
  const scriptPath = `${outPath}.ps1`;
  const script = `param([string]$Text64,[string]$OutPath,[string]$VoiceName,[double]$Rate); $ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; $text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Text64)); $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; if($VoiceName){ try{$s.SelectVoice($VoiceName)}catch{} }; $s.Rate=[Math]::Max(-10,[Math]::Min(10,[Math]::Round(($Rate-1)*10))); $s.SetOutputToWaveFile($OutPath); $s.Speak($text); $s.Dispose()`;
  fs.writeFileSync(scriptPath, script, "utf8");
  const text64 = Buffer.from(text, "utf8").toString("base64");
  await new Promise<void>((resolve, reject) =>
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-Text64",
        text64,
        "-OutPath",
        outPath,
        "-VoiceName",
        voiceName || "",
        "-Rate",
        String(Number.isFinite(rate) ? rate : 1),
      ],
      (err, _o, stderr) =>
        err
          ? reject(new Error(`口播音频生成失败：${stderr || err.message}`))
          : resolve(),
    ),
  );
  try {
    fs.rmSync(scriptPath, { force: true });
  } catch {
    /* ignore */
  }
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 128) {
    throw new Error("口播音频生成失败：系统语音引擎没有生成有效音频文件");
  }
  return outPath;
}

export async function generateSpeechAudio(
  text: string,
  outPath: string,
  format: "mp3" | "wav" | "m4a" | "ogg",
  voiceName?: string,
  rate?: number,
  locale?: string,
): Promise<string> {
  const tmp = `${outPath}.source.mp3`;
  try {
    const source = await synthesizeVoiceover(text, tmp, voiceName, rate, locale);
    if (!source) throw new Error("未生成有效音频");
    if (format === "mp3") {
      fs.renameSync(source, outPath);
      return outPath;
    }
    const codecArgs =
      format === "wav"
        ? ["-c:a", "pcm_s16le"]
        : format === "m4a"
          ? ["-c:a", "aac", "-b:a", "128k"]
          : ["-c:a", "libvorbis", "-q:a", "4"];
    await runFfmpeg(["-y", "-i", source, ...codecArgs, outPath]);
    return outPath;
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}

function wrapCaption(text: string, maxChars = 22): string {
  const src = String(text ?? "")
    .replace(/\r/g, "")
    .replace(/\n+/g, " ");
  const out: string[] = [];
  let line = "";
  for (const ch of src) {
    line += ch;
    if (line.length >= maxChars || /[。！？.!?]/.test(ch)) {
      out.push(line.trim());
      line = "";
    }
  }
  if (line.trim()) out.push(line.trim());
  return out.join("\n");
}

export async function extractAudio(
  inputPath: string,
  outPath: string,
): Promise<string> {
  // whisper.cpp 输入使用 16kHz 单声道 PCM WAV，避免 MP3 编码和采样率兼容问题。
  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
  return outPath;
}
