import { net } from "electron";
import type { AppConfig } from "../shared/types";
import type { GeneratedImage, ImageInput } from "../shared/ipc";

type JsonObject = Record<string, unknown>;

/** 生图模型的全局系统约束，避免中文文字出现乱码、错别字或笔画错误。 */
const IMAGE_SYSTEM_PROMPT =
  "你是专业图片生成模型。图片中如需出现中文，必须生成真实、清晰、可读的简体中文汉字，逐字校验字形、笔画、偏旁、顺序和标点，严禁乱码、错别字、伪汉字、随机字母或不可读文字。无法保证中文准确时，不要生成中文文字，改用留白或无文字设计。";

function endpoint(baseUrl: string, path: string): string {
  const trimmedPath = path.trim();
  if (/^https?:\/\//i.test(trimmedPath)) return trimmedPath;
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("图片模型 Base URL 未配置");
  return `${base}/${trimmedPath.replace(/^\/+/, "")}`;
}

function advancedParams(raw: string): JsonObject {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("必须是 JSON 对象");
    }
    return parsed as JsonObject;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`图片模型高级参数不是有效的 JSON 对象：${reason}`);
  }
}

function imageSource(input: ImageInput, label: string): string {
  const source = input.dataUrl?.trim() || input.url?.trim();
  if (!source) throw new Error(`${label}缺少 URL 或图片数据`);
  return source;
}

function editStyle(config: AppConfig): "string" | "images" {
  if (config.imageEditStyle !== "auto") return config.imageEditStyle;
  return config.imageApiFormat === "seedream" ? "string" : "images";
}

function dataUrlParts(dataUrl: string): {
  bytes: Uint8Array;
  contentType: string;
} {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(dataUrl);
  if (!match) throw new Error("图片 data URL 格式无效");
  const contentType = match[1] || "application/octet-stream";
  try {
    const buffer = match[2]
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3]), "utf8");
    return { bytes: new Uint8Array(buffer), contentType };
  } catch {
    throw new Error("图片 data URL 内容无法解码");
  }
}

async function inputBlob(
  input: ImageInput,
  label: string,
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string }> {
  const source = imageSource(input, label);
  if (source.startsWith("data:")) {
    const { bytes, contentType } = dataUrlParts(source);
    const ext = contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
    return {
      blob: new Blob([bytes], { type: contentType }),
      filename: `${label}.${ext}`,
    };
  }
  if (!/^https?:\/\//i.test(source))
    throw new Error(`${label} URL 仅支持 http、https 或 data URL`);

  let response: Response;
  try {
    response = await net.fetch(source, {
      redirect: "follow",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(
      `${label}下载失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok)
    throw new Error(`${label}下载失败：HTTP ${response.status}`);
  const contentType =
    response.headers.get("content-type")?.split(";")[0] ||
    "application/octet-stream";
  const ext = contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
  return {
    blob: new Blob([await response.arrayBuffer()], { type: contentType }),
    filename: `${label}.${ext}`,
  };
}

function appendAdvanced(form: FormData, params: JsonObject): void {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((item) =>
        form.append(
          key,
          typeof item === "object" ? JSON.stringify(item) : String(item),
        ),
      );
    } else {
      form.set(
        key,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      );
    }
  }
}

function normalizedImage(item: unknown): GeneratedImage | null {
  if (!item || typeof item !== "object") return null;
  const value = item as Record<string, unknown>;
  const url =
    typeof value.url === "string" && value.url.trim() ? value.url : undefined;
  let b64 =
    typeof value.b64_json === "string"
      ? value.b64_json
      : typeof value.b64 === "string"
        ? value.b64
        : undefined;
  let contentType =
    typeof value.content_type === "string"
      ? value.content_type
      : typeof value.mime_type === "string"
        ? value.mime_type
        : "image/png";
  if (b64?.startsWith("data:")) {
    const match = /^data:([^;,]+)?;base64,([\s\S]+)$/i.exec(b64);
    if (match) {
      contentType = match[1] || contentType;
      b64 = match[2];
    }
  }
  return url || b64 ? { url, b64, contentType } : null;
}

async function parseResponse(response: Response): Promise<GeneratedImage[]> {
  const text = await response.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      /* 错误分支会保留原始响应文本 */
    }
  }
  if (!response.ok) {
    const detail =
      body?.error?.message ||
      body?.message ||
      body?.error ||
      text ||
      response.statusText;
    throw new Error(
      `图片模型请求失败（HTTP ${response.status}）：${String(detail).slice(0, 800)}`,
    );
  }
  if (!body || !Array.isArray(body.data)) {
    throw new Error("图片模型响应格式无效：缺少 data 数组");
  }
  const images = body.data
    .map(normalizedImage)
    .filter((item: GeneratedImage | null): item is GeneratedImage => !!item);
  if (!images.length)
    throw new Error("图片模型响应中没有可用的图片 URL 或 base64 数据");
  return images;
}

async function request(
  config: AppConfig,
  url: string,
  body: JsonObject | FormData,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  if (!config.imageApiKey.trim())
    throw new Error("未配置图片模型 API Key，请先在设置页配置");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.imageApiKey.trim()}`,
    Accept: "application/json",
  };
  const requestBody = body instanceof FormData ? body : JSON.stringify(body);
  if (!(body instanceof FormData)) headers["Content-Type"] = "application/json";

  let response: Response | undefined;
  let lastError: unknown;
  // 部分网关在 multipart 上传或连接复用时会主动关闭连接；仅对连接关闭做一次重试，
  // 避免重复提交正常的参数错误请求。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await net.fetch(url, {
        method: "POST",
        headers,
        body: requestBody,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(180_000)])
          : AbortSignal.timeout(180_000),
      });
      break;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 0 && /CONNECTION_CLOSED|connection closed|socket hang up/i.test(message)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      break;
    }
  }
  if (!response) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`无法连接图片模型（${url}）：${detail}`);
  }
  return parseResponse(response);
}

