import { spawn } from "child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "fs";
import { dirname, join } from "path";
import { pipeline } from "stream/promises";

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}
export interface WhisperResult {
  text: string;
  segments: WhisperSegment[];
}

function timestamp(value: unknown): number {
  if (typeof value === "number") return value > 1000 ? value / 1000 : value;
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const parts = raw.replace(",", ".").split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(raw) || 0;
}

function parseJsonOutput(raw: string): WhisperResult {
  const data: any = JSON.parse(raw);
  const rawSegments = Array.isArray(data?.segments)
    ? data.segments
    : Array.isArray(data?.transcription)
      ? data.transcription.map((s: any) => ({
          start: s?.timestamps?.from ?? s?.offsets?.from,
          end: s?.timestamps?.to ?? s?.offsets?.to,
          text: s?.text,
        }))
      : [];
  const segments = rawSegments
    .map((s: any, i: number) => ({
      start: timestamp(s?.start ?? s?.start_time ?? i * 3),
      end: timestamp(s?.end ?? s?.end_time ?? i * 3 + 3),
      text: String(s?.text ?? "").trim(),
    }))
    .filter((s: WhisperSegment) => s.text && s.end > s.start);
  const text = String(
    data?.text ?? segments.map((s: any) => s.text).join("\n"),
  ).trim();
  if (!text) throw new Error("Whisper 未识别到可用口播文案");
  return { text, segments };
}

function runFile(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: dirname(command),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        new Error(
          `Whisper 转写超时（${Math.round(timeoutMs / 60_000)} 分钟），请截取更短的视频后重试。`,
        ),
      );
    }, timeoutMs);
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) =>
      finish(new Error(`无法启动 Whisper：${error.message}`)),
    );
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = `${stderr}\n${stdout}`.trim().slice(-1600);
      finish(
        new Error(detail || `Whisper 执行失败（退出码 ${code ?? "未知"}）`),
      );
    });
    const onAbort = () => {
      child.kill();
      finish(new Error("任务已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function runPythonWhisper(
  audioPath: string,
  outputDir: string,
  signal?: AbortSignal,
): Promise<WhisperResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "python",
      [
        "-m",
        "whisper",
        audioPath,
        "--model",
        "base",
        "--output_format",
        "json",
        "--output_dir",
        outputDir,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    const onAbort = () => {
      child.kill();
      reject(new Error("任务已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => {
      signal?.removeEventListener("abort", onAbort);
      reject(
        new Error(
          "未找到本地 Whisper，请将 Whisper 放入 resources/whisper 或安装 openai-whisper",
        ),
      );
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code !== 0) {
        reject(new Error(stderr.trim().slice(-800) || "本地 Whisper 执行失败"));
        return;
      }
      try {
        resolve(
          parseJsonOutput(
            readFileSync(
              join(
                outputDir,
                `${audioPath
                  .replace(/\\/g, "/")
                  .split("/")
                  .pop()!
                  .replace(/\.[^.]+$/, "")}.json`,
              ),
              "utf8",
            ),
          ),
        );
      } catch {
        reject(new Error("Whisper 未生成有效转写结果"));
      }
    });
  });
}

/** 使用项目内置 whisper.cpp；开发态/打包态均支持 resources/whisper 目录。 */
async function ensureModel(
  modelPath: string,
  modelUrl: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (existsSync(modelPath)) return;
  if (!modelUrl?.trim()) throw new Error("未配置 Whisper 模型下载地址");
  mkdirSync(dirname(modelPath), { recursive: true });
  const tempPath = `${modelPath}.download`;
  try {
    const response = await fetch(modelUrl, { signal });
    if (!response.ok || !response.body)
      throw new Error(`HTTP ${response.status}`);
    await pipeline(response.body, createWriteStream(tempPath));
    renameSync(tempPath, modelPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* 部分下载文件清理失败不影响原始错误 */
    }
    throw new Error(
      `下载 Whisper 模型失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function transcribeLocally(
  audioPath: string,
  resourceRoot: string,
  modelCacheRoot?: string,
  modelUrl?: string,
  signal?: AbortSignal,
): Promise<WhisperResult> {
  const executable = [
    join(
      resourceRoot,
      "whisper",
      process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli",
    ),
    join(
      resourceRoot,
      "whisper",
      process.platform === "win32" ? "main.exe" : "main",
    ),
  ].find((p) => existsSync(p));
  const bundledModel = [
    join(resourceRoot, "whisper", "models", "ggml-base.bin"),
    join(resourceRoot, "whisper", "ggml-base.bin"),
  ].find((p) => existsSync(p));
  const model =
    bundledModel ??
    join(
      modelCacheRoot ?? join(resourceRoot, "whisper"),
      "models",
      "ggml-base.bin",
    );
  if (executable && model) {
    if (!bundledModel) await ensureModel(model, modelUrl, signal);
    const prefix = audioPath.replace(/\.[^.]+$/, "");
    await runFile(
      executable,
      [
        "-m",
        model,
        "-f",
        audioPath,
        "-l",
        "auto",
        "--no-prints",
        "--output-json",
        "--output-file",
        prefix,
      ],
      900_000,
      signal,
    );
    const jsonPath = `${prefix}.json`;
    return parseJsonOutput(readFileSync(jsonPath, "utf8"));
  }
  if (process.platform === "win32") {
    try {
      return await runPythonWhisper(audioPath, dirname(audioPath), signal);
    } catch (error: any) {
      throw new Error(
        `${error?.message ?? String(error)}。请将 whisper-cli.exe 和 ggml-base.bin 放入 resources/whisper 目录`,
      );
    }
  }
  return runPythonWhisper(audioPath, dirname(audioPath), signal);
}
