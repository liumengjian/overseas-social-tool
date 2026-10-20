// yt-dlp 集成：把「作品网页链接」解析为「可直接播放/下载的视频直链」。
// 用途：爆款视频拆解使用在线链接时，先用它把视频爬取出来拿到 mediaUrl，
// 后续分析与「视频库中已带直链的视频」完全一致。
// yt-dlp 为单文件可执行程序（https://github.com/yt-dlp/yt-dlp），默认从 PATH 查找，
// 也可通过配置（YTDLP_PATH）指定完整路径。解析失败时调用方应回退原有链路。
import { spawn } from "child_process";
import { existsSync, unlinkSync } from "fs";

export interface YtDlpResult {
  mediaUrl?: string;
  title?: string;
  thumbnail?: string;
  uploader?: string;
  error?: string;
}

/** 直接下载作品页面对应的视频文件，绕过签名 CDN 对普通 HTTP 请求的防盗链限制。 */
export function downloadWithYtDlp(
  url: string,
  outputPath: string,
  bin: string = "yt-dlp",
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      try {
        child?.kill();
      } catch {
        /* 忽略 */
      }
      finish(new Error("任务已取消"));
    };
    const inputUrl = normalizeYtDlpUrl(url);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(
        bin,
        [
          "--no-playlist",
          "--no-warnings",
          "--no-check-certificate",
          "--no-part",
          "-f",
          "bv*+ba/b",
          "--merge-output-format",
          "mp4",
          "-o",
          outputPath,
          inputUrl,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e: any) {
      finish(new Error(`无法启动 yt-dlp：${e?.message ?? String(e)}`));
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* 忽略 */
      }
      finish(new Error(`yt-dlp 下载超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e: any) => {
      clearTimeout(timer);
      finish(
        new Error(
          (e as NodeJS.ErrnoException)?.code === "ENOENT"
            ? "未找到 yt-dlp，请在设置页配置 YTDLP_PATH 或将其加入系统 PATH"
            : `yt-dlp 下载失败：${e?.message ?? String(e)}`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0 || !existsSync(outputPath)) {
        const tail = stderr
          .trim()
          .split("\n")
          .slice(-4)
          .join(" ")
          .slice(0, 500);
        try {
          if (existsSync(outputPath)) unlinkSync(outputPath);
        } catch {
          /* 忽略临时文件清理 */
        }
        finish(new Error(tail || `yt-dlp 下载失败（exit ${code}）`));
        return;
      }
      finish();
    });
  });
}

const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * 用 yt-dlp 解析在线视频链接：
 *   yt-dlp -J --no-playlist --no-warnings <url>  → 输出完整 JSON（info 含 formats / url）
 * 返回：优先取「最高清的视频格式」直链（info.url 兜底），并附标题/封面等元数据。
 * @param bin yt-dlp 可执行文件（默认 'yt-dlp'，从 PATH 查找）
 * @param signal 取消信号（工作流取消时 kill 子进程）
 */
export function resolveWithYtDlp(
  url: string,
  bin: string = "yt-dlp",
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<YtDlpResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: YtDlpResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    // Instagram 分享链接常带 utm_source/igsi 等追踪参数；yt-dlp 对这类 URL
    // 兼容性较差，保留路径即可指向同一个帖子。
    const inputUrl = normalizeYtDlpUrl(url);
    let child;
    try {
      child = spawn(
        bin,
        [
          "-J",
          "--no-playlist",
          "--no-warnings",
          "--no-check-certificate",
          inputUrl,
        ],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (e: any) {
      finish({ error: `无法启动 yt-dlp：${e?.message ?? String(e)}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* 忽略 */
      }
      finish({
        error: `yt-dlp 解析超时（${Math.round(timeoutMs / 1000)}s），请确认网络可访问该平台`,
      });
    }, timeoutMs);

    const onAbort = () => {
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        /* 忽略 */
      }
      finish({ error: "任务已取消" });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (e: any) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // ENOENT = 找不到 yt-dlp 可执行文件
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        finish({
          error:
            "未找到 yt-dlp，请在设置页配置 YTDLP_PATH 或将其加入系统 PATH（https://github.com/yt-dlp/yt-dlp）",
        });
      } else {
        finish({ error: `yt-dlp 启动失败：${e?.message ?? String(e)}` });
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      if (code !== 0) {
        const tail = stderr
          .trim()
          .split("\n")
          .slice(-3)
          .join(" ")
          .slice(0, 300);
        finish({ error: tail || `yt-dlp 解析失败（exit ${code}）` });
        return;
      }
      try {
        const info = JSON.parse(stdout);
        // 选最高清视频格式：优先含视频编码的格式，其次用 info.url 兜底
        const formats: any[] = Array.isArray(info?.formats) ? info.formats : [];
        let best: any = null;
        for (const f of formats) {
          if (!f?.url || f.vcodec === "none") continue;
          if (!best || (f.height ?? 0) > (best.height ?? 0)) best = f;
        }
        const mediaUrl = best?.url ?? info?.url;
        finish({
          mediaUrl,
          title: info?.title ?? "",
          thumbnail: info?.thumbnail ?? "",
          uploader: info?.uploader ?? info?.channel ?? "",
          error: mediaUrl ? undefined : "yt-dlp 未返回可用视频直链",
        });
      } catch (e: any) {
        finish({ error: `yt-dlp 输出解析失败：${e?.message ?? String(e)}` });
      }
    });
  });
}

function normalizeYtDlpUrl(url: string): string {
  const raw = (url ?? "").trim();
  try {
    const parsed = new URL(raw);
    if (
      /instagram\.com$/i.test(parsed.hostname) ||
      /\.instagram\.com$/i.test(parsed.hostname)
    ) {
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
  } catch {
    /* 保留原始 URL，让 yt-dlp 返回明确错误 */
  }
  return raw;
}
