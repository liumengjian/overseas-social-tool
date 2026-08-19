// MiniMax-M3 大模型客户端（OpenAI 兼容 Chat Completions）
// 设计：本文件只提供「底层调用能力」，具体业务 Prompt 与字段解析放在 src/analysis/ai-tasks.ts，
// 严格对应《技术落地文档》中各模块的 Prompt 模板。
import { AppConfig } from '../shared/types';
import { EditMaterial, EditPlan } from '../analysis/ai-edit';
import { trace } from '../shared/trace';

const DEFAULT_BASE_URL = 'https://api.minimax.io/v1';

// 全局语言约束：在所有业务提示的 system 末尾追加，确保「全流程输出中文」
// （即使输入为英文，模型最终回复与 JSON 内文本字段也都使用简体中文）。
const LANGUAGE_DIRECTIVE = `\n\n【语言约束】全程使用简体中文进行思考与回复：即使输入内容包含英文，你的最终输出也必须使用简体中文；当要求输出 JSON 时，JSON 内的文本字段（如标题、描述、标签、理由等）同样使用中文。`;
function withLang(system: string): string {
  return system + LANGUAGE_DIRECTIVE;
}

// 持有 AppConfig 引用、调用时实时读取，使「设置」页修改 LLM 配置后立即生效（无需重启）。
export class MiniMaxClient {
  private config: AppConfig;
  /** 流式输出回调：在主进程被置为「把 token 实时推给渲染进程」，未设置则走普通一次性返回 */
  private onToken?: (text: string) => void;
  /** 取消信号：用户在工作流弹窗点「取消」时 abort，进行中的请求（chat/upload）会被中断 */
  private signal?: AbortSignal;

  constructor(config: AppConfig, opts?: { onToken?: (text: string) => void; signal?: AbortSignal }) {
    this.config = config;
    this.onToken = opts?.onToken;
    this.signal = opts?.signal;
  }

  /** 是否已被用户取消（降级链各步骤之间可据此快速跳过） */
  get aborted(): boolean {
    return this.signal?.aborted ?? false;
  }

  private get apiKey(): string {
    return (this.config.llmApiKey ?? '').trim();
  }

