// MiniMax-M3 大模型客户端（OpenAI 兼容 Chat Completions）
// 设计：本文件只提供「底层调用能力」，具体业务 Prompt 与字段解析放在 src/analysis/ai-tasks.ts，
// 严格对应《技术落地文档》中各模块的 Prompt 模板。
import { AppConfig } from "../shared/types";
import {
  EditMaterial,
  EditPlan,
  EditGenerationOptions,
} from "../analysis/ai-edit";
import { trace } from "../shared/trace";

const DEFAULT_BASE_URL = "https://api.new.bi/v1";

// 全局语言约束：在所有业务提示的 system 末尾追加，确保「全流程输出中文」
// （即使输入为英文，模型最终回复与 JSON 内文本字段也都使用简体中文）。
const LANGUAGE_DIRECTIVE = `\n\n【语言约束】全程使用简体中文进行思考与回复：即使输入内容包含英文，你的最终输出也必须使用简体中文；当要求输出 JSON 时，JSON 内的文本字段（如标题、描述、标签、理由等）同样使用中文。`;
function withLang(system: string): string {
  return system + LANGUAGE_DIRECTIVE;
}

/** 等待指定毫秒 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 判断是否为「可重试的瞬时错误」：网络层失败（-1）或服务暂时不可用（502/503/529） */
const isTransientStatus = (s: number) =>
  s === -1 || s === 502 || s === 503 || s === 529;

