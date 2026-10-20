// 模块一~六的 MiniMax-M3 多模态分析任务（严格对应《技术落地文档》Prompt 模板）
// 每个函数只负责：组装 system/user 提示 → 调用 MiniMaxClient.chatJson → 返回结构化结果。
// 不在本文件做本地规则兜底（区别于旧版本地启发式），全部依赖大模型真实推理。
import { MiniMaxClient } from "../data/minimax";
import { AiTaskName } from "../shared/types";
import { OwnWorkSample, splitOwnWorksByTraffic } from "../shared/own-works";
import * as fs from "fs";
import * as path from "path";
import { net, session } from "electron";
import * as os from "os";
import { mediaDir } from "../data/store";

// ---------------------------------------------------------------------------
// 模块一：竞对账号智能分类（多模态文本分析）
// ---------------------------------------------------------------------------
// 关键改进：除账号简介外，额外接收「高赞/代表性作品样本」（标题 + 文案摘要 + 真实互动数据）
// 与账号基础数据（粉丝/作品数），让模型基于真实作品而非空泛简介做判断，
// 并显式约束「不得编造未提供的信息」，从源头抑制 Instagram 等场景下的幻觉。
const ACCOUNT_SYSTEM = `你是海外社媒账号分析师。输入为：① 账号主页简介；② 账号基础数据（粉丝、作品数）；
③ 该账号的高流量/代表性作品样本（含标题、文案摘要、点赞/播放/评论等真实数据，已按播放量排序，高流量优先）。
工作分两步：
第一步【精确判断账号类型】account_type 二选一：转化型账号 / 流量型账号。
  依据：简介是否销售产品/服务/留联系方式、作品是否带产品展示/价格/咨询引导 → 转化型；纯内容分享/种草/涨粉 → 流量型。
  reason 必须引用简介或作品中的具体信息说明判断依据。
第二步【按账号类型做专项分析】（只做该类型的专项，输出对应字段）：
- 若为【转化型账号】（如入境旅行社、定制游公司、地接社等）：核心分析目标 = 「什么内容带来了客户咨询和订单？」
  "conversion_content_insight": "带来咨询/订单的内容特征（结合作品样本逐条说明：选题、形式、钩子、结尾引导、价格/行程呈现方式的具体规律，禁止留空）",
  "conversion_triggers": "转化触发点（如价格透明、行程亮点、签证/资质信任背书、客户评价、咨询入口明显、评论区引导等，具体指出）",
  "conversion_friction": "可能阻碍转化的点（如咨询入口不明显、缺信任背书、内容未指向下单/咨询路径等，无则填「无明显阻碍」）",
  "content_optimization": ["针对提升咨询/订单的可执行优化建议1", "建议2", "建议3"]
- 若为【流量型账号】（如中国旅游博主、城市旅游账号、景点账号等）：核心分析目标 = 「找出海外用户喜欢看的中国旅游内容」
  "audience_favorite_content": "海外用户喜欢看的中国旅游内容类型（结合样本的选题与播放/点赞数据总结，如奇观航拍、美食制作、人文烟火气、体验vlog、实用攻略等，具体到内容形态）",
  "popular_content_pattern": "高播放作品的共同模式（开头钩子、拍摄手法、节奏、情绪价值、信息密度等，逐条说明）",
  "content_opportunity": ["可复制的选题方向1", "选题2", "选题3"]
公共字段（两类都必须输出，禁止留空）：
  "account_business_position": "账号业务定位（具体业务描述，如旅游定制服务商/目的地种草号/旅行社门店引流号等）",
  "target_audience": "目标海外客群（具体人群画像，如25-40岁欧美自由行游客/亲子游家庭/摄影爱好者）",
  "drainage_method": "简介/作品中的引流方式（无则填「无」）",
  "work_insight": "账号内容特征与规律（选题方向、表现最好的内容类型、更新节奏等）"
请严格输出JSON，不要多余解释。
【重要约束】仅依据上方提供的真实简介、基础数据与作品样本作答，不得编造任何未提供的信息；若粉丝显示「未获取」，表示数据源未返回，禁止估算、推断或在结论中引用粉丝数；
公共字段与所在类型的专项字段都禁止留空、禁止 null、禁止省略；某项确实无法判断只能写「数据不足，无法判断」。`;

/** 单个作品样本（用于 grounded 分析；数据均来自 TiKhub 真实抓取，绝不伪造） */
export interface AccountPostSample {
  title: string;
  caption?: string;
  views: number;
  likes: number;
  comments: number;
}

export interface AccountAnalysis {
  account_business_position: string;
  target_audience: string;
  drainage_method: string;
  account_type: "转化型账号" | "流量型账号";
  reason: string;
  work_insight?: string;
  // 转化型账号专项（什么内容带来咨询/订单）
  conversion_content_insight?: string;
  conversion_triggers?: string;
  conversion_friction?: string;
  content_optimization?: string[];
  // 流量型账号专项（海外用户喜欢看的中国旅游内容）
  audience_favorite_content?: string;
  popular_content_pattern?: string;
  content_opportunity?: string[];
}