  get baseUrl(): string {
    return (this.config.llmBaseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  get model(): string {
    return this.config.llmModel || 'MiniMax-M3';
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
  async chatJson(system: string, userText: string, mediaUrl?: string): Promise<any> {
    const items = mediaUrl ? [{ type: 'video' as const, url: mediaUrl }] : [];
    return this.chatJsonMedia(system, userText, items);
  }

  /**
   * 与 chatJson 等价，但支持「多个混合媒体」（视频 + 图片），用于抽帧图片集分析等场景。
   */
  async chatJsonMedia(
    system: string,
    userText: string,
    mediaItems: { type: 'video' | 'image'; url: string }[] = [],
  ): Promise<any> {
    if (!this.apiKey) {
      throw new Error('未配置 LLM API Key，无法调用大模型');
    }
    const core = await this.requestCore(system, userText, mediaItems);
    if (!core.ok) {
      if (core.sensitive) {
        throw new Error(
          '该视频/文案被 MiniMax 内容安全策略判定为敏感，已自动尝试「纯文本」「精简文本」仍被拦截，无法生成 AI 分析。' +
          '可尝试：① 在设置中更换为内容限制更宽松的模型；② 只基于标题/标签人工分析；③ 跳过该条视频。',
        );
      }
      throw new Error(`MiniMax API 调用失败 (${core.status}): ${core.raw.slice(0, 300)}`);
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
    mediaItems: { type: 'video' | 'image'; url: string }[] = [],
  ): Promise<{ ok: boolean; sensitive?: boolean; error?: string; data?: any }> {
    try {
      const data = await this.chatJsonMedia(system, userText, mediaItems);
      return { ok: true, data };
    } catch (e: any) {
      const m = e?.message ?? String(e);
      if (m.includes('敏感')) return { ok: false, sensitive: true };
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
    mediaItems: { type: 'video' | 'image'; url: string }[] = [],
  ): Promise<{ ok: boolean; sensitive?: boolean; error?: string; data?: any }> {
    const core = await this.requestCore(system, userText, mediaItems, true);
    if (core.ok) return { ok: true, data: parseJson(core.text) };
    if (core.sensitive) return { ok: false, sensitive: true };
    return { ok: false, error: `MiniMax API 调用失败 (${core.status}): ${core.raw.slice(0, 300)}` };
  }

  /**
   * 核心请求编排：组装多模态内容（视频/图片），默认按「带媒体 → 纯文本 → 精简文本」三次降级重试。
   * 返回归一化结果 { ok, sensitive, status, text }，不直接抛错（由上层决定抛或返回信号）。
   * @param noFallback 严格模式：仅做首次请求，不降级（供 chatJsonStrictSafe 使用）。
   */
  private async requestCore(
    system: string,
    userText: string,
    mediaItems: { type: 'video' | 'image'; url: string }[],
    noFallback = false,
  ): Promise<{ ok: boolean; sensitive: boolean; status: number; text: string; raw: string }> {
    // 仅保留可直链的媒体：图片需 https；视频需 https 或 mm_file:// 引用
    const attach = mediaItems.filter((m) =>
      m?.url && (m.type === 'image' ? /^https?:\/\//.test(m.url) : /^https?:\/\//.test(m.url) || m.url.startsWith('mm_file://')),
    );
    const hasVideo = attach.some((m) => m.type === 'video');

    const buildBody = (media: typeof attach | null, text: string) => {
      const content: any[] = [{ type: 'text', text }];
      // MiniMax 多模态：video_url 用于视频，image_url 用于图片（抽帧/图文分析）。
      // TikTok/Instagram 直链多为签名短链、地域/防盗链限制，服务端常拉取失败（500/422 sensitive），
      // 调用失败会自动去掉媒体改用纯文本重试。
      if (media) {
        for (const m of media) {
          if (m.type === 'video') content.push({ type: 'video_url', video_url: { url: m.url, detail: 'default' } });
          else content.push({ type: 'image_url', image_url: { url: m.url, detail: 'default' } });
        }
      }
      return {
        model: this.model,
        messages: [
          { role: 'system', content: withLang(system) },
          { role: 'user', content },
        ],
        response_format: { type: 'json_object' },
        // 输出上限：模型一次性返回多个方案/详细拆解内容较长，6000 易被截断导致 JSON 不完整，放宽到 8000
        max_completion_tokens: 8000,
        temperature: 0.4,
      };
    };

    const endpoint = `${this.baseUrl}/chat/completions`;
    const meta = { system, userText, model: this.model, endpoint };
    const isSensitive = (r: { status: number; raw: string }) => r.status === 422 && /(sensitive|敏感)/i.test(r.raw);

    // 第一次尝试（带媒体）
    let result = await this.requestJson(
      endpoint,
      buildBody(attach.length ? attach : null, userText),
      { ...meta, isMultimodal: attach.length > 0 },
      'MiniMax-M3 模型推理（多模态）',
    );
    // 严格模式：仅一次请求，不降级（由外层脱敏恢复流程接管）
    if (noFallback) {
      return { ok: result.ok, sensitive: isSensitive(result), status: result.status, text: result.text, raw: result.raw };
    }
    // 第二次：去掉媒体，用纯文本（去掉 URL，避免链接误触发审核）
    if (!result.ok && hasVideo) {
      const textOnly = await this.requestJson(
        endpoint,
        buildBody(null, stripUrls(userText)),
        { ...meta, isMultimodal: false },
        'MiniMax-M3 推理（媒体不可达/敏感，已改用纯文本分析）',
      );
      if (textOnly.ok) result = textOnly;
    }
    // 第三次：纯文本仍被敏感拦截 → 精简文本（仅保留前 300 字、去掉 URL），尽量绕过审核
    if (!result.ok && isSensitive(result)) {
      const minimal = await this.requestJson(
        endpoint,
        buildBody(null, minimizeText(userText)),
        { ...meta, isMultimodal: false },
        'MiniMax-M3 推理（文本仍被拦截，已精简文本重试）',
      );
      if (minimal.ok) result = minimal;
    }
    return { ok: result.ok, sensitive: isSensitive(result), status: result.status, text: result.text, raw: result.raw };
  }

  /**
   * 将本地/临时直链视频上传到 MiniMax 文件服务，返回可在对话中引用的 mm_file:// 引用。
   * 用于解决「TiKhub 临时直链 MiniMax 拉取不到（下载失败/500）」的问题：
   * 先把视频下载到本进程内存，再上传到 MiniMax（purpose=video_understanding），拿到的 file_id 永久有效 7 天，
   * 之后把视频库记录的 mediaUrl 切换为该 mm_file:// 引用即可稳定做多模态理解。
   */
  async uploadVideo(bytes: Buffer, filename: string): Promise<string> {
    return this.uploadFile(bytes, filename || 'video.mp4', 'video_understanding', 'video/mp4');
  }

  /** 上传图片（抽帧脱敏场景），返回 mm_file:// 引用，供 image_url 多模态输入使用。 */
  async uploadImage(bytes: Buffer, filename: string): Promise<string> {
    return this.uploadFile(bytes, filename || 'frame.jpg', 'image_understanding', 'image/jpeg');
  }

  /** 通用文件上传：MiniMax files/upload，purpose 区分 video/image understanding。 */
  private async uploadFile(bytes: Buffer, filename: string, purpose: string, mime: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('未配置 LLM API Key，无法上传文件到 MiniMax');
    }
    const endpoint = `${this.baseUrl}/files/upload`;
    const form = new FormData();
    form.append('purpose', purpose);
    form.append('file', new Blob([bytes], { type: mime }), filename);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: this.signal,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data?.base_resp?.status_code !== 0 || !data?.file?.file_id) {
      throw new Error(`MiniMax 文件上传失败 (${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
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
    meta: { system: string; userText: string; isMultimodal: boolean; model: string },
    title: string,
  ): Promise<{ ok: boolean; status: number; text: string; raw: string }> {
    const start = Date.now();
    const useStream = !!this.onToken;
    const payload = useStream ? { ...body, stream: true } : body;
    let status = -1;
    let ok = false;
    let text = '';
    let raw = '';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: this.signal,
      });
      status = res.status;
      ok = res.ok;
      if (!res.ok) {
        raw = await res.text();
        text = raw;
        return { ok, status, text, raw };
      }
      if (useStream && this.onToken) {
        text = await readSSE(res, this.onToken);
      } else {
        const data: any = await res.json();
        text = data?.choices?.[0]?.message?.content ?? '';
      }
      raw = text;
      return { ok, status, text, raw };
    } catch (e: any) {
      return { ok: false, status, text: '', raw: e?.message ?? String(e) };
    } finally {
      const isSensitive = status === 422 && /sensitive/i.test(raw);
      trace.add({
        kind: 'minimax',
        title,
        endpoint,
        method: 'POST',
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
          ? `模型返回约 ${text.length} 字：${text.slice(0, 160)}${text.length > 160 ? '…' : ''}`
          : isSensitive
            ? '视频内容被 MiniMax 安全策略判定为敏感，已进入降级处理'
            : `模型调用失败（HTTP ${status === -1 ? '网络错误' : status}）`,
        error: ok ? undefined : raw.slice(0, 300),
        raw: raw.length > 4000 ? `${raw.slice(0, 4000)}\n…(已截断)` : raw,
      });
    }
  }

  /**
   * 模块七：基于真实素材（视频直链做画面理解，或元数据做语义分析）生成分平台、分方向的成片剪辑方案。
   * 必须配置 LLM_API_KEY，否则抛错。
   */
  async generateEditPlans(materials: EditMaterial[]): Promise<EditPlan[]> {
    if (!this.apiKey) {
      throw new Error('未配置 LLM API Key，无法调用大模型生成剪辑方案');
    }
    if (!materials.length) {
      throw new Error('没有可用于分析的素材，请先从视频库选取或添加带链接的素材');
    }

    const hasVideo = materials.some((m) => m.url && /^https?:\/\//.test(m.url));

    const buildBody = (withVideo: boolean) => {
      const content: any[] = [{ type: 'text', text: buildEditPrompt(materials) }];
      // 仅对可直链的素材附带视频画面；若服务端拉取失败会自动改用纯文本重试
      if (withVideo) {
        materials.forEach((m) => {
          if (m.url && /^https?:\/\//.test(m.url)) {
            content.push({ type: 'video_url', video_url: { url: m.url, detail: 'default' } });
          }
        });
      }
      return {
        model: this.model,
        messages: [
          { role: 'system', content: withLang(EDIT_SYSTEM_PROMPT) },
          { role: 'user', content },
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 8000,
        temperature: 0.5,
      };
    };

    const endpoint = `${this.baseUrl}/chat/completions`;
    const userText = buildEditPrompt(materials);
    let result = await this.requestJson(
      endpoint,
      buildBody(hasVideo),
      {
        system: EDIT_SYSTEM_PROMPT,
        userText,
        isMultimodal: hasVideo,
        model: this.model,
      },
      'MiniMax-M3 生成剪辑方案',
    );
    if (!result.ok && hasVideo) {
      const textOnly = await this.requestJson(
        endpoint,
        buildBody(false),
        { system: EDIT_SYSTEM_PROMPT, userText, isMultimodal: false, model: this.model },
        'MiniMax-M3 生成剪辑方案（视频不可达，已改用纯文本）',
      );
      if (textOnly.ok) result = textOnly;
    }
    if (!result.ok) {
      throw new Error(`MiniMax API 调用失败 (${result.status}): ${result.raw.slice(0, 300)}`);
    }
    return parseEditPlans(result.text, materials);
  }

  /**
   * 敏感感知的剪辑方案生成：成功返回 plans；敏感/失败返回信号，由「敏感内容自动脱敏恢复」流程接管。
   * 与 generateEditPlans 的区别：本方法用 chatJsonStrictSafe（不降级为纯文本），
   * 保证视频被判敏感时能准确拿到 sensitive 信号，从而进入 ffmpeg 脱敏分支。
   * @param mediaOverride 脱敏恢复流程传入的「替代媒体」（如重新编码后的 mm_file:// 或抽帧图片集）
   */
  async generateEditPlansSafe(
    materials: EditMaterial[],
    mediaOverride?: { type: 'video' | 'image'; url: string }[],
  ): Promise<{ ok: boolean; sensitive?: boolean; error?: string; data?: EditPlan[] }> {
    const mediaItems =
      mediaOverride ??
      materials
        .filter((m) => m.url && /^https?:\/\//.test(m.url))
        .map((m) => ({ type: 'video' as const, url: m.url! }));
    const prompt = buildEditPrompt(materials);
    const r = await this.chatJsonStrictSafe(EDIT_SYSTEM_PROMPT, prompt, mediaItems);
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
  if (Array.isArray(raw)) return parseEditPlans(JSON.stringify({ plans: raw }), materials);
  if (raw && Array.isArray(raw.plans)) return parseEditPlans(JSON.stringify(raw), materials);
  // _raw 或其它异常结构：直接按原文（或序列化后的文本）重新提取
  return parseEditPlans(typeof raw === 'string' ? raw : JSON.stringify(raw), materials);
}

/** 从文本中去掉 http(s) 链接，避免把长串直链塞进 prompt（既省 token 也规避审核误触发） */
function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, '').replace(/\n{2,}/g, '\n').trim();
}

/** 精简文本：仅保留前 300 字并去掉 URL，作为敏感拦截时的最后兜底输入 */
function minimizeText(text: string): string {
  const t = stripUrls(text);
  return `仅基于以下标题与标签做客观分析，不要复述原文或描述画面：\n${t.slice(0, 300)}`;
}

/** 从模型返回中提取第一个 JSON 对象；失败返回 { _raw } */
export function parseJson(text: string): any {
  if (!text) return { _raw: '' };
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
async function readSSE(res: Response, onToken: (t: string) => void): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta: string = j?.choices?.[0]?.delta?.content ?? '';
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
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return full;
}

const EDIT_SYSTEM_PROMPT = `你是一名资深海外社媒短视频剪辑导演，擅长把原始旅游素材快速规划成适合不同平台、不同营销目标的成片方案。
任务：基于提供的素材清单（含可选的视频画面/音频），为「流量型 / 种草型 / 转化型」三种方向，分别产出适配 TikTok / Instagram / Facebook 的剪辑方案。
要求：
1. 必须只输出一个 JSON 对象，不要任何额外说明文字；
2. JSON 结构固定为：{ "plans": EditPlan[] }；
3. 每个 EditPlan 字段：
   - direction: "traffic" | "seed" | "conversion"
   - platform: "tiktok" | "instagram" | "facebook" | "twitter"
   - durationSec: number（TikTok 建议 15，Instagram/Facebook 建议 30）
   - hook: string，前 3 秒抓人的开场文案
   - clips: string[]，从给定素材名中挑选 2-4 个
   - captions: string[]，字幕/口播文案（与 clips 数量对应）
   - transitions: string，转场与节奏说明
   - note: string，整体规划说明
4. 三种方向 × 三个平台 共 9 个方案都要给出；clips 必须引用素材清单里真实存在的素材名；
5. 方案要具体、可落地，结合素材内容（场景/时长）来规划，避免空话。`;

export function buildEditPrompt(materials: EditMaterial[]): string {
  const list = materials
    .map((m, i) => {
      const media = m.url && /^https?:\/\//.test(m.url) ? '（已附视频，可结合画面）' : '（仅文本元数据）';
      return `素材${i + 1}：名称=${m.name}${media}
  标题：${m.title || '无'}｜文案：${m.caption || '无'}｜标签：${(m.tags ?? []).join(' / ') || '无'}｜平台：${m.platform || '未指定'}｜时长：${m.durationSec ?? '未知'}s`;
    })
    .join('\n');
  return `下面是待剪辑的旅游素材清单（共 ${materials.length} 个）：\n\n${list}\n\n请按系统要求输出 9 个成片剪辑方案（JSON）。`;
}

export function parseEditPlans(text: string, materials: EditMaterial[]): EditPlan[] {
  if (!text) return [];
  const obj = extractPlansJson(text);
  if (!obj) return [];
  const plans = Array.isArray(obj.plans) ? obj.plans : [];
  if (!plans.length) return [];
  return plans
    .map((p: any): EditPlan => ({
      direction: ['traffic', 'seed', 'conversion'].includes(p.direction) ? p.direction : 'traffic',
      platform: ['tiktok', 'instagram', 'facebook', 'twitter'].includes(p.platform) ? p.platform : 'tiktok',
      durationSec: Number(p.durationSec) || 15,
      hook: typeof p.hook === 'string' ? p.hook : '',
      clips: Array.isArray(p.clips) ? resolveClips(p.clips, materials) : [],
      captions: Array.isArray(p.captions) ? p.captions.map(String) : [],
      transitions: typeof p.transitions === 'string' ? p.transitions : '',
      note: typeof p.note === 'string' ? p.note : '',
    }))
    .filter((p: EditPlan) => p.hook || p.clips.length || p.note || (p.captions && p.captions.length) || p.transitions);
}

/** 从模型返回中提取 {plans:[...]} 对象：先剥离 <think> 推理块，再稳健定位 JSON。 */
function extractPlansJson(text: string): any {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // 优先：包含 "plans" 键的 JSON 对象（允许数组内嵌套一层对象）
  const re = /\{[^{}]*"plans"[^{}]*(?:\[[\s\S]*?\])[^{}]*\}/g;
  let m: RegExpExecArray | null;
  const candidates: string[] = [];
  while ((m = re.exec(cleaned)) !== null) candidates.push(m[0]);
  // 兜底：最后一个 { 到最后一个 } 之间
  const lastOpen = cleaned.lastIndexOf('{');
  const lastClose = cleaned.lastIndexOf('}');
  if (lastOpen >= 0 && lastClose > lastOpen) candidates.push(cleaned.slice(lastOpen, lastClose + 1));
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && Array.isArray(obj.plans)) return obj;
    } catch { /* 尝试下一个候选 */ }
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
      if (m) { out.push(m.name); continue; }
    }
    if (byName.has(s)) { out.push(s); continue; }
    // 模糊匹配
    const hit = materials.find((mm) => mm.name.includes(s) || s.includes(mm.name));
    if (hit) out.push(hit.name);
  }
  return out;
}