/**
 * 带「网络层重试」的 fetch：仅当 fetch 本身抛异常（连接重置/ENOTFOUND/超时/证书错误等）时重试，
 * HTTP 非 2xx 响应（由调用方按 status 决定是否重试）不在此重试。
 * 主动取消（AbortError）立即抛出，不重试。用于消除 MiniMax 偶发 "fetch failed" 透传给用户。
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  retries = 1,
): Promise<Response> {
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    try {
      return await fetch(url, init);
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      lastErr = e;
      if (i < retries) await sleep(600 * (i + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// 持有 AppConfig 引用、调用时实时读取，使「设置」页修改 LLM 配置后立即生效（无需重启）。
export class MiniMaxClient {
  private config: AppConfig;
  /** 流式输出回调：在主进程被置为「把 token 实时推给渲染进程」，未设置则走普通一次性返回 */
  private onToken?: (text: string) => void;
  /** 取消信号：用户在工作流弹窗点「取消」时 abort，进行中的请求（chat/upload）会被中断 */
  private signal?: AbortSignal;

  constructor(
    config: AppConfig,
    opts?: { onToken?: (text: string) => void; signal?: AbortSignal },
  ) {
    this.config = config;
    this.onToken = opts?.onToken;
    this.signal = opts?.signal;
  }

  /** 是否已被用户取消（降级链各步骤之间可据此快速跳过） */
  get aborted(): boolean {
    return this.signal?.aborted ?? false;
  }

  private get apiKey(): string {
    return (this.config.llmApiKey ?? "").trim();
  }

  get baseUrl(): string {
    return (this.config.llmBaseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  get model(): string {
    return this.config.llmModel || "gemini-3.1-pro-preview";
  }

  private endpointFor(path: string, fallback: string): string {
    const value = (path || fallback).trim();
    if (/^https?:\/\//i.test(value)) return value;
    return `${this.baseUrl}/${value.replace(/^\/+/, "")}`;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * 统一的「对话 + 解析 JSON」能力（兼容旧调用：单视频直链）。
   * @param system 系统提示（业务规则 / JSON schema 要求）
   * @param userText 用户输入（业务数据）
   * @param mediaUrl 可选：可直链的视频地址（https 直链或 mm_file:// 引用），作为 video_url 多模态输入
   * @returns 解析后的 JSON 对象；解析失败时返回 { _raw: string }
   *
   * 容错分层（应对 MiniMax 视频理解两类典型失败）：
   *   1) 视频被判定敏感(422 sensitive) / 直链不可达(500) → 去掉视频，改用纯文本重试；
   *   2) 纯文本仍被敏感拦截 → 再尝试「精简文本」（去掉 URL、仅保留标题/标签元数据）；
   *   3) 仍失败 → 抛出清晰、可操作的中文错误，不再把原始英文报错直接暴露给用户。
   */
  async chatJson(
    system: string,
    userText: string,
    mediaUrl?: string,
  ): Promise<any> {
    const items = mediaUrl ? [{ type: "video" as const, url: mediaUrl }] : [];
    return this.chatJsonMedia(system, userText, items);
  }

  /**
   * 与 chatJson 等价，但支持「多个混合媒体」（视频 + 图片），用于抽帧图片集分析等场景。
   */
  async chatJsonMedia(
    system: string,
    userText: string,
    mediaItems: { type: "video" | "image" | "audio"; url: string }[] = [],
  ): Promise<any> {
    if (!this.apiKey) {
      throw new Error("未配置 LLM API Key，无法调用大模型");
    }
    const core = await this.requestCore(system, userText, mediaItems);
    if (!core.ok) {
      if (core.sensitive) {
        throw new Error(
          "该视频/文案被模型内容安全策略判定为敏感，已自动尝试「纯文本」「精简文本」仍被拦截，无法生成 AI 分析。" +
            "可尝试：① 在设置中更换为内容限制更宽松的模型；② 只基于标题/标签人工分析；③ 跳过该条视频。",
        );
      }
      throw new Error(
        `视频解析大模型 API 调用失败 (${core.status}): ${core.raw.slice(0, 300)}`,
      );
    }
    return parseJson(core.text);
  }

  /**
   * 带「敏感信号」的安全调用：不抛异常，返回 { ok, sensitive?, error?, data? }，
   * 供「敏感内容自动脱敏恢复」流程判断是否需要进入 ffmpeg 预处理分支。
   */
  async chatJsonSafe(
    system: string,
    userText: string,
    mediaItems: { type: "video" | "image" | "audio"; url: string }[] = [],
  ): Promise<{ ok: boolean; sensitive?: boolean; error?: string; data?: any }> {
    try {
      const data = await this.chatJsonMedia(system, userText, mediaItems);
      return { ok: true, data };
    } catch (e: any) {
      const m = e?.message ?? String(e);
      if (m.includes("敏感")) return { ok: false, sensitive: true };
      return { ok: false, error: m };
    }
  }

  /**
   * 严格敏感检测：仅做「单次多模态尝试」，**不**降级为纯文本/精简文本。
   * 用于 AI 剪辑流程——当视频被判定敏感或媒体不可达(500)时，必须由外层
   * 「敏感内容自动脱敏恢复」走 ffmpeg 重编码/抽帧降级，而不是悄悄丢掉视频，
   * 因此这里要原样返回 sensitive/error 信号（不掩盖）。
   */
  async chatJsonStrictSafe(
    system: string,
    userText: string,
    mediaItems: { type: "video" | "image" | "audio"; url: string }[] = [],
  ): Promise<{ ok: boolean; sensitive?: boolean; error?: string; data?: any }> {
    const core = await this.requestCore(system, userText, mediaItems, true);
    if (core.ok) return { ok: true, data: parseJson(core.text) };
    if (core.sensitive) return { ok: false, sensitive: true };
    return {
      ok: false,
      error: `视频解析大模型 API 调用失败 (${core.status}): ${core.raw.slice(0, 300)}`,
    };
  }

  /**
   * 核心请求编排：组装多模态内容（视频/图片），默认按「带媒体 → 纯文本 → 精简文本」三次降级重试。
   * 返回归一化结果 { ok, sensitive, status, text }，不直接抛错（由上层决定抛或返回信号）。
   * @param noFallback 严格模式：仅做首次请求，不降级（供 chatJsonStrictSafe 使用）。
   */
  private async requestCore(
    system: string,
    userText: string,
    mediaItems: { type: "video" | "image" | "audio"; url: string }[],
    noFallback = false,
  ): Promise<{
    ok: boolean;
    sensitive: boolean;
    status: number;
    text: string;
    raw: string;
  }> {
    // 仅保留可直链的媒体：图片需 https；视频需 https 或 mm_file:// 引用
    const attach = mediaItems.filter(
      (m) =>
        m?.url &&
        (m.type === "image"
          ? /^https?:\/\//.test(m.url) || /^data:image\//i.test(m.url)
          : /^https?:\/\//.test(m.url) || m.url.startsWith("mm_file://")),
    );
    const hasVideo = attach.some((m) => m.type === "video");

    const buildBody = (media: typeof attach | null, text: string) => {
      const content: any[] = [{ type: "text", text }];
      // MiniMax 多模态：video_url 用于视频，image_url 用于图片（抽帧/图文分析）。
      // TikTok/Instagram 直链多为签名短链、地域/防盗链限制，服务端常拉取失败（500/422 sensitive），
      // 调用失败会自动去掉媒体改用纯文本重试。
      if (media) {
        for (const m of media) {
          if (m.type === "video")
            content.push({
              type: "video_url",
              video_url: { url: m.url, detail: "default" },
            });
          else if (m.type === "audio")
            content.push({ type: "audio_url", audio_url: { url: m.url } });
          else
            content.push({
              type: "image_url",
              image_url: { url: m.url, detail: "default" },
            });
        }
      }
      return {
        model: this.model,
        messages: [
          { role: "system", content: withLang(system) },
          { role: "user", content },
        ],
        response_format: { type: "json_object" },
        // 输出上限：模型一次性返回多个方案/详细拆解内容较长，6000 易被截断导致 JSON 不完整，放宽到 8000
        max_completion_tokens: 8000,
        temperature: 0.4,
      };
    };

    const endpoint = `${this.baseUrl}/chat/completions`;
    const meta = { system, userText, model: this.model, endpoint };
    const isSensitive = (r: { status: number; raw: string }) =>
      r.status === 422 && /(sensitive|敏感)/i.test(r.raw);

    // 第一次尝试（带媒体）
    let result = await this.requestJson(
      endpoint,
      buildBody(attach.length ? attach : null, userText),
      { ...meta, isMultimodal: attach.length > 0 },
      "视频解析大模型推理",
    );
    // 严格模式：仅一次请求，不降级（由外层脱敏恢复流程接管）
    if (noFallback) {
      return {
        ok: result.ok,
        sensitive: isSensitive(result),
        status: result.status,
        text: result.text,
        raw: result.raw,
      };
    }
    // 第二次：去掉媒体，用纯文本（去掉 URL，避免链接误触发审核）
    if (!result.ok && hasVideo) {
      const textOnly = await this.requestJson(
        endpoint,
        buildBody(null, stripUrls(userText)),
        { ...meta, isMultimodal: false },
        "视频解析大模型推理（媒体不可达/敏感，已改用纯文本分析）",
      );
      if (textOnly.ok) result = textOnly;
    }
    // 第三次：纯文本仍被敏感拦截 → 精简文本（仅保留前 300 字、去掉 URL），尽量绕过审核
    if (!result.ok && isSensitive(result)) {
      const minimal = await this.requestJson(
        endpoint,
        buildBody(null, minimizeText(userText)),
        { ...meta, isMultimodal: false },
        "视频解析大模型推理（文本仍被拦截，已精简文本重试）",
      );
      if (minimal.ok) result = minimal;
    }
    return {
      ok: result.ok,
      sensitive: isSensitive(result),
      status: result.status,
      text: result.text,
      raw: result.raw,
    };
  }

  /**
   * 将本地/临时直链视频上传到 MiniMax 文件服务，返回可在对话中引用的 mm_file:// 引用。
   * 用于解决「TiKhub 临时直链 MiniMax 拉取不到（下载失败/500）」的问题：
   * 先把视频下载到本进程内存，再上传到 MiniMax（purpose=video_understanding），拿到的 file_id 永久有效 7 天，
   * 之后把视频库记录的 mediaUrl 切换为该 mm_file:// 引用即可稳定做多模态理解。
   */
  async uploadVideo(bytes: Buffer, filename: string): Promise<string> {
    return this.uploadFile(
      bytes,
      filename || "video.mp4",
      "video_understanding",
      "video/mp4",
    );
  }

  /** 上传图片（抽帧脱敏场景），返回 mm_file:// 引用，供 image_url 多模态输入使用。 */
  async uploadImage(bytes: Buffer, filename: string): Promise<string> {
    return this.uploadFile(
      bytes,
      filename || "frame.jpg",
      "image_understanding",
      "image/jpeg",
    );
  }

  /** 通用文件上传：MiniMax files/upload，purpose 区分 video/image understanding。 */
  private async uploadFile(
    bytes: Buffer,
    filename: string,
    purpose: string,
    mime: string,
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error("未配置视频解析大模型 API Key，无法上传文件");
    }
    const endpoint = this.endpointFor(
      this.config.llmFileUploadPath,
      "/files/upload",
    );
    const form = new FormData();
    form.append("purpose", purpose);
    form.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: mime }),
      filename,
    );
    // 网络层重试，避免偶发 "fetch failed" 导致上传失败
    const res = await fetchWithRetry(
      endpoint,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: this.signal,
      },
      this.signal,
    );
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data?.base_resp?.status_code !== 0 || !data?.file?.file_id) {
      throw new Error(
        `视频解析大模型文件上传失败 (${res.status}): ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    return `mm_file://${data.file.file_id}`;
  }

  /**
   * 实际发起请求。若 this.onToken 已设置则走 SSE 流式，边收边回调；否则一次性返回。
   * 返回 { ok, status, text }，并在结束时写一条 trace（供前端「处理流程」展示）。
   */
  private async requestJson(
    endpoint: string,
    body: any,
    meta: {
      system: string;
      userText: string;
      isMultimodal: boolean;
      model: string;
    },
    title: string,
  ): Promise<{ ok: boolean; status: number; text: string; raw: string }> {
    const start = Date.now();
    const useStream = !!this.onToken;
    const payload = useStream ? { ...body, stream: true } : body;
    let status = -1;
    let ok = false;
    let text = "";
    let raw = "";
    try {
      // 单次请求：网络层异常由 fetchWithRetry 已重试一次；此处再对「服务暂时不可用（502/503/529）」
      // 与「网络层失败（status -1）」做外层重试，消除 MiniMax 偶发 "fetch failed" 透传给用户。
      // 主动取消（AbortError）不重试。
      const attempt = (): Promise<Response> =>
        fetchWithRetry(
          endpoint,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            signal: this.signal,
          },
          this.signal,
        );
      let res: Response;
      try {
        res = await attempt();
        // 对瞬时错误再重试一次（带退避）
        for (
          let i = 0;
          i < 1 && isTransientStatus(res.status) && !this.signal?.aborted;
          i++
        ) {
          await sleep(700 * (i + 1));
          res = await attempt();
        }
      } catch (e: any) {
        // 网络层彻底失败（fetchWithRetry 已重试）：统一为 status -1，不抛异常（由上层决定是否降级/抛错）
        return {
          ok: false,
          status: -1,
          text: "",
          raw: e?.message ?? String(e),
        };
      }
      status = res.status;
      ok = res.ok;
      if (!ok) {
        raw = await res.text();
        text = raw;
        return { ok, status, text, raw };
      }
      if (useStream && this.onToken) {
        text = await readSSE(res, this.onToken);
      } else {
        const data: any = await res.json();
        const content =
          data?.choices?.[0]?.message?.content ??
          data?.choices?.[0]?.text ??
          "";
        if (typeof content === "string") text = content;
        else if (Array.isArray(content))
          text = content
            .map((part: any) =>
              typeof part === "string" ? part : (part?.text ?? ""),
            )
            .join("");
        else text = content ? JSON.stringify(content) : "";
      }
      raw = text;
      return { ok, status, text, raw };
    } finally {
      const isSensitive = status === 422 && /sensitive/i.test(raw);
      const isTextModelRequest = /图片尺寸规划器/.test(meta.system);
      trace.add({
        kind: isTextModelRequest ? "text" : "minimax",
        title: isTextModelRequest ? "文本模型推理" : title,
        endpoint,
        method: "POST",
        model: meta.model,
        params: {
          多模态输入: meta.isMultimodal,
          system提示长度: meta.system.length,
          用户输入长度: meta.userText.length,
          用户输入预览: meta.userText.slice(0, 200),
          流式输出: useStream,
        },
        status,
        ok: ok && !isSensitive,
        durationMs: Date.now() - start,
        summary: ok
          ? `模型返回约 ${text.length} 字：${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`
          : isSensitive
            ? "视频内容被 MiniMax 安全策略判定为敏感，已进入降级处理"
            : `模型调用失败（HTTP ${status === -1 ? "网络错误" : status}）`,
        error: ok ? undefined : raw.slice(0, 300),
        raw: raw.length > 4000 ? `${raw.slice(0, 4000)}\n…(已截断)` : raw,
      });
    }
  }

  /**
   * 模块七：基于真实素材（视频直链做画面理解，或元数据做语义分析）生成分平台、分方向的成片剪辑方案。
   * 必须配置 LLM_API_KEY，否则抛错。
   */
  async generateEditPlans(
    materials: EditMaterial[],
    options: EditGenerationOptions = {},
  ): Promise<EditPlan[]> {
    if (!this.apiKey) {
      throw new Error("未配置 LLM API Key，无法调用大模型生成剪辑方案");
    }
    if (!materials.length) {
      throw new Error("没有可用于分析的素材，请先上传本地视频素材");
    }

    const hasVideo = materials.some(
      (m) =>
        m.url && (/^https?:\/\//.test(m.url) || m.url.startsWith("mm_file://")),
    );
    const visualMedia = options.visualMedia ?? [];

    const buildBody = (withVideo: boolean) => {
      const content: any[] = [
        { type: "text", text: buildEditPrompt(materials, options) },
      ];
      // 仅对可直链的素材附带视频画面；若服务端拉取失败会自动改用纯文本重试
      if (withVideo) {
        materials.forEach((m) => {
          if (
            m.url &&
            (/^https?:\/\//.test(m.url) || m.url.startsWith("mm_file://"))
          ) {
            content.push({
              type: "video_url",
              video_url: { url: m.url, detail: "default" },
            });
          }
        });
      }
      for (const image of visualMedia) {
        if (image?.url) {
          if (image.label) content.push({ type: "text", text: image.label });
          content.push({
            type: "image_url",
            image_url: { url: image.url, detail: "low" },
          });
        }
      }
      return {
        model: this.model,
        messages: [
          { role: "system", content: withLang(EDIT_SYSTEM_PROMPT) },
          { role: "user", content },
        ],
        response_format: { type: "json_object" },
        // 脚本模式只需要返回每个分镜的源时间区间，避免生成完整平台分析导致等待过久。
        max_completion_tokens: options.scriptSegments?.length ? 3000 : 8000,
        temperature: 0.5,
      };
    };

    const endpoint = `${this.baseUrl}/chat/completions`;
    const userText = buildEditPrompt(materials, options);
    let result = await this.requestJson(
      endpoint,
      buildBody(hasVideo || visualMedia.length > 0),
      {
        system: EDIT_SYSTEM_PROMPT,
        userText,
        isMultimodal: hasVideo || visualMedia.length > 0,
        model: this.model,
      },
      "视频解析大模型生成剪辑方案",
    );
    // 脚本模式的源时间区间必须建立在画面分析上，禁止视觉输入失败后用纯文本猜测时间。
    if (
      !result.ok &&
      (hasVideo || visualMedia.length > 0) &&
      !options.scriptSegments?.length
    ) {
      const textOnly = await this.requestJson(
        endpoint,
        buildBody(false),
        {
          system: EDIT_SYSTEM_PROMPT,
          userText,
          isMultimodal: false,
          model: this.model,
        },
        "视频解析大模型生成剪辑方案（视频不可达，已改用纯文本）",
      );
      if (textOnly.ok) result = textOnly;
    }
    if (!result.ok) {
      throw new Error(
        `视频解析大模型 API 调用失败 (${result.status}): ${result.raw.slice(0, 300)}`,
      );
    }
    const parsed = parseEditPlans(result.text, materials);
    // 页面需要固定展示五个平台 Hook；模型偶尔漏返回平台时，用已有方案补齐平台项（仅 Hook 展示，渲染仍只取一个底片）。
    const platforms: EditPlan["platform"][] = [
      "tiktok",
      "instagram",
      "youtube",
      "xiaohongshu",
      "wechat_channels",
    ];
    if (parsed.length) {
      const byPlatform = new Map(parsed.map((p) => [p.platform, p]));
      const seed = parsed[0];
      for (const platform of platforms) {
        if (!byPlatform.has(platform))
          parsed.push({
            ...seed,
            platform,
            hook: seed.hook || `${platform} 开场 Hook`,
          });
      }
    }
    return parsed;
  }

  /**
   * 敏感感知的剪辑方案生成：成功返回 plans；敏感/失败返回信号，由「敏感内容自动脱敏恢复」流程接管。
   * 与 generateEditPlans 的区别：本方法用 chatJsonStrictSafe（不降级为纯文本），
   * 保证视频被判敏感时能准确拿到 sensitive 信号，从而进入 ffmpeg 脱敏分支。
   * @param mediaOverride 脱敏恢复流程传入的「替代媒体」（如重新编码后的 mm_file:// 或抽帧图片集）
   */
  async generateEditPlansSafe(
    materials: EditMaterial[],
    options: EditGenerationOptions = {},
    mediaOverride?: { type: "video" | "image"; url: string }[],
  ): Promise<{
    ok: boolean;
    sensitive?: boolean;
    error?: string;
    data?: EditPlan[];
  }> {
    const mediaItems =
      mediaOverride ??
      materials
        .filter(
          (m) =>
            m.url &&
            (/^https?:\/\//.test(m.url) || m.url.startsWith("mm_file://")),
        )
        .map((m) => ({ type: "video" as const, url: m.url! }));
    const prompt = buildEditPrompt(materials, options);
    const r = await this.chatJsonStrictSafe(
      EDIT_SYSTEM_PROMPT,
      prompt,
      mediaItems,
    );
    if (!r.ok) return { ok: false, sensitive: r.sensitive, error: r.error };
    return { ok: true, data: normalizeEditPlans(r.data, materials) };
  }
}

/**
 * 把 chatJsonStrictSafe 返回的任意结构安全地标准化为 EditPlan[]：
 * 兼容 { plans: [...] } / 纯数组 / { _raw } 兜底三种情况，避免因结构偏差导致页面拿不到方案。
 */
function normalizeEditPlans(raw: any, materials: EditMaterial[]): EditPlan[] {
  if (!raw) return [];
  if (Array.isArray(raw))
    return parseEditPlans(JSON.stringify({ plans: raw }), materials);
  if (raw && Array.isArray(raw.plans))
    return parseEditPlans(JSON.stringify(raw), materials);
  // _raw 或其它异常结构：直接按原文（或序列化后的文本）重新提取
  return parseEditPlans(
    typeof raw === "string" ? raw : JSON.stringify(raw),
    materials,
  );
}

/** 从文本中去掉 http(s) 链接，避免把长串直链塞进 prompt（既省 token 也规避审核误触发） */
function stripUrls(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** 精简文本：仅保留前 300 字并去掉 URL，作为敏感拦截时的最后兜底输入 */
function minimizeText(text: string): string {
  const t = stripUrls(text);
  return `仅基于以下标题与标签做客观分析，不要复述原文或描述画面：\n${t.slice(0, 300)}`;
}

/** 从模型返回中提取第一个 JSON 对象；失败返回 { _raw } */
export function parseJson(text: string): any {
  if (!text) return { _raw: "" };
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const json = m ? m[0] : text;
    return JSON.parse(json);
  } catch {
    return { _raw: text };
  }
}

/**
 * 读取 SSE 流式响应，逐块回调 token；返回完整文本。
 * 兼容 OpenAI / MiniMax 的 `data: {json}` 行协议与 `[DONE]` 终止符。
 */
async function readSSE(
  res: Response,
  onToken: (t: string) => void,
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const delta: string = j?.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            full += delta;
            onToken(delta);
          }
        } catch {
          /* 心跳/非 JSON 行忽略 */
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  return full;
}

const EDIT_SYSTEM_PROMPT = `你是一名资深海外社媒短视频剪辑导演。你只能对用户提供的本地原始视频做“非生成式”后期编排：识别画面内容并裁剪、拼接、调速、转场、叠加字幕和用户指定的口播音频。
严禁对原素材画面进行任何 AI 改写、重绘、补帧、换脸、风格化或生成新画面；不得虚构素材中不存在的景点、人物或事件。必须先分析每个视频的景点/场景、人物、动作和精彩片段，评估清晰度、稳定性、构图和信息量，自动筛选高质量片段后再编排。
任务：基于提供的本地素材清单及用户确认的生成参数，产出适配平台和营销目标的剪辑方案。
要求：
1. 必须只输出一个 JSON 对象，不要任何额外说明文字；
2. JSON 结构固定为：{ "plans": EditPlan[] }；
3. 每个 EditPlan 字段：
   - direction: "traffic" | "seed" | "conversion"
   - platform: "tiktok" | "instagram" | "youtube" | "xiaohongshu" | "wechat_channels"
   - durationSec: number（TikTok 建议 15，Instagram 建议 30）
   - hook: string，前 3 秒抓人的开场文案
   - clips: string[]，从给定素材名中挑选素材；自由生成通常 2-4 个，脚本模式必须与分镜行数一一对应（允许只有 1 个）
   - clips: string[]，从给定素材名中挑选 2-4 个
   - clipRanges: [{ material:string, startSec:number, endSec:number }]，与 clips 一一对应的实际源素材裁剪区间；脚本模式下必须根据画面内容、景别、运镜和字幕语义，从素材完整时长中选择最佳片段。这里的 startSec/endSec 是源素材时间，不是脚本时间轴位置，严禁直接复制脚本行时间；endSec-startSec 必须等于该行目标时长（允许 ±0.5 秒）
   - captions: string[]，字幕/口播文案（与 clips 数量对应）
   - voiceoverSegments: [{text,startSec,endSec}]，自由生成且有口播时，必须将完整口播文案拆成多个片段，均匀分布在 0~目标时长内，片段之间不得重叠；不要只返回整段文案。
   - transitions: string，转场与节奏说明
   - note: string，整体规划说明
   - ffmpegScript: string，必须输出可执行的 filter_complex 脚本（仅过滤器表达式，不含命令行参数；只允许引用 [N:v]/[N:a] 输入标签，并产出 [outv][outa]）；脚本只能使用裁剪、拼接、缩放、字幕、音量/混音等 FFmpeg 滤镜，不得调用任何生成式处理
   - analysis: [{ material:string, scenes:string[], people:string[], highlights:string[], quality:string }]，逐条说明识别到的景点/人物/精彩片段及质量依据，不得臆测
4. 用户指定 direction 时只输出该方向，否则输出流量型、种草型、转化型；每个方向必须覆盖 TikTok、Instagram、YouTube、小红书、视频号（共 5 个平台）；clips 必须引用素材清单里真实存在的素材名；
5. 口播参数 includeVoiceover=true 时，必须使用用户提供的 voiceoverText 作为 captions/音频说明，不得自行改写核心内容；false 时不得添加口播音频；
6. 严格遵守用户指定的目标时长 durationSec（允许 ±1 秒）；方案要具体、可落地，结合真实画面内容，避免空话。`;

export function buildEditPrompt(
  materials: EditMaterial[],
  options: EditGenerationOptions = {},
): string {
  const list = materials
    .map((m, i) => {
      const media =
        m.url && (/^https?:\/\//.test(m.url) || m.url.startsWith("mm_file://"))
          ? "（已附视频，可结合画面）"
          : "（将通过本地抽帧分析画面）";
      return `素材${i + 1}：名称=${m.name}${media}
  标题：${m.title || "无"}｜文案：${m.caption || "无"}｜标签：${(m.tags ?? []).join(" / ") || "无"}｜平台：${m.platform || "未指定"}｜时长：${m.durationSec ?? "未知"}s`;
    })
    .join("\n");
  const direction = options.direction
    ? `指定生成类型：${options.direction}（仅输出该类型）。`
    : "未指定生成类型，请覆盖流量型、种草型、转化型。";
  const voice = options.includeVoiceover
    ? `需要添加口播音频。口播文案如下，请原样保留核心信息：${options.voiceoverText || "（未提供，请返回参数错误）"}`
    : "不需要口播音频，不得在脚本中添加旁白。";
  const duration = options.durationSec
    ? `目标成片时长：${options.durationSec} 秒（允许 ±1 秒）。`
    : "目标成片时长由平台建议值决定。";
  const videoType = options.videoType
    ? `目标视频画布：${options.videoType === "portrait" ? "竖屏 9:16" : "横屏 16:9"}。`
    : "目标视频画布按平台常用比例决定。";
  const script = options.scriptSegments?.length
    ? `脚本编辑时间轴（严格按行遵循；时间轴区间仅表示成片中的目标位置和目标时长，不是源素材裁剪时间）：\n${options.scriptSegments.map((s, i) => { const targetDuration = Math.max(0, Number(s.endSec) - Number(s.startSec)); return `${i + 1}. 目标位置=${s.startSec}-${s.endSec}s（目标时长=${targetDuration.toFixed(2)}s），素材=${s.material}，景别=${s.shot || "未指定"}，运镜=${s.camera || "未指定"}，标题字幕=${s.title || "无"}，口播字幕=${s.caption || "无"}，原音频=${s.preserveAudio ? "保留" : "不保留"}`; }).join("\n")}\n对每行先分析绑定素材的完整画面，再在该素材中返回最佳源区间。即使只有字幕也必须按字幕语义选画面。每行必须在结果 clipRanges 中返回 material/startSec/endSec，区间长度等于该行目标时长；不要默认从 0 秒开始，也不要复用目标位置数字作为源时间。`
    : "未提供固定时间轴，请根据素材自由编排。";
  return `下面是待剪辑的本地旅游素材清单（共 ${materials.length} 个）：\n\n${list}\n\n${direction}\n${voice}\n${duration}\n${videoType}\n${script}\n请先输出 analysis 对每条素材做客观识别，再按系统要求输出成片剪辑方案（JSON）。每个方案的 ffmpegScript 必须是可执行的 filter_complex 内容，输入标签只能使用实际素材序号 [0:v]...[${Math.max(0, materials.length - 1)}:v] / [0:a]...[${Math.max(0, materials.length - 1)}:a]，并以 [outv][outa] 作为最终输出。脚本模式下 clips 与 clipRanges 必须一一对应，clipRanges 是实际源素材裁剪区间；长素材必须先分析后选择匹配语义的最佳片段，而不是固定截取开头。`;
}

export function parseEditPlans(
  text: string,
  materials: EditMaterial[],
): EditPlan[] {
  if (!text) return [];
  const obj = extractPlansJson(text);
  if (!obj) return [];
  const plans = Array.isArray(obj.plans) ? obj.plans : [];
  if (!plans.length) return [];
  return plans
    .map(
      (p: any): EditPlan => {
        const clipRanges = parseClipRanges(p.clipRanges ?? p.clip_ranges, materials);
        const clips = Array.isArray(p.clips) ? resolveClips(p.clips, materials) : [];
        const resolvedClips = clips.length ? clips : (clipRanges ?? []).map((r) => r.material);
        const voiceoverSegments = Array.isArray(p.voiceoverSegments ?? p.voiceover_segments)
          ? (p.voiceoverSegments ?? p.voiceover_segments).map((s: any) => ({ text: String(s.text ?? s.caption ?? ""), startSec: Number(s.startSec ?? s.start ?? 0), endSec: Number(s.endSec ?? s.end ?? 0) })).filter((s: any) => s.text && s.endSec > s.startSec)
          : undefined;
        return {
        direction: ["traffic", "seed", "conversion"].includes(p.direction)
          ? p.direction
          : "traffic",
        platform: [
          "tiktok",
          "instagram",
          "youtube",
          "xiaohongshu",
          "wechat_channels",
        ].includes(p.platform)
          ? p.platform
          : "tiktok",
        durationSec: Number(p.durationSec) || 15,
        hook: typeof p.hook === "string" ? p.hook : "",
        clips: resolvedClips,
        clipRanges,
        captions: Array.isArray(p.captions) ? p.captions.map(String) : [],
        titleCaptions: Array.isArray(p.titleCaptions ?? p.title_captions)
          ? (p.titleCaptions ?? p.title_captions).map(String)
          : undefined,
        voiceoverSegments,
        transitions: typeof p.transitions === "string" ? p.transitions : "",
        note: typeof p.note === "string" ? p.note : "",
        ffmpegScript:
          typeof (p.ffmpegScript ?? p.ffmpeg_script) === "string"
            ? String(p.ffmpegScript ?? p.ffmpeg_script)
            : undefined,
        };
      },
    )
    .filter(
      (p: EditPlan) =>
        p.hook ||
        p.clips.length ||
        p.note ||
        (p.captions && p.captions.length) ||
        p.transitions,
    );
}

/** 将模型返回的源素材裁剪区间标准化；脚本时间轴位置不会被当作源时间使用。 */
function parseClipRanges(
  raw: any,
  materials: EditMaterial[],
): EditPlan["clipRanges"] {
  if (!Array.isArray(raw)) return undefined;
  const ranges: NonNullable<EditPlan["clipRanges"]> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const materialRaw = item.material ?? item.materialName ?? item.clip;
    const material = resolveClips([materialRaw], materials)[0];
    const startSec = Number(
      item.startSec ?? item.start ?? item.sourceStartSec ?? item.sourceStart,
    );
    const rawEndSec = Number(
      item.endSec ?? item.end ?? item.sourceEndSec ?? item.sourceEnd,
    );
    const materialInfo = materials.find((m) => m.name === material);
    const endSec = Number.isFinite(materialInfo?.durationSec)
      ? Math.min(rawEndSec, Number(materialInfo?.durationSec))
      : rawEndSec;
    if (!material || !Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
    if (startSec < 0 || endSec <= startSec) continue;
    ranges.push({ material, startSec, endSec });
  }
  return ranges.length ? ranges : undefined;
}

/** 从模型返回中提取 {plans:[...]} 对象：先剥离 <think> 推理块，再稳健定位 JSON。 */
function extractPlansJson(text: string): any {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const candidates: string[] = [cleaned];
  // 从文本中提取所有平衡的 JSON 对象/数组，兼容 Markdown、前后解释文字及嵌套对象。
  for (let start = 0; start < cleaned.length; start++) {
    if (cleaned[start] !== "{" && cleaned[start] !== "[") continue;
    const open = cleaned[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        candidates.push(cleaned.slice(start, i + 1));
        break;
      }
    }
  }
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (Array.isArray(parsed)) return { plans: parsed };
      if (parsed && Array.isArray(parsed.plans)) return parsed;
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return null;
}

/**
 * 将模型给出的 clips 解析为素材名数组。模型可能返回：
 *  - 素材全名（与 materials[i].name 一致）；
 *  - 1-based 序号（数字或「素材N」「材料N」）；
 *  - 部分片段名（用 includes 模糊匹配）；
 * 任一可解析成素材名的都保留，便于 ffmpeg 渲染阶段按名定位真实素材。
 */
function resolveClips(raw: any[], materials: EditMaterial[]): string[] {
  const byName = new Map(materials.map((m) => [m.name, m.name]));
  const out: string[] = [];
  for (const c of raw) {
    if (c == null) continue;
    const s = String(c).trim();
    if (!s) continue;
    // 1-based 序号
    const idxMatch = s.match(/^(?:素材|材料)?\s*(\d+)\s*$/);
    if (idxMatch) {
      const m = materials[Number(idxMatch[1]) - 1];
      if (m) {
        out.push(m.name);
        continue;
      }
    }
    if (byName.has(s)) {
      out.push(s);
      continue;
    }
    // 模糊匹配
    const hit = materials.find(
      (mm) => mm.name.includes(s) || s.includes(mm.name),
    );
    if (hit) out.push(hit.name);
  }
  return out;
}