export async function analyzeAccount(
  client: MiniMaxClient,
  payload: {
    bio: string;
    posts?: AccountPostSample[];
    followers?: number;
    videoCount?: number;
    platform?: string;
  },
): Promise<AccountAnalysis> {
  const posts = payload.posts ?? [];
  const postsText = posts.length
    ? posts
        .map(
          (p, i) =>
            `作品${i + 1}【${p.title || p.caption?.slice(0, 40) || "（无标题）"}】点赞 ${p.likes.toLocaleString()} · 播放 ${p.views.toLocaleString()} · 评论 ${p.comments.toLocaleString()}\n文案摘要：${p.caption ? p.caption.slice(0, 120) : p.title || "（无文案）"}`,
        )
        .join("\n")
    : "（无作品样本，仅依据账号简介与基础数据判断）";
  const followers =
    payload.followers == null
      ? "未获取（数据源未返回，禁止估算）"
      : payload.followers.toLocaleString();
  const user = `【账号简介】${payload.bio || "（无简介）"}\n【账号基础数据】粉丝：${followers} · 作品数：${payload.videoCount ?? "未知"}\n【该账号高流量/代表性作品样本（按播放量排序 Top${posts.length}）】\n${postsText}`;
  const r = await client.chatJson(ACCOUNT_SYSTEM, user);
  // 字段别名兜底：模型可能用不同 key 返回（camelCase / 无前缀 / 中文），逐层兼容，避免「工作流有结果但页面为空」
  const pickStr = (obj: any, keys: string[]): string => {
    for (const k of keys) {
      const v = obj?.[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  const pickArr = (obj: any, keys: string[]): string[] => {
    for (const k of keys) {
      const v = obj?.[k];
      if (Array.isArray(v)) return v.map(String).filter(Boolean);
    }
    return [];
  };
  return {
    account_business_position:
      pickStr(r, [
        "account_business_position",
        "business_position",
        "businessPosition",
        "account_position",
        "业务定位",
      ]) || "数据不足，无法判断",
    target_audience:
      pickStr(r, [
        "target_audience",
        "targetAudience",
        "audience",
        "target_customer",
        "客群",
      ]) || "数据不足，无法判断",
    drainage_method:
      pickStr(r, [
        "drainage_method",
        "drainageMethod",
        "drainage",
        "引流方式",
        "引流",
      ]) || "无",
    account_type: r.account_type === "流量型账号" ? "流量型账号" : "转化型账号",
    reason: String(r.reason ?? ""),
    work_insight: r.work_insight ? String(r.work_insight) : undefined,
    // 转化型专项（什么内容带来咨询/订单）
    conversion_content_insight:
      pickStr(r, [
        "conversion_content_insight",
        "conversionContentInsight",
        "content_insight",
        "转化内容洞察",
      ]) || undefined,
    conversion_triggers:
      pickStr(r, [
        "conversion_triggers",
        "conversionTriggers",
        "triggers",
        "转化触发点",
      ]) || undefined,
    conversion_friction:
      pickStr(r, [
        "conversion_friction",
        "conversionFriction",
        "friction",
        "转化阻碍",
      ]) || undefined,
    content_optimization: pickArr(r, [
      "content_optimization",
      "contentOptimization",
      "optimization",
    ]),
    // 流量型专项（海外用户喜欢看的中国旅游内容）
    audience_favorite_content:
      pickStr(r, [
        "audience_favorite_content",
        "audienceFavoriteContent",
        "favorite_content",
        "海外用户爱看内容",
      ]) || undefined,
    popular_content_pattern:
      pickStr(r, [
        "popular_content_pattern",
        "popularContentPattern",
        "content_pattern",
        "高播放共性",
      ]) || undefined,
    content_opportunity: pickArr(r, [
      "content_opportunity",
      "contentOpportunity",
      "opportunity",
    ]),
  };
}

// ---------------------------------------------------------------------------
// 模块二：竞对视频内容解析（多模态：视频直链 + 标题 + 标签）
// ---------------------------------------------------------------------------
const VIDEO_PARSE_SYSTEM = `你是海外短视频内容解析专家，分析这条海外旅游短视频。严格输出JSON，禁止额外文字输出。输出字段说明：first_3s_hook：总结视频前3秒画面与文案钩子；video_structure：完整视频叙事结构，按时间阶段简要描述；main_scene_subject：视频主要拍摄主体，景点、美食、人文、城市等；user_concern：从标题标签推测该视频会吸引海外用户哪些关注点。输出JSON结构：{
  "first_3s_hook":"",
  "video_structure":"",
  "main_scene_subject":"",
  "user_concern":""
}
视频标题：{{video_title}}视频标签tags：{{video_tags}}视频资源链接：{{video_url}}`;

export interface VideoParseResult {
  first3sHook: string;
  videoStructure: string;
  mainSceneSubject: string;
  userConcern: string;
}

export async function parseVideo(
  client: MiniMaxClient,
  payload: { title: string; tags: string[]; url?: string },
): Promise<VideoParseResult> {
  const user = `视频标题：${payload.title || "（无标题）"}\n视频标签tags：${(payload.tags || []).join(" / ") || "无"}\n视频资源：${payload.url ? "（视频已作为多模态输入附加，请结合画面与以上标题/标签分析）" : "（未提供直链，请基于文本分析）"}`;
  const r = await client.chatJson(VIDEO_PARSE_SYSTEM, user, payload.url);
  return mapVideoParse(r);
}

/** 把模型返回映射为统一结构（直连解析与脱敏恢复共用） */
function mapVideoParse(r: any): VideoParseResult {
  return {
    first3sHook: String(r?.first_3s_hook ?? ""),
    videoStructure: String(r?.video_structure ?? ""),
    mainSceneSubject: String(r?.main_scene_subject ?? ""),
    userConcern: String(r?.user_concern ?? ""),
  };
}

/**
 * 带「敏感信号」的直连视频解析：不抛异常，返回 { ok, sensitive?, error?, data? }，
 * 供「敏感内容自动脱敏恢复」流程判断是否进入 ffmpeg 预处理分支。
 */
export async function parseVideoSafe(
  client: MiniMaxClient,
  payload: { title: string; tags: string[]; url?: string },
): Promise<{
  ok: boolean;
  sensitive?: boolean;
  error?: string;
  data?: VideoParseResult;
}> {
  const user = `视频标题：${payload.title || "（无标题）"}\n视频标签tags：${(payload.tags || []).join(" / ") || "无"}\n视频资源：${payload.url ? "（视频已作为多模态输入附加，请结合画面与以上标题/标签分析）" : "（未提供直链，请基于文本分析）"}`;
  const mediaItems = payload.url
    ? [{ type: "video" as const, url: payload.url }]
    : [];
  const r = await client.chatJsonSafe(VIDEO_PARSE_SYSTEM, user, mediaItems);
  if (!r.ok) return { ok: false, sensitive: r.sensitive, error: r.error };
  return { ok: true, data: mapVideoParse(r.data) };
}

const VIDEO_PARSE_FRAMES_SYSTEM = `你是海外短视频内容解析专家，下面是一段海外旅游短视频按时间顺序抽取的帧画面图片（每秒 1 帧）。请结合这些画面与视频标题、标签，分析视频内容。严格输出JSON，禁止额外文字输出。输出字段：first_3s_hook：基于首帧画面与标题总结开头钩子；video_structure：整体视频内容结构简述；main_scene_subject：视频主要拍摄主体（景点、美食、人文、城市等）；user_concern：从标题标签推测吸引海外用户的关注点。输出JSON结构：{ "first_3s_hook":"","video_structure":"","main_scene_subject":"","user_concern":"" }`;

/**
 * 抽帧图片集解析（脱敏恢复最后一步）：传入已上传到 MiniMax 的图片引用（mm_file://）集合，
 * 以 image_url 多模态输入完成内容分析。返回 { ok, sensitive?, error?, data? }。
 */
export async function parseVideoFramesSafe(
  client: MiniMaxClient,
  payload: { title: string; tags: string[]; imageUrls: string[] },
): Promise<{
  ok: boolean;
  sensitive?: boolean;
  error?: string;
  data?: VideoParseResult;
}> {
  const user = `视频标题：${payload.title || "（无标题）"}\n视频标签tags：${(payload.tags || []).join(" / ") || "无"}\n（已附视频抽帧图片，请结合画面与以上标题/标签分析）`;
  const mediaItems = payload.imageUrls.map((u) => ({
    type: "image" as const,
    url: u,
  }));
  const r = await client.chatJsonSafe(
    VIDEO_PARSE_FRAMES_SYSTEM,
    user,
    mediaItems,
  );
  if (!r.ok) return { ok: false, sensitive: r.sensitive, error: r.error };
  return { ok: true, data: mapVideoParse(r.data) };
}

// ---------------------------------------------------------------------------
// 图文（图片）内容解析：只分析图片构图、拍摄主体、风格色调、用户吸引力、文案
// ---------------------------------------------------------------------------
const IMAGE_SYSTEM = `你是海外旅游图文内容分析专家，分析这张旅游相关的图片。严格输出JSON，禁止额外文字输出。输出字段说明：composition：图片构图方式（如三分法、中心对称、引导线、留白、前景/背景层次等）与画面布局；subject：图片主要拍摄主体（景点、美食、人文、人物、城市建筑等）及主体呈现方式；style_tone：画面风格与色调（明亮/暗调、冷暖、胶片感、清新等）；user_appeal：推测该图片会吸引海外用户的关注点与情绪价值；caption_suggestion：为这张图配的一句英文社媒文案建议。输出JSON结构：{
  "composition":"",
  "subject":"",
  "style_tone":"",
  "user_appeal":"",
  "caption_suggestion":""
}`;

export interface ImageAnalysisResult {
  composition: string; // 构图方式
  subject: string; // 拍摄主体
  styleTone: string; // 风格与色调
  userAppeal: string; // 用户吸引力
  captionSuggestion: string; // 英文社媒文案建议
}

/**
 * 图片下载兜底通道：用 Electron session 的下载能力（与渲染进程 <img>/下载同一会话、同一网络栈）。
 * 当 net.fetch 被 TikTok CDN 重置连接（net::ERR_CONNECTION_RESET / fetch failed）时使用——
 * 该通道共享会话 cookie 与完整 Chromium 浏览器指纹，与浏览器预览成功走的是同一路径。
 * 下载到系统临时目录后读字节返回，并清理临时文件。
 */
async function downloadImageViaSession(
  url: string,
): Promise<{ bytes: Buffer; ext: string }> {
  const ses = session.defaultSession;
  const tmpPath = path.join(
    os.tmpdir(),
    `oss-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  return await new Promise<{ bytes: Buffer; ext: string }>(
    (resolve, reject) => {
      let settled = false;
      const finish = (err?: any, ok?: boolean) => {
        if (settled) return;
        settled = true;
        if (!ok) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        try {
          const bytes = fs.readFileSync(tmpPath);
          const m = url.match(/\.(jpe?g|png|webp|gif|bmp)(?:\?|$)/i);
          resolve({ bytes, ext: m ? m[1].toLowerCase() : "jpg" });
        } catch (e: any) {
          reject(e);
        } finally {
          try {
            fs.unlinkSync(tmpPath);
          } catch {
            /* 清理失败忽略 */
          }
        }
      };
      const onWillDownload = (_e: any, item: any) => {
        try {
          // 兜底：个别版本/场景下 item 可能缺失，直接按失败处理，避免 "reading 'on'" 崩溃
          if (!item || typeof item.once !== "function") {
            finish(new Error("下载项异常（download item 缺失）"));
            return;
          }
          item.setSavePath(tmpPath);
          item.once("done", (_ev: any, state: string) => {
            const ok = state === "completed";
            finish(ok ? undefined : `下载状态 ${state}`, ok);
          });
        } catch (e: any) {
          finish(e);
        }
      };
      ses.once("will-download", onWillDownload);
      try {
        ses.downloadURL(url);
      } catch (e: any) {
        finish(e);
      }
      setTimeout(() => finish("下载超时（30s）"), 30_000);
    },
  );
}

/**
 * 下载图片字节（主进程网络请求）。用于把远程签名直链（TikTok/Instagram 等）先取到本地内存，
 * 再上传到 MiniMax 云端——避免 MiniMax 服务端直接拉取 TikTok CDN 失败（403/500/fetch url failed）。
 * 首选 Electron net.fetch（Chromium 网络栈、遵循系统代理）；若被 CDN 重置连接（net::ERR_CONNECTION_RESET）
 * 则回退到 session.downloadURL（与浏览器下载同栈、带 cookie 与完整浏览器指纹），尽量保证取到图。
 */
async function downloadImageBytes(
  url: string,
): Promise<{ bytes: Buffer; ext: string }> {
  try {
    const res = await net.fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: "https://www.tiktok.com/",
        Accept: "image/avif,image/webp,image/apng,image/png,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok)
      throw new Error(
        `下载图片失败（HTTP ${res.status}），可能无法访问该临时图链`,
      );
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 64)
      throw new Error("下载到的图片内容异常（过小，可能不是图片）");
    const m = url.match(/\.(jpe?g|png|webp|gif|bmp)(?:\?|$)/i);
    const ext = m ? m[1].toLowerCase() : "jpg";
    return { bytes: buf, ext };
  } catch (e: any) {
    try {
      return await downloadImageViaSession(url);
    } catch (e2: any) {
      throw new Error(
        `下载图片失败（${e?.message ?? e}）；会话下载兜底也失败（${e2?.message ?? e2}），` +
          `可能该图片的临时签名链接已过期，可在视频库点「全部替换为本地路径」本地化后重试`,
      );
    }
  }
}

/**
 * 图文（图片）内容解析：只聚焦于图片本身——构图、拍摄主体、风格色调与用户吸引力。
 * 关键：图片地址一律「主进程下载字节 → 上传到 MiniMax 拿 mm_file:// 引用」再分析，
 * 理由：远程签名直链（TikTok/Instagram CDN）MiniMax 服务端常拉取失败（fetch url failed），
 * 主进程与用户浏览器同机，能取到图；本地落盘图片（localmedia://）同理读字节上传即可。
 */
export async function analyzeImage(
  client: MiniMaxClient,
  payload: { title: string; url?: string; localMediaUrl?: string },
): Promise<ImageAnalysisResult> {
  let mediaRef: string | undefined;

  // 1) 本地落盘图片：读字节上传（服务端读不到 localmedia:// 协议）
  if (payload.localMediaUrl?.startsWith("localmedia://")) {
    const fileName = decodeURIComponent(
      payload.localMediaUrl.slice("localmedia://".length),
    );
    const filePath = path.join(mediaDir(), fileName);
    const resolved = path.resolve(filePath);
    const base = path.resolve(mediaDir());
    if (resolved !== base && !resolved.startsWith(base + path.sep))
      throw new Error("非法路径");
    const bytes = fs.readFileSync(filePath);
    mediaRef = await client.uploadImage(bytes, fileName);
  } else {
    // 2) 远程直链：主进程先下载再上传，绕开 MiniMax 服务端拉取失败
    const remote =
      (payload.url && /^https?:\/\//.test(payload.url)
        ? payload.url
        : undefined) ??
      (payload.localMediaUrl && /^https?:\/\//.test(payload.localMediaUrl)
        ? payload.localMediaUrl
        : undefined);
    if (!remote) throw new Error("该图文没有可用的图片地址，无法解析");
    const { bytes, ext } = await downloadImageBytes(remote);
    mediaRef = await client.uploadImage(bytes, `image.${ext}`);
  }

  const user = `图片标题：${payload.title || "（无标题）"}\n（图片已作为多模态输入附加，请结合画面分析）`;
  const r = await client.chatJsonMedia(IMAGE_SYSTEM, user, [
    { type: "image", url: mediaRef },
  ]);
  return {
    composition: String(r?.composition ?? ""),
    subject: String(r?.subject ?? ""),
    styleTone: String(r?.style_tone ?? ""),
    userAppeal: String(r?.user_appeal ?? ""),
    captionSuggestion: String(r?.caption_suggestion ?? ""),
  };
}

export async function inferImageSize(client: MiniMaxClient, payload: { prompt: string; baseSize: string }) {
  const fallback = payload.baseSize || "1024x1024";
  const result = await client.chatJson(
    "你是图片尺寸规划器。根据用户描述判断最合适的图片宽高比，并以基础尺寸为最大边生成整数像素尺寸。严格只输出JSON：{\"size\":\"宽x高\"}。例如基础尺寸2048x2048，用户说TikTok封面竖版，则输出1152x2048。",
    `基础尺寸：${fallback}\n用户描述：${payload.prompt}`,
  );
  const raw = typeof result?.size === "string" ? result.size : "";
  const match = raw.match(/(\d{3,5})\s*[x×]\s*(\d{3,5})/i);
  if (!match) return { size: fallback };
  const width = Number(match[1]);
  const height = Number(match[2]);
  const fallbackMatch = fallback.match(/(\d{3,5})\s*x\s*(\d{3,5})/i);
  const maxEdge = fallbackMatch
    ? Math.max(Number(fallbackMatch[1]), Number(fallbackMatch[2]))
    : 1024;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    size: `${Math.max(1, Math.round(width * scale))}x${Math.max(1, Math.round(height * scale))}`,
  };
}

// ---------------------------------------------------------------------------
// 模块四：爆款视频智能拆解（多模态：视频直链 + 标题 + 热门评论）
// ---------------------------------------------------------------------------
const VIRAL_SYSTEM = `你是海外旅游短视频爆款拆解专家，分析这条面向海外用户的中国旅游短视频。可选归因标签集合只能从下面选择：["视觉冲击力","海外用户认知差","情绪价值","实用价值","文化差异","话题性"]严格输出JSON格式，禁止输出其他文字。输出字段：{
  "first_3s_hook_summary":"总结前3秒钩子（画面、文案/口播、BGM、情绪切入点）",
  "main_shooting_subject":"视频主要拍摄主体：明确景点/美食/人文/城市/人物等主体，以及主体以何种方式呈现（特写、航拍、跟拍、延时等）",
  "full_video_structure":"完整视频内容结构，必须详细拆解：按时间线或叙事阶段（开场前3秒、主体展开、高潮/转折、结尾引导）逐段说明画面内容、运镜与剪辑节奏、字幕/口播信息、BGM与情绪调动，并给出各段大致时长占比与转场方式",
  "hit_reason_tags":["从给定集合选择1-3个标签"],
  "core_hit_logic":"爆款核心逻辑总结（为什么能火：选题切入点、情绪价值、信息差、视觉冲击力或节奏把控等）",
  "reproducible_topics":["选题1","选题2","选题3","选题4","选题5"]
}
视频标题：{{video_title}}热门评论样本：{{top_comments}}视频资源链接：{{video_url}}`;

const VIRAL_TAGS = [
  "视觉冲击力",
  "海外用户认知差",
  "情绪价值",
  "实用价值",
  "文化差异",
  "话题性",
];

export interface ViralBreakdownResult {
  first3sHookSummary: string;
  mainShootingSubject: string;
  fullVideoStructure: string;
  hitReasonTags: string[];
  coreHitLogic: string;
  reproducibleTopics: string[];
}

export async function breakdownViralVideo(
  client: MiniMaxClient,
  payload: { title: string; comments: string[]; url?: string },
): Promise<ViralBreakdownResult> {
  const comments = payload.comments?.length
    ? payload.comments.map((c, i) => `${i + 1}. ${c}`).join("\n")
    : "（无评论样本）";
  const user = `视频标题：${payload.title || "（无标题）"}\n热门评论样本：${comments}\n视频资源：${payload.url ? "（视频已作为多模态输入附加，请结合画面与以上标题/评论分析）" : "（未提供直链，请基于文本分析）"}`;
  const r = await client.chatJson(VIRAL_SYSTEM, user, payload.url);
  const tags = Array.isArray(r.hit_reason_tags)
    ? r.hit_reason_tags
        .map(String)
        .filter((t: string) => VIRAL_TAGS.includes(t))
    : [];
  return {
    first3sHookSummary: String(r.first_3s_hook_summary ?? ""),
    mainShootingSubject: String(r.main_shooting_subject ?? ""),
    fullVideoStructure: String(r.full_video_structure ?? ""),
    hitReasonTags: tags,
    coreHitLogic: String(r.core_hit_logic ?? ""),
    reproducibleTopics: Array.isArray(r.reproducible_topics)
      ? r.reproducible_topics.map(String)
      : [],
  };
}

/**
 * 敏感感知的爆款拆解：仅做「单次多模态尝试」，**不**降级为纯文本/精简文本。
 * 供「敏感内容自动脱敏恢复」流程判断是否需要进入 ffmpeg 预处理分支。
 * @param mediaItems 脱敏恢复流程传入的「替代媒体」（如重新编码后的 mm_file:// 或抽帧图片集）
 */
export async function breakdownViralVideoSafe(
  client: MiniMaxClient,
  payload: { title: string; comments: string[]; url?: string },
  mediaItems?: { type: "video" | "image"; url: string }[],
): Promise<{
  ok: boolean;
  sensitive?: boolean;
  error?: string;
  data?: ViralBreakdownResult;
}> {
  const comments = payload.comments?.length
    ? payload.comments.map((c, i) => `${i + 1}. ${c}`).join("\n")
    : "（无评论样本）";
  const user = `视频标题：${payload.title || "（无标题）"}\n热门评论样本：${comments}\n视频资源：${payload.url ? "（视频已作为多模态输入附加，请结合画面与以上标题/评论分析）" : "（未提供直链，请基于文本分析）"}`;
  const items =
    mediaItems ??
    (payload.url ? [{ type: "video" as const, url: payload.url }] : []);
  const r = await client.chatJsonStrictSafe(VIRAL_SYSTEM, user, items);
  if (!r.ok) return { ok: false, sensitive: r.sensitive, error: r.error };
  const d = r.data ?? {};
  const tags = Array.isArray(d.hit_reason_tags)
    ? d.hit_reason_tags
        .map(String)
        .filter((t: string) => VIRAL_TAGS.includes(t))
    : [];
  return {
    ok: true,
    data: {
      first3sHookSummary: String(d.first_3s_hook_summary ?? ""),
      mainShootingSubject: String(d.main_shooting_subject ?? ""),
      fullVideoStructure: String(d.full_video_structure ?? ""),
      hitReasonTags: tags,
      coreHitLogic: String(d.core_hit_logic ?? ""),
      reproducibleTopics: Array.isArray(d.reproducible_topics)
        ? d.reproducible_topics.map(String)
        : [],
    },
  };
}

// ---------------------------------------------------------------------------
// 模块五：高转化视频分析（多模态：视频直链 + 简介 + 置顶/热门评论）
// ---------------------------------------------------------------------------
const CONVERSION_SYSTEM = `你是入境游短视频转化分析师，分析这条旅行社/定制游账号发布的单条作品。必须根据视频画面/文案和真实评论证据，严格输出 JSON，不要多余文字。{
  "product_implant_method":"",
  "conversion_path":"",
  "potential_conversion_level":"高/中/低",
  "user_consult_demands":["从真实评论提取用户咨询诉求，无则空数组"],
  "summary":"总结该视频如何促成或阻碍咨询"
}
字段要求：
- product_implant_method：说明产品如何植入，包含位置、表达方式、具体卖点；没有植入必须写“无植入”并说明依据。
- conversion_path：按“看到内容→产生兴趣/信任→评论或私信咨询→领取方案/报价→下单”的实际环节分析；不存在的环节明确写“未体现”，禁止编造。
- user_consult_demands：只允许来自提供的评论，不得虚构评论。
视频简介文案：{{video_desc}}置顶+热门评论：{{comment_list}}视频资源链接：{{video_url}}`;

export interface ConversionResult {
  productImplantMethod: string;
  conversionPath: string;
  potentialConversionLevel: "高" | "中" | "低";
  userConsultDemands: string[];
  summary: string;
}

export async function analyzeConversionVideo(
  client: MiniMaxClient,
  payload: { desc: string; comments: string[]; url?: string },
): Promise<ConversionResult> {
  const comments = payload.comments?.length
    ? payload.comments.map((c, i) => `${i + 1}. ${c}`).join("\n")
    : "（无评论样本）";
  const user = `视频简介文案：${payload.desc || "（无简介）"}\n置顶+热门评论：${comments}\n视频资源：${payload.url ? "（视频已作为多模态输入附加，请结合画面与以上文案/评论分析）" : "（未提供直链，请基于文本分析）"}`;
  const r = await client.chatJson(CONVERSION_SYSTEM, user, payload.url);
  const level = ["高", "中", "低"].includes(r.potential_conversion_level)
    ? r.potential_conversion_level
    : "中";
  return {
    productImplantMethod: String(
      r.product_implant_method ?? r.productImplantMethod ?? "无植入",
    ),
    conversionPath: String(
      r.conversion_path ??
        r.conversionPath ??
        r.user_conversion_path ??
        r["用户转化路径"] ??
        "未体现完整转化路径",
    ),
    potentialConversionLevel: level as "高" | "中" | "低",
    userConsultDemands: Array.isArray(r.user_consult_demands)
      ? r.user_consult_demands.map(String)
      : [],
    summary: String(r.summary ?? ""),
  };
}

// ---------------------------------------------------------------------------
// 模块六：自身账号数据分析（纳入真实作品：高流量组 + 低流量组分别归因）
// ---------------------------------------------------------------------------
// 关键改进：除账号基础数据外，额外接收「高流量作品样本」与「低流量作品样本」
// （均含标题、文案摘要与真实播放/赞/评论/分享数据），让模型基于真实内容分别归因：
// 流量好的原因 + 流量差的原因，并配套可执行优化建议；同时显式约束「不得编造」，
// 与竞对账号分析（模块一）保持一致，从源头抑制幻觉。
const OWN_ACCOUNT_SYSTEM = `你是海外社媒账号运营顾问，擅长用真实数据复盘账号内容表现。输入包含：
① 账号基础数据（粉丝、作品数）；
② 该账号「高流量作品」样本（按播放量降序，含标题、文案摘要、真实播放/赞/评论/分享数据与标签）；
③ 该账号「低流量作品」样本（按播放量升序，含同样信息）。
请严格输出JSON格式，不要输出多余解释。输出字段：{
  "high_traffic_reason":"分析这些高流量作品为何表现好——必须逐条引用具体作品（标题/文案/数据）说明共同规律，如选题切入、开头钩子、情绪/实用价值、发布节奏、与账号定位契合度等，禁止留空",
  "low_traffic_reason":"分析这些低流量作品为何表现差——必须逐条引用具体作品（标题/文案/数据）说明共同问题，如选题平淡、开头不抓人、信息密度低、与账号定位偏差、形式单一等，禁止留空",
  "optimization_suggest":["针对低流量问题给出的可执行运营优化建议1","建议2","建议3","建议4"]
}
【重要约束】仅依据上方提供的真实作品内容与数据作答，不得编造任何未提供的播放量、互动量、数据、案例或作品内容；粉丝显示「未获取」时，禁止估算或引用粉丝数；
「高流量原因 / 低流量原因」必须结合具体作品样本给出，禁止留空、禁止 null、禁止省略；样本不足以判断某项时写「样本不足，无法判断」。`;

export interface OwnAccountAnalysis {
  highTrafficReason: string;
  lowTrafficReason: string;
  optimizationSuggest: string[];
}

export async function analyzeOwnAccount(
  client: MiniMaxClient,
  payload: {
    accountName: string;
    followers?: number;
    videoCount?: number;
    highTrafficWorks: OwnWorkSample[];
    lowTrafficWorks: OwnWorkSample[];
  },
): Promise<OwnAccountAnalysis> {
  const fmt = (ws: OwnWorkSample[], label: string) =>
    ws.length
      ? ws
          .map(
            (w, i) =>
              `作品${i + 1}【${w.title || w.caption?.slice(0, 40) || "（无标题）"}】播放 ${w.views.toLocaleString()} · 赞 ${w.likes.toLocaleString()} · 评论 ${w.comments.toLocaleString()} · 分享 ${w.shares.toLocaleString()} · 时长 ${w.durationSec ?? "?"}s · 标签 ${(w.tags || []).join("/") || "无"}\n文案摘要：${w.caption ? w.caption.slice(0, 150) : w.title || "（无文案）"}`,
          )
          .join("\n")
      : `（${label}：无样本）`;
  const followers =
    payload.followers == null
      ? "未获取（数据源未返回，禁止估算）"
      : payload.followers.toLocaleString();
  const user = `【账号基础数据】账号：${payload.accountName} · 粉丝：${followers} · 作品数：${payload.videoCount ?? "未知"}\n\n【高流量作品样本（按播放量降序 Top${payload.highTrafficWorks.length}）】\n${fmt(payload.highTrafficWorks, "高流量作品")}\n\n【低流量作品样本（按播放量升序）】\n${fmt(payload.lowTrafficWorks, "低流量作品")}`;
  const r = await client.chatJson(OWN_ACCOUNT_SYSTEM, user);
  // 字段别名兜底：兼容模型返回 key 的多种写法（snake_case / camelCase / 中文）
  const pickStr = (obj: any, keys: string[]): string => {
    for (const k of keys) {
      const v = obj?.[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  return {
    highTrafficReason:
      pickStr(r, [
        "high_traffic_reason",
        "highTrafficReason",
        "high_reason",
        "流量好原因",
        "高流量原因",
      ]) || "数据不足，无法判断",
    lowTrafficReason:
      pickStr(r, [
        "low_traffic_reason",
        "lowTrafficReason",
        "low_reason",
        "流量差原因",
        "低流量原因",
      ]) || "数据不足，无法判断",
    optimizationSuggest: Array.isArray(r.optimization_suggest)
      ? r.optimization_suggest.map(String)
      : Array.isArray(r.optimizationSuggest)
        ? r.optimizationSuggest.map(String)
        : [],
  };
}

// ---------------------------------------------------------------------------
// 模块三：热点 Tag 清洗与关联推荐（多模态文本分析）
// ---------------------------------------------------------------------------
const TAG_CLEAN_SYSTEM = `你是海外社媒热点分析师，输入是一批从社媒搜索结果提取出来的hashtag标签集合。任务：1.过滤与中国出境旅游无关噪声标签；2.为每一个有效tag给出简短主题描述；3.输出5个高度相关的关联推荐标签。输出严格JSON，禁止多余输出。输出格式：{
  "valid_tag_list":[
    {"tag_name":"","tag_topic_desc":""}
  ],
  "related_recommend_tags":["tag1","tag2","tag3","tag4","tag5"]
}
原始tag列表：{{raw_tag_list}}业务方向：面向海外用户的中国入境旅游内容`;

export interface TagCleanResult {
  validTagList: { tagName: string; tagTopicDesc: string }[];
  relatedRecommendTags: string[];
}

export async function cleanTags(
  client: MiniMaxClient,
  payload: { rawTags: string[]; business: string },
): Promise<TagCleanResult> {
  const user = `原始tag列表：${(payload.rawTags || []).join(", ") || "（空）"}\n业务方向：${payload.business || "面向海外用户的中国入境旅游内容"}`;
  const r = await client.chatJson(TAG_CLEAN_SYSTEM, user);
  const list = Array.isArray(r.valid_tag_list)
    ? r.valid_tag_list
        .map((t: any) => ({
          tagName: String(t?.tag_name ?? ""),
          tagTopicDesc: String(t?.tag_topic_desc ?? ""),
        }))
        .filter((t: { tagName: string }) => t.tagName)
    : [];
  const related = Array.isArray(r.related_recommend_tags)
    ? r.related_recommend_tags.map(String)
    : [];
  return { validTagList: list, relatedRecommendTags: related };
}

// ---------------------------------------------------------------------------
// 统一分发
// ---------------------------------------------------------------------------
export async function runAiTask(
  client: MiniMaxClient,
  task: AiTaskName,
  payload: any,
): Promise<any> {
  switch (task) {
    case "analyzeAccount":
      return analyzeAccount(client, payload);
    case "parseVideo":
      return parseVideo(client, payload);
    case "breakdownViralVideo":
      return breakdownViralVideo(client, payload);
    case "analyzeConversionVideo":
      return analyzeConversionVideo(client, payload);
    case "analyzeOwnAccount":
      return analyzeOwnAccount(client, payload);
    case "cleanTags":
      return cleanTags(client, payload);
    case "analyzeImage":
      return analyzeImage(client, payload);
    case "inferImageSize":
      return inferImageSize(client, payload);
    default:
      throw new Error(`未知 AI 任务：${task}`);
  }
}
