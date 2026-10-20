import { net } from "electron";
import type { AppConfig } from "../shared/types";

export const DEFAULT_SOP_SYSTEM_PROMPT =
  "You are a professional customer service assistant working in Chongqing inbound tourism in China. Follow all rules: 1. Reply in English. 2. Help travelers with attraction tickets and other ticketing services, customized tours, itinerary planning, and related travel consultations. 3. Write a concise, natural, professional, and friendly reply that can be sent directly to the guest. 4. Do not output explanations, reasoning, greetings beyond what the guest needs, quotation marks, or Markdown. Return only the final reply.";

export async function generateSopReply(
  config: AppConfig,
  question: string,
  systemPrompt?: string,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = question.trim();
  const system = systemPrompt?.trim() || DEFAULT_SOP_SYSTEM_PROMPT;
  if (!prompt) throw new Error("请输入用户问题");
  if (!config.sopApiKey.trim())
    throw new Error("未配置客服 SOP 对话模型 API Key，请先在设置页配置");
  const base = config.sopBaseUrl.trim().replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const response = await net.fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.sopApiKey.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: config.sopModel.trim() || "doubao-seed-2-0-lite-260215",
      reasoning_effort: "minimal",
      temperature: 0.6,
      max_tokens: 1000,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok)
    throw new Error(
      `客服 SOP 模型请求失败（HTTP ${response.status}）：${String(body?.error?.message || body?.message || text).slice(0, 500)}`,
    );
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim())
    throw new Error("客服 SOP 模型返回为空");
  return content.trim();
}

export interface VoiceoverAnalysis {
  keyPoints: string[];
  hook: string;
  closingCta: string;
  opening: string;
  middle: string;
  ending: string;
}

export async function analyzeVoiceover(
  config: AppConfig,
  transcript: string,
  signal?: AbortSignal,
): Promise<VoiceoverAnalysis> {
  if (!transcript.trim()) throw new Error("口播文案为空，无法分析");
  if (!config.sopApiKey.trim())
    throw new Error("未配置客服 SOP 对话模型 API Key，请先在设置页配置");
  const response = await net.fetch(
    `${config.sopBaseUrl.trim().replace(/\/+$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.sopApiKey.trim()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: config.sopModel.trim() || "doubao-seed-2-0-lite-260215",
        reasoning_effort: "minimal",
        temperature: 0.3,
        max_tokens: 1800,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "你是短视频脚本分析师。只返回合法 JSON，不要 Markdown、解释或代码块。所有字段值必须使用简体中文回复；原文是英语或其他语言时，必须先翻译成中文再分析，不能把英文原句作为分析结果返回（专有名词可保留）。字段必须是：keyPoints（字符串数组，视频卖点/核心要点）、hook（开头钩子）、closingCta（结尾引导话术）、opening（开头内容）、middle（中间内容）、ending（结尾内容）。忠实基于原文，不要臆测；如果没有明确 CTA，填写“未明确”。",
          },
          {
            role: "user",
            content: `请分析以下全量口播文案：\n\n${transcript}`,
          },
        ],
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    },
  );
  const raw = await response.text();
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (!response.ok)
    throw new Error(
      `客服 SOP 模型分析失败（HTTP ${response.status}）：${String(body?.error?.message || body?.message || raw).slice(0, 400)}`,
    );
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("客服 SOP 模型分析返回为空");
  try {
    const json = JSON.parse(
      content
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim(),
    );
    return {
      keyPoints: Array.isArray(json.keyPoints)
        ? json.keyPoints.map(String).filter(Boolean)
        : [],
      hook: String(json.hook || "未明确"),
      closingCta: String(json.closingCta || "未明确"),
      opening: String(json.opening || "未明确"),
      middle: String(json.middle || "未明确"),
      ending: String(json.ending || "未明确"),
    };
  } catch {
    throw new Error("客服 SOP 模型返回的分析结果不是有效 JSON");
  }
}