// 图片模型对中文字符的生成稳定性通常较弱。将校验要求放在服务端统一追加，
// 确保文生图、参考图编辑以及不同渲染端都使用同一套约束。
function promptWithChineseTextGuard(prompt: string): string {
  return `${prompt}\n\n中文文字质量要求：如果画面中需要出现中文，必须使用真实、清晰、可读的简体中文汉字，逐字检查字形、笔画、顺序和标点，禁止乱码、错别字、伪汉字、随机字母或不可读文字。生成前后都要自检；如果无法保证中文准确，就不要生成中文文字，并用留白或无文字设计替代。除非原提示明确要求，不要擅自添加中文文字。`;
}

export async function generateImage(
  config: AppConfig,
  prompt: string,
  size?: string,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) throw new Error("请输入图片描述");
  const guardedPrompt = promptWithChineseTextGuard(cleanPrompt);
  const body = {
    ...advancedParams(config.imageAdvancedParams),
    model: config.imageModel.trim(),
    system: IMAGE_SYSTEM_PROMPT,
    prompt: guardedPrompt,
    ...(size ? { size } : {}),
    quality: 'high',
    moderation: 'low'
  };
  return request(
    config,
    endpoint(config.imageBaseUrl, config.imageGeneratePath),
    body,
    signal,
  );
}

export async function editImage(
  config: AppConfig,
  args: { prompt: string; images: ImageInput[]; mask?: ImageInput; size?: string },
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const prompt = args.prompt.trim();
  if (!prompt) throw new Error("请输入图片编辑描述");
  const guardedPrompt = promptWithChineseTextGuard(prompt);
  if (!args.images?.length) throw new Error("请至少选择一张参考图片");
  const style = editStyle(config);
  const params = advancedParams(config.imageAdvancedParams);
  const url = endpoint(config.imageBaseUrl, config.imageEditPath);

  // 带蒙版的局部编辑必须上传真实文件，不能使用 JSON 中的 data URL。
  // 即使全局配置为 json，也要强制走 multipart/form-data，否则编辑接口会拒绝请求。
  // 模板图片来自数据库，通常是 data URL。此类输入必须作为真实文件上传，
  // 否则部分图片接口会拒绝 JSON 请求并返回「不是 multipart/form-data」。
  const hasInlineImage = args.images.some((input) => !!input.dataUrl?.trim());
  if (config.imageBodyMode === "json" && !args.mask && !hasInlineImage) {
    const sources = args.images.map((input, index) =>
      imageSource(input, `参考图片 ${index + 1}`),
    );
    const body: JsonObject = {
      ...params,
      model: config.imageModel.trim(),
      system: IMAGE_SYSTEM_PROMPT,
      prompt: guardedPrompt,
      ...(args.size ? { size: args.size } : {}),
      quality: 'high',
      moderation: 'low'
    };
    if (style === "string") body.image = sources[0];
    else body.images = sources;
    if (args.mask) body.mask = imageSource(args.mask, "蒙版图片");
    return request(config, url, body, signal);
  }

  const form = new FormData();
  appendAdvanced(form, params);
  form.set("model", config.imageModel.trim());
  form.set("system", IMAGE_SYSTEM_PROMPT);
  form.set(
    "prompt",
    args.mask
      ? `${guardedPrompt}\n仅修改蒙版标记的区域，蒙版之外的所有人物、物体、背景、文字、颜色、构图和像素必须保持不变。不要对未选区域做任何修改。`
      : guardedPrompt,
  );
  if (args.size) form.set("size", args.size);
  if (style === "string") {
    const file = await inputBlob(args.images[0], "image", signal);
    form.set("image", file.blob, file.filename);
  } else if (args.mask) {
    // 局部编辑只有一张底图；OpenAI 兼容编辑接口要求字段名为单个 image。
    const file = await inputBlob(args.images[0], "image", signal);
    form.set("image", file.blob, file.filename);
  } else {
    const files = await Promise.all(
      args.images.map((input, index) =>
        inputBlob(input, `image-${index + 1}`, signal),
      ),
    );
    // 当前图片编辑网关按 image 字段解析上传文件；重复 image 字段可兼容多张参考图。
    files.forEach((file) => form.append("image", file.blob, file.filename));
  }
  if (args.mask) {
    const mask = await inputBlob(args.mask, "mask", signal);
    form.set("mask", mask.blob, mask.filename);
  }
  return request(config, url, form, signal);
}
