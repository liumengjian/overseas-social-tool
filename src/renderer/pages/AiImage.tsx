import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Spinner } from "../components/ui";
import ImageViewer from "../components/ImageViewer";
import type { AppConfig } from "../../shared/types";
import { IMAGE_MAX_EDGE, clampImageSize } from "../../shared/image-size";
import type {
  GeneratedImage,
  ImageTemplate,
  ImageTemplateCategory,
} from "../../shared/ipc";
import { useWorkflow } from "../workflowStore";

type ChatImage = GeneratedImage & {
  id: string;
  prompt: string;
  references?: TemplateImage[];
  pending?: boolean;
  error?: string;
  // 聊天区展示用缩略图；原图不在内存里（复制 / 下载 / 局部修改时按 id 回磁盘取）
  thumb?: string;
};
type TemplateImage = { name: string; dataUrl: string };
type Selection = { x: number; y: number; width: number; height: number };
type LocalEditTarget = { image: ChatImage; index: number };
type TemplateCreateInput = {
  imageDataUrl: string;
  imageFileName?: string;
  title: string;
  description: string;
  categoryId: string;
  aspectRatio: string;
};
type TemplateUpdateInput = {
  id: string;
  title: string;
  description: string;
  categoryId: string;
  imageDataUrl?: string;
  imageFileName?: string;
  aspectRatio?: string;
};
// 聊天记录一次只取最近 10 条，向上滚动再按 10 条继续取更早的记录。
const IMAGE_HISTORY_PAGE_SIZE = 10;
// 距离顶部不足该距离时视为“已经滑到顶”，触发加载下一页历史。
const CHAT_LOAD_EARLIER_THRESHOLD = 80;
// 距离底部在这之内视为“仍停在最新消息处”，内容变高时继续贴住底部。
const CHAT_STICK_BOTTOM_SLACK = 80;
// 连续生成而不刷新页面时，内存里最多保留最近 20 条；更早的从内存丢掉，
// 它们仍在磁盘上，会重新变成「上滑可取」的历史。
const MAX_CHAT_TURNS = 20;
const IMAGE_PROMPT_POLISH_SYSTEM =
  "你是 AI 图片生成提示词专家。理解用户输入后，完成润色和扩写，输出可直接交给图片生成模型的完整提示词。必须保留用户明确指定的主体、文字内容、语言、风格、构图、比例、颜色和限制，不能擅自改变需求。根据用户意图动态组织内容，不要套用固定模板：需要海报/营销物料时，补全合理的画面分区、文案层级和排版要求；需要人物、产品、场景、插画或摄影作品时，补全主体特征、环境、构图、镜头/视角、光影、色彩、材质和关键细节。只有用户要求或明显需要画面文字时，才补充文字区块；文字按所需语言给出，若有中英文需求则分别标明中文和 English。不要虚构品牌、价格、地点、人物或文字内容。使用清晰的 Markdown 分区和标签输出，方便图片模型理解；只输出扩写后的生图提示词，不要解释润色过程。";
const TEMPLATE_LOCK_RULES = [
  "【模板锁定规则】",
  "1. 海报全部组件默认锁定：凡是没有在下方“需要修改的模块列表”中写明的元素，包括 logo、图形、图标、色块、边框、普通文字、装饰，位置、尺寸、角度、颜色、间距、层级完全固定，禁止移动、旋转、缩放、新增、删除、重排，禁止重新设计海报版式。",
  "2. 只可以修改下方明确列出的模块，不在列表内，一律不得改动。",
  "3. 如果修改的是文字模块：只替换文字内容，字体、字号、颜色、对齐、文字框坐标完全不变，严禁移动文字框。",
  "4. 如果修改的是图片/图形模块：仅替换该模块内部画面，模块本身的外框大小、摆放位置、边框样式不能改变。",
  "5. 输出图片的像素宽度、像素高度、宽高比必须与模板原图完全一致，禁止改变输出尺寸、裁切、补边或拉伸。",
  "6. 画布宽高比例、整体构图和模板完全一致，禁止自主美化、重构海报。",
  "7. 模板原图中的所有文字、图片、图形和其他具体内容都必须全部替换，不得原样保留任何一个元素；只保留模板的版式结构、区域划分、层级关系、对齐方式和整体布局信息。",
  "8. 生成时必须先识别并清空模板中的原有内容，再根据用户要求填充全新的文字、图片和图形；如果用户没有提供替换内容，也不得复制模板原内容，应使用合理的新内容或留白。",
  "需要修改的模块列表：以下用户明确提出的修改内容。未明确列出的模块全部保持不变。",
].join("\n");

// 原图（复制、下载、查看大图、局部修改必须用它，不能给缩略图）。
function imageSrc(image: GeneratedImage): string {
  if (image.url) return image.url;
  return `data:${image.contentType || "image/png"};base64,${image.b64 || ""}`;
}

// 聊天区展示用：优先缩略图，其次远程 URL，最后才是内存里的原图。
function displaySrc(image: GeneratedImage & { thumb?: string }): string {
  return image.thumb || imageSrc(image);
}

// 按需取原图：内存里只剩缩略图时，回磁盘读这条记录的完整数据。
async function originalSrc(image: ChatImage): Promise<string> {
  if (image.url) return image.url;
  if (image.b64) return imageSrc(image);
  const turn = await window.api.getImageHistoryTurn({ id: image.id });
  if (turn?.url) return turn.url;
  if (turn?.b64)
    return `data:${turn.contentType || "image/png"};base64,${turn.b64}`;
  throw new Error("原图读取失败：磁盘上找不到这条记录");
}

function toImageInput(image: GeneratedImage) {
  return image.url ? { url: image.url } : { dataUrl: imageSrc(image) };
}

function buildMask(
  width: number,
  height: number,
  selections: Selection[],
  transparentSelection: boolean,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建局部编辑蒙版");
  context.fillStyle = transparentSelection ? "#ffffff" : "#000000";
  context.fillRect(0, 0, width, height);
  selections.forEach(
    ({ x, y, width: selectionWidth, height: selectionHeight }) => {
      const left = x * width;
      const top = y * height;
      const selectionWidthPx = selectionWidth * width;
      const selectionHeightPx = selectionHeight * height;
      if (transparentSelection)
        context.clearRect(left, top, selectionWidthPx, selectionHeightPx);
      else {
        context.fillStyle = "#ffffff";
        context.fillRect(left, top, selectionWidthPx, selectionHeightPx);
      }
    },
  );
  return canvas.toDataURL("image/png");
}

async function loadCanvasImage(source: string): Promise<HTMLImageElement> {
  let imageSource = source;
  let objectUrl = "";
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok)
      throw new Error(`图片下载失败（HTTP ${response.status}）`);
    objectUrl = URL.createObjectURL(await response.blob());
    imageSource = objectUrl;
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      reject(new Error("无法读取图片，不能合成局部修改结果"));
    };
    image.src = imageSource;
  });
}

async function keepOnlySelectedPixels(
  source: string,
  generated: GeneratedImage,
  selections: Selection[],
): Promise<GeneratedImage> {
  const [original, edited] = await Promise.all([
    loadCanvasImage(source),
    loadCanvasImage(imageSrc(generated)),
  ]);
  const width = original.naturalWidth;
  const height = original.naturalHeight;
  if (!width || !height) throw new Error("原图尺寸无效，不能合成局部修改结果");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建局部修改结果画布");
  context.drawImage(original, 0, 0, width, height);
  context.save();
  context.beginPath();
  selections.forEach(
    ({ x, y, width: selectionWidth, height: selectionHeight }) => {
      context.rect(
        x * width,
        y * height,
        selectionWidth * width,
        selectionHeight * height,
      );
    },
  );
  context.clip();
  context.drawImage(edited, 0, 0, width, height);
  context.restore();
  const dataUrl = canvas.toDataURL("image/png");
  return { contentType: "image/png", b64: dataUrl.split(",", 2)[1] };
}

function isChatImage(value: unknown): value is ChatImage {
  if (!value || typeof value !== "object") return false;
  const image = value as Record<string, unknown>;
  return (
    typeof image.id === "string" &&
    typeof image.prompt === "string" &&
    (typeof image.url === "string" ||
      typeof image.b64 === "string" ||
      // 历史记录只回传缩略图（原图留在磁盘），这类记录同样要能展示。
      typeof image.thumb === "string" ||
      image.pending === true ||
      typeof image.error === "string")
  );
}

function findChatTurn(scroll: HTMLElement, id: string): HTMLElement | null {
  const turns = scroll.querySelectorAll<HTMLElement>("[data-turn-id]");
  for (const turn of turns) if (turn.dataset.turnId === id) return turn;
  return null;
}

function chatTurnTop(scroll: HTMLElement, id: string): number | null {
  const turn = findChatTurn(scroll, id);
  if (!turn) return null;
  return turn.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
}

// 更早的记录插到列表顶部后，以一条既有消息为锚点把滚动位置修正回来，
// 保证用户正在看的消息停在原处；图片异步解码后高度继续变化时同样适用。
function keepChatScrollAnchor(
  scroll: HTMLElement,
  anchor: { id: string; top: number },
): void {
  const current = chatTurnTop(scroll, anchor.id);
  if (current === null) return;
  const delta = current - anchor.top;
  if (Math.abs(delta) > 0.5) scroll.scrollTop += delta;
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function imageDimensions(
  dataUrl: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () =>
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("无法读取模板图片尺寸"));
    image.src = dataUrl;
  });
}

function formatAspectRatio(width: number, height: number): string {
  let a = width;
  let b = height;
  while (b) [a, b] = [b, a % b];
  return a ? `${width / a}:${height / a}` : "1:1";
}

function templatePrompt(
  template: ImageTemplate,
  detail: string,
  dimensions?: { width: number; height: number },
): string {
  const size = dimensions
    ? `模板原图像素尺寸：${dimensions.width} x ${dimensions.height}px；输出必须严格为 ${dimensions.width} x ${dimensions.height}px。`
    : "模板原图像素尺寸：以上传的模板原图为准；输出必须严格使用模板原图的像素宽度和高度。";
  return [
    "【模板生成系统规则】这是模板生成任务，尺寸约束优先级高于其他要求。",
    `请严格基于「${template.title}」模板进行图片编辑，输出一张与模板画布比例、整体构图和版式完全一致的海报。`,
    `模板说明：${template.description}。`,
    `模板画面比例：${template.aspectRatio}。${size}除用户明确要求修改的模块外，不得复制或改动模板中的任何内容。`,
    detail.trim()
      ? `需要修改的模块列表：${detail.trim()}。`
      : "需要修改的模块列表：暂无明确修改项，请完整保留模板。",
    TEMPLATE_LOCK_RULES,
  ].join("\n");
}

export default function AiImage({ active = true }: { active?: boolean }) {
  const [tab, setTab] = useState<"chat" | "templates">("chat");
  const [generationMode, setGenerationMode] = useState<"free" | "template">(
    "free",
  );
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState<TemplateImage[]>([]);
  const [templates, setTemplates] = useState<ImageTemplate[]>([]);
  const [categories, setCategories] = useState<ImageTemplateCategory[]>([]);
  const [selectedTemplate, setSelectedTemplate] =
    useState<ImageTemplate | null>(null);
  const [images, setImages] = useState<ChatImage[]>([]);
  // 历史记录改成「索引 + 每条一个文件」的分片存储：只把当前已加载的条数放在状态里。
  // historyTotal = 存储中的总条数；historyOffset = 已经从存储取出的条数（距末尾的偏移）。
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [earlierLoading, setEarlierLoading] = useState(false);
  const [viewerSrc, setViewerSrc] = useState<{
    src: string;
    alt?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [error, setError] = useState("");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedTemplateDimensions, setSelectedTemplateDimensions] = useState<
    { width: number; height: number } | undefined
  >();
  const [localEditTarget, setLocalEditTarget] =
    useState<LocalEditTarget | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  // 右键点自己发的图片时的菜单（只复制这一张）。
  const [referenceMenu, setReferenceMenu] = useState<{
    left: number;
    top: number;
    reference: TemplateImage;
  } | null>(null);
  const referenceMenuRef = useRef<HTMLDivElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  // 懒加载更早记录时用于固定阅读位置的锚点；为空表示不做位置修正。
  const prependAnchorRef = useRef<{ id: string; top: number } | null>(null);
  // 打开页面停留在最新消息处；图片陆续解码时继续贴住底部，不往上跑。
  const stickToBottomRef = useRef(true);
  const loadingEarlierRef = useRef(false);
  const pipe = useWorkflow("AI生图");

  // 已加载记录在整份历史中的起始序号（用于下载文件名等）
  const visibleStart = Math.max(historyTotal - historyOffset, 0);
  const hasEarlierImages = visibleStart > 0;
  // 异步取页时回调里要读最新偏移，用 ref 转发。
  const historyOffsetRef = useRef(0);
  historyOffsetRef.current = historyOffset;

  function beginLoadEarlier(scroll: HTMLDivElement) {
    if (loadingEarlierRef.current || !hasEarlierImages) return;
    const anchorId = images[0]?.id;
    const anchorTop = anchorId ? chatTurnTop(scroll, anchorId) : null;
    prependAnchorRef.current =
      anchorId && anchorTop !== null ? { id: anchorId, top: anchorTop } : null;
    loadingEarlierRef.current = true;
    setEarlierLoading(true);
    void window.api
      .getImageHistoryPage({
        offset: historyOffsetRef.current,
        limit: IMAGE_HISTORY_PAGE_SIZE,
      })
      .then((page) => {
        setHistoryTotal(page.total);
        setHistoryOffset(page.nextOffset);
        if (page.turns.length) {
          setImages((previous) => {
            const known = new Set(previous.map((item) => item.id));
            const prepended = page.turns
              .filter(isChatImage)
              .filter((turn) => !known.has(turn.id));
            return prepended.length ? [...prepended, ...previous] : previous;
          });
          return;
        }
        // 存储里已经没有更早的记录（或对应文件缺失）：结束提示，避免一直显示可加载。
        loadingEarlierRef.current = false;
        setEarlierLoading(false);
      })
      .catch((cause: unknown) => {
        loadingEarlierRef.current = false;
        setEarlierLoading(false);
        setError(
          `加载更早的记录失败：${cause instanceof Error ? cause.message : String(cause)}`,
        );
      });
  }

  // 只把本次新增的记录追加到分片存储：不再每次保存都把整份历史重新序列化。
  function persistImageTurns(turns: ChatImage[]) {
    if (!turns.length) return;
    void window.api
      .saveImageHistoryTurns({ turns })
      .then((result) => {
        // 新记录追加到末尾：总数变多，同时把已取偏移往前推等量，保持阅读位置序号不变。
        setHistoryTotal(result.total);
        setHistoryOffset((offset) => offset + result.added);
        // 原图已经落盘：内存里换成缩略图，连续生成时内存不再随图片张数无限增长
        // （复制、下载、查看大图、局部修改会按 id 重新读原图）。
        const thumbs = new Map<string, string>();
        for (const item of result.saved ?? []) {
          if (item.thumb) thumbs.set(item.id, item.thumb);
        }
        if (thumbs.size) {
          setImages((previous) =>
            previous.map((item) => {
              const thumb = thumbs.get(item.id);
              return thumb ? { ...item, thumb, b64: undefined } : item;
            }),
          );
        }
      })
      .catch((cause: unknown) => {
        setError(
          `保存聊天记录失败：${cause instanceof Error ? cause.message : String(cause)}`,
        );
      });
  }

  function handleChatScroll(event: React.UIEvent<HTMLDivElement>) {
    const scroll = event.currentTarget;
    // 离开底部就解除“贴住最新消息”，由用户决定看哪里。
    if (
      scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight >
      CHAT_STICK_BOTTOM_SLACK
    )
      stickToBottomRef.current = false;
    if (scroll.scrollTop > CHAT_LOAD_EARLIER_THRESHOLD) {
      // 已经离开顶部，解除本轮的加载锁，下次滑到顶可以继续补页。
      loadingEarlierRef.current = false;
      return;
    }
    // 一页内容撑不满可视区时由 ResizeObserver 补页，这里不重复触发。
    if (stickToBottomRef.current) return;
    beginLoadEarlier(scroll);
  }

  // ResizeObserver 里的回调拿不到最新闭包，用 ref 转发一页未撑满屏幕时的补页判定。
  const fillViewportRef = useRef<() => void>(() => {});
  fillViewportRef.current = () => {
    const scroll = chatRef.current;
    if (!scroll || !hasEarlierImages) return;
    // 一页内容还撑不满可视区时没有滚动条，用户无法“上滑”，需要继续补页。
    if (scroll.scrollHeight - scroll.clientHeight > 4) return;
    beginLoadEarlier(scroll);
  };

  async function loadTemplateLibrary() {
    const [nextTemplates, nextCategories] = await Promise.all([
      window.api.listImageTemplates(),
      window.api.listImageTemplateCategories(),
    ]);
    setTemplates(nextTemplates);
    setCategories(nextCategories);
  }

  useEffect(() => {
    let alive = true;
    void loadTemplateLibrary().catch((cause: unknown) => {
      if (alive)
        setError(
          `加载模板库失败：${cause instanceof Error ? cause.message : String(cause)}`,
        );
    });
    // 首屏只取最近一页（10 条）；更早的记录在用户上滑时按页从主进程取。
    void window.api
      .getImageHistoryPage({ offset: 0, limit: IMAGE_HISTORY_PAGE_SIZE })
      .then((page) => {
        if (!alive) return;
        setHistoryTotal(page.total);
        setHistoryOffset(page.nextOffset);
        setImages(page.turns.filter(isChatImage));
      })
      .catch((cause: unknown) => {
        if (alive)
          setError(
            `加载聊天记录失败：${cause instanceof Error ? cause.message : String(cause)}`,
          );
      })
      .finally(() => {
        if (alive) {
          setHistoryLoading(false);
          requestAnimationFrame(() => {
            if (chatRef.current)
              chatRef.current.scrollTop = chatRef.current.scrollHeight;
          });
        }
      });
    void window.api
      .getConfig()
      .then((value) => {
        setConfig(value);
        setSelectedModel(
          value.imageModels?.[0]?.name ?? value.imageModel ?? "",
        );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedTemplate) {
      setSelectedTemplateDimensions(undefined);
      return;
    }
    let alive = true;
    void imageDimensions(selectedTemplate.imageDataUrl)
      .then((dimensions) => {
        if (alive) setSelectedTemplateDimensions(dimensions);
      })
      .catch(() => {
        if (alive) setSelectedTemplateDimensions(undefined);
      });
    return () => {
      alive = false;
    };
  }, [selectedTemplate]);

  // 只在「最新一条记录」变化时回到底部。向上懒加载是往前插入更早的记录，
  // 最新一条不变，因此不能把用户从历史位置拉回底部。
  const newestTurnId = images.length ? images[images.length - 1].id : "";
  useEffect(() => {
    if (!active || tab !== "chat") return;
    // The page stays mounted while hidden, so wait for it to become visible
    // before measuring scrollHeight and moving to the newest message.
    // 主动回到底部后，之前懒加载更早记录用的锚点就失效了，清掉避免它把位置拉回去。
    const frame = window.requestAnimationFrame(() => {
      const scroll = chatRef.current;
      if (!scroll) return;
      prependAnchorRef.current = null;
      stickToBottomRef.current = true;
      scroll.scrollTo({ top: scroll.scrollHeight, behavior: "auto" });
      window.requestAnimationFrame(() => {
        if (chatRef.current)
          chatRef.current.scrollTop = chatRef.current.scrollHeight;
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, tab, newestTurnId, busy]);

  // 连续生成不刷新页面时，内存里最多保留最近 MAX_CHAT_TURNS 条：
  // 超出的从内存丢掉，磁盘上仍在，会重新变成「上滑可取」的更早记录。
  // 只在仍停在最新消息处时裁剪，避免用户正翻看旧记录时内容被抽走。
  useEffect(() => {
    const overflow = images.length - MAX_CHAT_TURNS;
    if (overflow <= 0 || !stickToBottomRef.current) return;
    // 可视区还没被内容填满时（极短的历史）不裁剪，否则会和「补页撑满视口」互相拉扯。
    const scroll = chatRef.current;
    if (scroll && scroll.scrollHeight <= scroll.clientHeight) return;
    setImages((previous) => previous.slice(overflow));
    setHistoryOffset((offset) => Math.max(offset - overflow, 0));
  }, [images.length]);

  // 更早的记录插入顶部后重新校正一次滚动位置（首帧）；解码较慢的图片由
  // 下方的 ResizeObserver 继续处理。
  useLayoutEffect(() => {
    const scroll = chatRef.current;
    if (scroll && prependAnchorRef.current)
      keepChatScrollAnchor(scroll, prependAnchorRef.current);
    loadingEarlierRef.current = false;
    setEarlierLoading(false);
  }, [visibleStart]);

  // 图片是异步解码的，加载完成后上方内容会继续变高；高度一变就补一次位置修正，
  // 顺带处理“一页内容撑不满可视区、没有滚动条可上滑”的情况。
  useEffect(() => {
    const messages = messagesRef.current;
    if (!messages || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const scroll = chatRef.current;
      if (!scroll) return;
      if (prependAnchorRef.current) {
        // 图片解码是成批的，一次可能顶上来好几屏；必须按锚点如实补足，
        // 不能因为偏移看起来很大就放弃，否则用户会看到内容整体上跳。
        keepChatScrollAnchor(scroll, prependAnchorRef.current);
      } else if (stickToBottomRef.current) {
        // 仍停在最新消息处时，上方内容变高要继续贴住底部。
        const distance =
          scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
        if (distance > CHAT_STICK_BOTTOM_SLACK)
          stickToBottomRef.current = false;
        else scroll.scrollTop = scroll.scrollHeight;
      }
      fillViewportRef.current();
    });
    observer.observe(messages);
    return () => observer.disconnect();
  }, []);

  const promptWithTemplate = useMemo(() => {
    if (generationMode !== "template" || !selectedTemplate)
      return prompt.trim();
    return templatePrompt(selectedTemplate, prompt, selectedTemplateDimensions);
  }, [prompt, selectedTemplate, selectedTemplateDimensions, generationMode]);

  function submit() {
    if (busy) return;
    if (generationMode === "template" && !selectedTemplate) {
      setError("请先到模板库选择一个模板");
      setTab("templates");
      return;
    }
    if (!promptWithTemplate) {
      setError("请输入图片描述，或先选择一个模板");
      return;
    }
    // 与消息文本一致：发送后立即清空本次请求的参考图，避免附件继续显示在输入框上。
    // 先固定本次提交使用的引用，异步任务中仍使用同一批附件。
    const submittedReferences = references;
    const submittedTemplate = selectedTemplate;
    const submittedPrompt = promptWithTemplate;
    // 发送前立即清空输入框，避免请求期间旧消息仍停留在编辑区。
    setPrompt("");
    setReferences([]);
    setSelectedTemplate(null);
    setGenerationMode("free");
    const turnId = `${Date.now()}-pending`;
    setImages((previous) => [
      ...previous,
      {
        id: turnId,
        prompt: submittedPrompt,
        references: submittedReferences,
        pending: true,
      } as ChatImage,
    ]);
    requestAnimationFrame(() => {
      const textarea =
        document.querySelector<HTMLTextAreaElement>(".ai-chat-prompt");
      if (textarea) {
        textarea.style.height = "38px";
        textarea.style.overflowY = "hidden";
      }
    });
    pipe.enqueue(
      submittedReferences.length ? "参考图生成" : "文生图生成",
      async (runId, signal) => {
        setBusy(true);
        setError("");
        try {
          const model =
            config?.imageModels?.find((item) => item.name === selectedModel) ??
            config?.imageModels?.[0];
          const maxResolution =
            model?.resolution ?? config?.imageMaxResolution ?? "1k";
          // 4K 档位按网关的硬上限 3840 取「最大边」参考值：取 4096 会被
          // 「width and height must not exceed 3840」直接拒绝；
          // 最终发出的尺寸还要过 clampImageSize（16 的倍数 + 总像素区间）。
          const maxPixels =
            maxResolution === "4k"
              ? IMAGE_MAX_EDGE
              : maxResolution === "2k"
                ? 2048
                : 1024;
          const baseSize = `${maxPixels}x${maxPixels}`;
          // 推断失败时的兜底尺寸同样必须先收敛（4K 的 3840×3840 总像素已超上限）。
          let inferredSize = clampImageSize(baseSize, "1024x1024");
          try {
            const inferred = await window.api.runAiTask({
              task: "inferImageSize",
              payload: { prompt: submittedPrompt, baseSize },
              runId,
            });
            // 推断结果同样收敛到网关约束内，避免模型给出超大尺寸。
            if (inferred?.size)
              inferredSize = clampImageSize(inferred.size, inferredSize);
          } catch {
            /* 尺寸推断失败时使用模型默认尺寸 */
          }
          const templateReference =
            generationMode === "template" && submittedTemplate
              ? [{ dataUrl: submittedTemplate.imageDataUrl }]
              : [];
          const allReferences = [
            ...templateReference,
            ...submittedReferences.map((item) => ({ dataUrl: item.dataUrl })),
          ];
          // 带参考图/模板编辑时，输出尺寸要跟输入图一致：用户没有要求改尺寸，
          // 就不能用档位推断尺寸去替换它。这里按输入图自身宽高取尺寸，
          // 并收敛到网关允许的范围（16 的倍数、单边 ≤3840、总像素区间）。
          let requestSize = inferredSize;
          const sizeReference = allReferences[0]?.dataUrl;
          if (sizeReference) {
            try {
              const dimensions = await imageDimensions(sizeReference);
              if (signal.aborted) return;
              requestSize = clampImageSize(
                `${dimensions.width}x${dimensions.height}`,
                inferredSize,
              );
            } catch {
              /* 读不出输入图尺寸时退回档位推断尺寸 */
            }
          }
          const generated = allReferences.length
            ? await window.api.editImage({
                prompt: submittedPrompt,
                images: allReferences,
                size: requestSize,
                model,
                runId,
              })
            : await window.api.generateImage({
                prompt: submittedPrompt,
                size: requestSize,
                model,
                runId,
              });
          if (signal.aborted) return;
          // 在更新状态之前先算出本次新增的记录：保存只追加它们，避免副作用进 updater。
          const completed = generated.map((image, index) => ({
            ...image,
            id: `${Date.now()}-${index}`,
            prompt: submittedPrompt,
            references: submittedReferences,
          }));
          setImages((previous) => {
            const at = previous.findIndex((item) => item.id === turnId);
            return at >= 0
              ? [
                  ...previous.slice(0, at),
                  ...completed,
                  ...previous.slice(at + 1),
                ]
              : [...previous, ...completed];
          });
          persistImageTurns(completed);
        } catch (cause: unknown) {
          if (signal.aborted) return;
          const message =
            cause instanceof Error ? cause.message : String(cause);
          setImages((previous) =>
            previous.map((item) =>
              item.id === turnId
                ? { ...item, pending: false, error: message }
                : item,
            ),
          );
          throw cause;
        } finally {
          setBusy(false);
        }
      },
    );
  }

  async function polishPrompt() {
    const source = prompt.trim();
    if (!source || polishing || busy) return;
    setPolishing(true);
    setError("");
    try {
      const polished = await window.api.generateSopReply({
        question: source,
        systemPrompt: IMAGE_PROMPT_POLISH_SYSTEM,
      });
      if (polished.trim()) {
        setPrompt(polished.trim());
        requestAnimationFrame(() => resizePromptTextarea());
      }
    } catch (cause: unknown) {
      setError(`AI 润色失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setPolishing(false);
    }
  }

  function regenerate(image: ChatImage) {
    pipe.enqueue("重新生成图片", async (runId, signal) => {
      setBusy(true);
      setError("");
      try {
        const model =
          config?.imageModels?.find((item) => item.name === selectedModel) ??
          config?.imageModels?.[0];
        const generated = await window.api.generateImage({
          prompt: image.prompt,
          model,
          runId,
        });
        if (signal.aborted) return;
        const appended = generated.map((item, index) => ({
          ...item,
          id: `${Date.now()}-${index}`,
          prompt: image.prompt,
          references: image.references,
        }));
        setImages((previous) => [...previous, ...appended]);
        persistImageTurns(appended);
      } catch (cause: unknown) {
        if (signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      } finally {
        setBusy(false);
      }
    });
  }

  function submitLocalEdit(
    target: ChatImage,
    selections: Selection[],
    detail: string,
  ) {
    if (!selections.length) {
      setError("请先框选至少一个需要修改的区域");
      return;
    }
    const promptForEdit = detail.trim();
    if (!promptForEdit) {
      setError("请描述选中区域需要修改成什么");
      return;
    }
    const source = imageSrc(target);
    const probe = new Image();
    probe.onload = () => {
      const useTransparentSelection =
        config?.imageEditStyle === "images" ||
        (config?.imageEditStyle === "auto" &&
          config?.imageApiFormat === "openai");
      const mask = buildMask(
        probe.naturalWidth,
        probe.naturalHeight,
        selections,
        useTransparentSelection,
      );
      setLocalEditTarget(null);
      pipe.enqueue("局部修改图片", async (runId, signal) => {
        setBusy(true);
        setError("");
        try {
          const model =
            config?.imageModels?.find((item) => item.name === selectedModel) ??
            config?.imageModels?.[0];
          const generated = await window.api.editImage({
            prompt: promptForEdit,
            images: [toImageInput(target)],
            mask: { dataUrl: mask },
            model,
            runId,
          });
          if (signal.aborted) return;
          // 模型可能在蒙版外产生轻微漂移。以原图为底，只合成框选矩形内的结果，
          // 从最终输出层面保证未选区域（包括另一个人）完全保持原样。
          const protectedGenerated = await Promise.all(
            generated.map((item) =>
              keepOnlySelectedPixels(source, item, selections),
            ),
          );
          if (signal.aborted) return;
          const appended = protectedGenerated.map((item, index) => ({
            ...item,
            id: `${Date.now()}-${index}`,
            prompt: `局部修改：${promptForEdit}`,
            references: target.references,
          }));
          setImages((previous) => [...previous, ...appended]);
          persistImageTurns(appended);
        } catch (cause: unknown) {
          if (signal.aborted) return;
          setError(cause instanceof Error ? cause.message : String(cause));
          throw cause;
        } finally {
          setBusy(false);
        }
      });
    };
    probe.onerror = () => setError("无法读取原图尺寸，不能创建局部编辑蒙版");
    probe.src = source;
  }

  async function download(image: ChatImage, index: number) {
    try {
      // 下载的是原图，不是聊天区那张缩略图。
      const src = await originalSrc(image);
      const anchor = document.createElement("a");
      anchor.href = src;
      anchor.download = `ai-image-${index + 1}.${(image.contentType || "image/png").split("/")[1] || "png"}`;
      anchor.click();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // 右键菜单：点外部、Esc、滚动、窗口尺寸变化都关掉，避免菜单停在错误位置。
  useEffect(() => {
    if (!referenceMenu) return;
    const closeIfOutside = (event: Event) => {
      if (
        event.type === "pointerdown" &&
        referenceMenuRef.current?.contains(event.target as Node)
      )
        return;
      setReferenceMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReferenceMenu(null);
    };
    // 键盘触发的右键菜单也要能直接操作。
    referenceMenuRef.current?.querySelector("button")?.focus();
    const chat = chatRef.current;
    window.addEventListener("pointerdown", closeIfOutside);
    window.addEventListener("resize", closeIfOutside);
    window.addEventListener("keydown", closeOnEscape);
    chat?.addEventListener("scroll", closeIfOutside, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", closeIfOutside);
      window.removeEventListener("resize", closeIfOutside);
      window.removeEventListener("keydown", closeOnEscape);
      chat?.removeEventListener("scroll", closeIfOutside);
    };
  }, [referenceMenu]);

  function flashCopyStatus(status: string) {
    setCopyStatus(status);
    window.setTimeout(() => setCopyStatus(""), 2200);
  }

  // 参考图是任意格式的 dataURL，而剪贴板里可靠的图片格式只有 png，先统一转成 png。
  function dataUrlToPngBlob(dataUrl: string): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("无法创建画布"));
          return;
        }
        context.drawImage(image, 0, 0);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("图片转换失败"))),
          "image/png",
        );
      };
      image.onerror = () => reject(new Error("无法读取图片"));
      image.src = dataUrl;
    });
  }

  // 悬浮在消息上的按钮只复制图片：系统剪贴板一次粘贴只能落一种格式，
  // 文字和图片放进同一次写入必然互相抢（用户两次实测都只落了一种），
  // 所以这里明确只写图片；只想要文字时用鼠标选中文字复制即可。
  async function copyUserMessageImage(image: ChatImage) {
    const references = image.references ?? [];
    if (!references.length) {
      flashCopyStatus("这条消息没有图片");
      return;
    }
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      try {
        await navigator.clipboard.writeText(references[0].dataUrl);
        flashCopyStatus("图片地址已复制");
      } catch {
        flashCopyStatus("复制失败，请右键另存");
      }
      return;
    }
    const pngBlobs: Blob[] = [];
    for (const reference of references) {
      try {
        pngBlobs.push(await dataUrlToPngBlob(reference.dataUrl));
      } catch {
        /* 单张读取失败先跳过，剩下的还能复制 */
      }
    }
    if (!pngBlobs.length) {
      flashCopyStatus("图片读取失败，请右键另存");
      return;
    }
    try {
      await navigator.clipboard.write(
        pngBlobs.map((blob) => new ClipboardItem({ "image/png": blob })),
      );
      flashCopyStatus(
        pngBlobs.length > 1 ? `已复制 ${pngBlobs.length} 张图片` : "图片已复制",
      );
      return;
    } catch {
      /* 多张一起写不一定被支持，退成只写第一张 */
    }
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": pngBlobs[0] }),
      ]);
      flashCopyStatus(
        pngBlobs.length > 1
          ? `已复制第 1 张图片（共 ${pngBlobs.length} 张）`
          : "图片已复制",
      );
    } catch {
      try {
        await navigator.clipboard.writeText(references[0].dataUrl);
        flashCopyStatus("图片地址已复制");
      } catch {
        flashCopyStatus("复制失败，请右键另存");
      }
    }
  }

  // 右键菜单里单独复制某一张自己发的图片。
  async function copyReferenceImage(reference: TemplateImage) {
    try {
      const blob = await dataUrlToPngBlob(reference.dataUrl);
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
        throw new Error("当前环境不支持图片剪贴板");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flashCopyStatus("图片已复制");
    } catch {
      try {
        await navigator.clipboard.writeText(reference.dataUrl);
        flashCopyStatus("图片地址已复制");
      } catch {
        flashCopyStatus("复制失败，请手动下载");
      }
    }
  }

  async function copyImage(image: ChatImage) {
    let source = "";
    try {
      // 复制到剪贴板的必须是原图，不能用缩略图。
      source = await originalSrc(image);
      const response = await fetch(source);
      const blob = await response.blob();
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
        throw new Error("当前环境不支持图片剪贴板");
      await navigator.clipboard.write([
        new ClipboardItem({
          [blob.type || image.contentType || "image/png"]: blob,
        }),
      ]);
      setCopyStatus("图片已复制");
    } catch {
      try {
        await navigator.clipboard.writeText(source || image.url || imageSrc(image));
        setCopyStatus("图片地址已复制");
      } catch {
        setCopyStatus("复制失败，请手动下载");
      }
    }
    window.setTimeout(() => setCopyStatus(""), 2200);
  }

  // 局部修改的蒙版必须按原图尺寸生成，所以进入选区前先把原图取回来。
  async function beginLocalEdit(image: ChatImage, index: number) {
    try {
      let withOriginal = image;
      if (!image.b64 && !image.url) {
        const turn = await window.api.getImageHistoryTurn({ id: image.id });
        if (turn?.b64)
          withOriginal = {
            ...image,
            b64: turn.b64,
            contentType: turn.contentType || image.contentType,
          };
        else if (turn?.url) withOriginal = { ...image, url: turn.url };
        else throw new Error("原图读取失败：磁盘上找不到这条记录");
      }
      setLocalEditTarget({ image: withOriginal, index });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // 查看大图也用原图：缩略图放大没有意义。
  async function openViewer(image: ChatImage) {
    try {
      setViewerSrc({ src: await originalSrc(image), alt: image.prompt });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function resizePromptTextarea(textarea?: HTMLTextAreaElement | null) {
    const target =
      textarea ?? document.querySelector<HTMLTextAreaElement>(".ai-chat-prompt");
    if (!target) return;
    target.style.height = "auto";
    target.style.height = `${Math.min(target.scrollHeight, 150)}px`;
    target.style.overflowY = target.scrollHeight > 150 ? "auto" : "hidden";
  }

  function changePrompt(event: React.ChangeEvent<HTMLTextAreaElement>) {
    setPrompt(event.target.value);
    resizePromptTextarea(event.currentTarget);
  }

  async function addReferenceFiles(files: File[]) {
    if (!files.length) return;
    try {
      const next = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          dataUrl: await readFile(file),
        })),
      );
      setReferences((previous) => [...previous, ...next]);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function chooseReference(event: React.ChangeEvent<HTMLInputElement>) {
    await addReferenceFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function pasteReference(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
      .map((file, index) =>
        file.name
          ? file
          : new File(
              [file],
              `clipboard-image-${Date.now()}-${index}.${file.type.split("/")[1] || "png"}`,
              { type: file.type },
            ),
      );
    if (!files.length) return;
    event.preventDefault();
    void addReferenceFiles(files);
  }

  function useTemplate(template: ImageTemplate) {
    setSelectedTemplate(template);
    setGenerationMode("template");
    setTab("chat");
  }

  async function createTemplate(input: TemplateCreateInput) {
    await window.api.createImageTemplate(input);
    await loadTemplateLibrary();
  }

  async function updateTemplate(input: TemplateUpdateInput) {
    await window.api.updateImageTemplate(input);
    await loadTemplateLibrary();
  }

  async function createCategory(name: string) {
    const created = await window.api.createImageTemplateCategory({ name });
    await loadTemplateLibrary();
    return created;
  }

  async function updateCategory(id: string, name: string) {
    const updated = await window.api.updateImageTemplateCategory({ id, name });
    await loadTemplateLibrary();
    return updated;
  }

  async function reorderCategories(ids: string[]) {
    await window.api.reorderImageTemplateCategories({ ids });
    await loadTemplateLibrary();
  }

  async function deleteCategory(id: string) {
    await window.api.deleteImageTemplateCategory({ id });
    await loadTemplateLibrary();
  }

  async function deleteTemplate(template: ImageTemplate) {
    await window.api.deleteImageTemplate({ id: template.id });
    if (selectedTemplate?.id === template.id) setSelectedTemplate(null);
    await loadTemplateLibrary();
  }

  return (
    <div
      className={`page ai-image-page ${tab === "chat" ? "ai-image-chat-page" : "ai-image-template-page"}`}
    >
      <div className="ai-image-heading">
        <div>
          <h1>九、AI生图</h1>
          <p className="muted">
            用文字或参考图快速生成社交媒体海报与视觉素材。
          </p>
        </div>
        <span className="badge badge-info">图模型工作台</span>
      </div>

      <div className="ai-image-tabs" role="tablist">
        <button
          className={tab === "chat" ? "active" : ""}
          onClick={() => setTab("chat")}
        >
          聊天
        </button>
        <button
          className={tab === "templates" ? "active" : ""}
          onClick={() => setTab("templates")}
        >
          模板
        </button>
      </div>

      {tab === "templates" ? (
        <TemplateLibrary
          templates={templates}
          categories={categories}
          selected={selectedTemplate}
          onUse={useTemplate}
          onCreate={createTemplate}
          onUpdate={updateTemplate}
          onCreateCategory={createCategory}
          onUpdateCategory={updateCategory}
          onReorderCategories={reorderCategories}
          onDeleteCategory={deleteCategory}
          onDelete={deleteTemplate}
          onPreview={(template) =>
            setViewerSrc({ src: template.imageDataUrl, alt: template.title })
          }
        />
      ) : (
        <section className="ai-chat-shell">
          <div
            className="ai-chat-scroll"
            ref={chatRef}
            onScroll={handleChatScroll}
          >
            <div className="ai-chat-messages" ref={messagesRef}>
              {historyLoading && (
                <div className="ai-chat-history-loading">
                  <Spinner text="加载聊天记录…" />
                </div>
              )}
              {!historyLoading && images.length === 0 && !busy && (
                <div className="ai-chat-empty">
                  <div className="ai-image-empty-mark">✦</div>
                  <h2>开始创作</h2>
                  <p>描述画面，或上传参考图后进行编辑。</p>
                </div>
              )}
              {!historyLoading && hasEarlierImages && (
                <div className="ai-chat-earlier-hint" role="status">
                  {earlierLoading
                    ? "正在加载更早的记录…"
                    : `上滑加载更早的记录（还有 ${visibleStart} 条）`}
                </div>
              )}
              {images.map((image, index) => {
                const absoluteIndex = visibleStart + index;
                const isLatestTurn = index === images.length - 1;
                return (
                  <div
                    className="ai-chat-turn"
                    key={image.id}
                    data-turn-id={image.id}
                  >
                    <div className="ai-chat-user-wrap">
                      <div className="ai-chat-user">
                        <span className="ai-chat-bubble-label">你</span>
                        <div>{image.prompt}</div>
                        {!!image.references?.length && (
                          <div className="ai-chat-user-references">
                            {image.references.map((reference, referenceIndex) => (
                              <img
                                key={`${reference.name}-${referenceIndex}`}
                                src={reference.dataUrl}
                                alt={reference.name}
                                loading="lazy"
                                decoding="async"
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  setReferenceMenu({
                                    left: Math.min(event.clientX, window.innerWidth - 132),
                                    top: Math.min(event.clientY, window.innerHeight - 56),
                                    reference,
                                  });
                                }}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                      {!!image.references?.length && (
                        <div className="ai-chat-user-tools">
                          <button
                            className="mini"
                            onClick={() => void copyUserMessageImage(image)}
                            title="复制这条消息里的图片"
                          >
                            复制图片
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="ai-chat-assistant">
                      <span className="ai-chat-bubble-label">AI</span>
                      {image.pending && (
                        <div className="ai-chat-status">
                          <Spinner /> 图片模型正在处理…
                        </div>
                      )}
                      {image.error && (
                        <div className="ai-chat-error-output">{image.error}</div>
                      )}
                      {!image.pending && !image.error && (
                        <figure className="ai-chat-image-card">
                          <img
                            src={displaySrc(image)}
                            alt={image.prompt}
                            loading="lazy"
                            decoding="async"
                            onClick={() => void openViewer(image)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                void openViewer(image);
                              }
                            }}
                            onLoad={() => {
                              // 只有最新一条图片加载完才回到底部；
                              // 更早的记录解码完成时不能把用户拉走。
                              if (!active || tab !== "chat" || !isLatestTurn)
                                return;
                              prependAnchorRef.current = null;
                              stickToBottomRef.current = true;
                              if (chatRef.current)
                                chatRef.current.scrollTop =
                                  chatRef.current.scrollHeight;
                            }}
                          />
                          <div className="ai-chat-image-tools">
                            <button
                              className="mini"
                              onClick={() => regenerate(image)}
                              disabled={busy}
                            >
                              重新生成
                            </button>
                            <button
                              className="mini"
                              onClick={() =>
                                void beginLocalEdit(image, absoluteIndex)
                              }
                              disabled={busy}
                            >
                              局部修改
                            </button>
                            <button
                              className="mini"
                              onClick={() => void copyImage(image)}
                            >
                              复制
                            </button>
                            <button
                              className="mini"
                              onClick={() => void download(image, absoluteIndex)}
                            >
                              下载
                            </button>
                          </div>
                        </figure>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="ai-chat-composer">
            <div className="ai-chat-composer-inner">
              <div
                className={`ai-chat-composer-box${dragActive ? " drag-active" : ""}`}
                onDragOver={(event) => {
                  // Prevent the browser's default file-open behavior and make
                  // the drop target obvious while files are dragged over it.
                  if (event.dataTransfer.types.includes("Files")) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                    setDragActive(true);
                  }
                }}
                onDragLeave={(event) => {
                  // Ignore transitions between children inside the composer.
                  const related = event.relatedTarget;
                  if (
                    !(related instanceof Node) ||
                    !event.currentTarget.contains(related)
                  )
                    setDragActive(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragActive(false);
                  const dropped = Array.from(event.dataTransfer.files);
                  if (!dropped.length) return;
                  const images = dropped.filter((file) =>
                    file.type.startsWith("image/"),
                  );
                  if (!images.length) {
                    setError("请上传图片文件");
                    return;
                  }
                  if (images.length !== dropped.length)
                    setError("仅支持图片附件，已忽略其他文件");
                  void addReferenceFiles(images);
                }}
              >
                {references.length > 0 && (
                  <div className="ai-attachments">
                    {references.map((item, index) => (
                      <div
                        className="ai-attachment"
                        key={`${item.name}-${index}`}
                      >
                        <img src={item.dataUrl} alt="" />
                        <span>{item.name}</span>
                        <button
                          className="link"
                          onClick={() =>
                            setReferences((previous) =>
                              previous.filter(
                                (_, itemIndex) => itemIndex !== index,
                              ),
                            )
                          }
                        >
                          移除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {selectedTemplate && (
                  <div className="ai-template-context">
                    <img src={selectedTemplate.imageDataUrl} alt="" />
                    <div>
                      <strong>{selectedTemplate.title}</strong>
                      <span>
                        {selectedTemplate.description} ·{" "}
                        {selectedTemplate.aspectRatio}
                      </span>
                    </div>
                    <button
                      className="link"
                      onClick={() => setSelectedTemplate(null)}
                    >
                      移除
                    </button>
                  </div>
                )}
                <textarea
                  className="ai-chat-prompt"
                  value={prompt}
                  onChange={changePrompt}
                  onPaste={pasteReference}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={
                    selectedTemplate
                      ? "补充产品、活动或品牌信息…"
                      : "描述你想生成或修改的画面…"
                  }
                />
                <div className="ai-chat-actions">
                  <div className="ai-chat-actions-left">
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={chooseReference}
                    />
                    <button
                      className="mini ai-chat-attach"
                      title="添加参考图"
                      onClick={() => fileRef.current?.click()}
                    >
                      ＋
                    </button>
                    <div
                      className="ai-generation-mode"
                      role="group"
                      aria-label="生成方式"
                    >
                      <button
                        className={generationMode === "free" ? "active" : ""}
                        onClick={() => setGenerationMode("free")}
                      >
                        自由生成
                      </button>
                      <button
                        className={
                          generationMode === "template" ? "active" : ""
                        }
                        onClick={() => setGenerationMode("template")}
                      >
                        基于模板
                      </button>
                      {generationMode === "template" && !selectedTemplate && (
                        <button
                          className="link"
                          onClick={() => setTab("templates")}
                        >
                          选择模板
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{display: 'flex', gap: 16}}>
                    {config?.imageModels?.length ? (
                      <select
                        className="ai-image-model-select"
                        value={selectedModel}
                        onChange={(event) => setSelectedModel(event.target.value)}
                        aria-label="选择生图模型"
                      >
                        {config.imageModels.map((item) => (
                          <option key={item.name} value={item.name}>
                            {item.name} · {item.resolution} · {item.description}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <button
                      className="ghost"
                      disabled={busy || polishing || !prompt.trim()}
                      onClick={() => void polishPrompt()}
                    >
                      {polishing ? "润色中…" : "AI润色"}
                    </button>
                    <button
                      className="primary ai-chat-send"
                      disabled={busy || polishing}
                      onClick={submit}
                    >
                      {busy ? (
                        <span
                          className="ai-chat-send-loading"
                          aria-label="加载中"
                        />
                      ) : (
                        "发送"
                      )}
                    </button>
                  </div>
                </div>
              </div>
              {error && <p className="err ai-image-error">{error}</p>}
            </div>
          </div>
        </section>
      )}
      {localEditTarget && (
        <LocalEditDialog
          target={localEditTarget.image}
          onClose={() => setLocalEditTarget(null)}
          onSubmit={submitLocalEdit}
        />
      )}
      {referenceMenu && (
        <div
          className="ai-context-menu"
          ref={referenceMenuRef}
          role="menu"
          aria-label="图片操作"
          style={{ left: referenceMenu.left, top: referenceMenu.top }}
        >
          <button
            className="ai-context-menu-item"
            role="menuitem"
            onClick={() => {
              const { reference } = referenceMenu;
              setReferenceMenu(null);
              void copyReferenceImage(reference);
            }}
          >
            复制
          </button>
        </div>
      )}
      {copyStatus && (
        <div className="ai-image-toast" role="status">
          {copyStatus}
        </div>
      )}
      {viewerSrc && (
        <ImageViewer
          src={viewerSrc.src}
          alt={viewerSrc.alt}
          onClose={() => setViewerSrc(null)}
        />
      )}
    </div>
  );
}

function LocalEditDialog({
  target,
  onClose,
  onSubmit,
}: {
  target: ChatImage;
  onClose: () => void;
  onSubmit: (
    target: ChatImage,
    selections: Selection[],
    detail: string,
  ) => void;
}) {
  const [selections, setSelections] = useState<Selection[]>([]);
  const [draft, setDraft] = useState<Selection | null>(null);
  const [detail, setDetail] = useState("");
  const stageRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };
  const normalized = (
    start: { x: number; y: number },
    end: { x: number; y: number },
  ): Selection => ({
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  });
  return (
    <div className="modal-mask ai-local-edit-mask" onClick={onClose}>
      <div
        className="modal ai-local-edit-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span>局部修改</span>
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="modal-body">
          <div
            className="ai-local-stage"
            ref={stageRef}
            onDragStart={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              const start = point(event);
              startRef.current = start;
              setDraft({ ...start, width: 0, height: 0 });
            }}
            onPointerMove={(event) => {
              event.preventDefault();
              if (startRef.current)
                setDraft(normalized(startRef.current, point(event)));
            }}
            onPointerUp={(event) => {
              event.preventDefault();
              if (!startRef.current) return;
              const next = normalized(startRef.current, point(event));
              if (next.width > 0.01 && next.height > 0.01)
                setSelections((previous) => [...previous, next]);
              startRef.current = null;
              setDraft(null);
            }}
            onPointerCancel={() => {
              startRef.current = null;
              setDraft(null);
            }}
          >
            <img src={imageSrc(target)} alt="待编辑图片" draggable={false} />
            {[...selections, ...(draft ? [draft] : [])].map(
              (selection, index) => (
                <span
                  className="ai-local-selection"
                  key={index}
                  style={{
                    left: `${selection.x * 100}%`,
                    top: `${selection.y * 100}%`,
                    width: `${selection.width * 100}%`,
                    height: `${selection.height * 100}%`,
                  }}
                />
              ),
            )}
          </div>
          <div className="ai-local-help">
            拖动框选需要修改的区域，可选择多个区域。
            <button className="link" onClick={() => setSelections([])}>
              清除选区
            </button>
          </div>
          <label className="ai-local-label">
            修改要求
            <textarea
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
              placeholder="例如：将选中的花替换为向日葵"
            />
          </label>
        </div>
        <div className="modal-foot">
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            onClick={() => onSubmit(target, selections, detail)}
          >
            开始修改
          </button>
        </div>
      </div>
    </div>
  );
}

function TemplateLibrary({
  templates,
  categories,
  selected,
  onUse,
  onCreate,
  onUpdate,
  onCreateCategory,
  onUpdateCategory,
  onReorderCategories,
  onDeleteCategory,
  onDelete,
  onPreview,
}: {
  templates: ImageTemplate[];
  categories: ImageTemplateCategory[];
  selected: ImageTemplate | null;
  onUse: (template: ImageTemplate) => void;
  onCreate: (input: TemplateCreateInput) => Promise<void>;
  onUpdate: (input: TemplateUpdateInput) => Promise<void>;
  onCreateCategory: (name: string) => Promise<ImageTemplateCategory>;
  onUpdateCategory: (
    id: string,
    name: string,
  ) => Promise<ImageTemplateCategory>;
  onReorderCategories: (ids: string[]) => Promise<void>;
  onDeleteCategory: (id: string) => Promise<void>;
  onDelete: (template: ImageTemplate) => Promise<void>;
  onPreview: (template: ImageTemplate) => void;
}) {
  const [category, setCategory] = useState("全部");
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [showCategoryDialog, setShowCategoryDialog] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ImageTemplate | null>(
    null,
  );
  const [deleteCandidate, setDeleteCandidate] = useState<ImageTemplate | null>(
    null,
  );
  const [image, setImage] = useState<TemplateImage | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [categoryItems, setCategoryItems] =
    useState<ImageTemplateCategory[]>(categories);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(
    null,
  );
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [draggingCategoryId, setDraggingCategoryId] = useState<string | null>(
    null,
  );
  const [deletingCategoryId, setDeletingCategoryId] = useState<string | null>(
    null,
  );
  const [editImage, setEditImage] = useState<TemplateImage | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editCategoryId, setEditCategoryId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState("");
  const [categoryError, setCategoryError] = useState("");
  const imageInputRef = useRef<HTMLInputElement>(null);
  const editImageInputRef = useRef<HTMLInputElement>(null);
  const visible =
    category === "全部"
      ? templates
      : templates.filter((template) => template.category === category);

  useEffect(() => {
    if (
      category !== "全部" &&
      !categories.some((item) => item.name === category)
    )
      setCategory("全部");
  }, [category, categories]);

  useEffect(() => {
    if (!showCategoryDialog) setCategoryItems(categories);
  }, [categories, showCategoryDialog]);

  async function chooseTemplateImage(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("请上传图片文件");
    } else {
      try {
        setImage({ name: file.name, dataUrl: await readFile(file) });
        setError("");
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
    event.target.value = "";
  }

  async function createTemplate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTitle = title.trim();
    const normalizedDescription = description.trim();
    if (!image || !normalizedTitle || !normalizedDescription || !categoryId) {
      setError("请完整填写模板图片、标题、描述和分类");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const { width, height } = await imageDimensions(image.dataUrl);
      await onCreate({
        imageDataUrl: image.dataUrl,
        imageFileName: image.name,
        title: normalizedTitle,
        description: normalizedDescription,
        categoryId,
        aspectRatio: formatAspectRatio(width, height),
      });
      setImage(null);
      setTitle("");
      setDescription("");
      setCategoryId("");
      if (imageInputRef.current) imageInputRef.current.value = "";
      setShowTemplateDialog(false);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }

  async function createCategory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newCategoryName.trim();
    if (!name) {
      setCategoryError("请输入分类名称");
      return;
    }
    setCreatingCategory(true);
    setCategoryError("");
    try {
      await onCreateCategory(name);
      setNewCategoryName("");
      setShowCategoryDialog(false);
    } catch (cause: unknown) {
      setCategoryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreatingCategory(false);
    }
  }

  function openTemplateDialog() {
    setError("");
    setShowTemplateDialog(true);
  }

  function openCategoryDialog() {
    setCategoryError("");
    setCategoryItems(categories);
    setEditingCategoryId(null);
    setNewCategoryName("");
    setShowCategoryDialog(true);
  }

  async function saveCategoryName(item: ImageTemplateCategory) {
    const name = editingCategoryName.trim();
    if (!name) {
      setCategoryError("请输入分类名称");
      return;
    }
    setCreatingCategory(true);
    setCategoryError("");
    try {
      const updated = await onUpdateCategory(item.id, name);
      setCategoryItems((previous) =>
        previous.map((current) => (current.id === item.id ? updated : current)),
      );
      if (category === item.name) setCategory(updated.name);
      setEditingCategoryId(null);
    } catch (cause: unknown) {
      setCategoryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreatingCategory(false);
    }
  }

  function moveCategory(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    const next = [...categoryItems];
    const from = next.findIndex((item) => item.id === draggedId);
    const to = next.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setCategoryItems(next);
    void onReorderCategories(next.map((item) => item.id)).catch(
      (cause: unknown) => {
        setCategoryError(
          cause instanceof Error ? cause.message : String(cause),
        );
      },
    );
  }

  async function removeCategory(item: ImageTemplateCategory) {
    if (!window.confirm(`确认删除分类“${item.name}”吗？`)) return;
    setDeletingCategoryId(item.id);
    setCategoryError("");
    try {
      await onDeleteCategory(item.id);
      setCategoryItems((previous) =>
        previous.filter((current) => current.id !== item.id),
      );
      if (category === item.name) setCategory("全部");
    } catch (cause: unknown) {
      setCategoryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeletingCategoryId(null);
    }
  }

  function openEditDialog(template: ImageTemplate) {
    setEditingTemplate(template);
    setEditImage(null);
    setEditTitle(template.title);
    setEditDescription(template.description);
    setEditCategoryId(template.categoryId);
    setError("");
  }

  async function chooseEditImage(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("请上传图片文件");
    } else {
      try {
        setEditImage({ name: file.name, dataUrl: await readFile(file) });
        setError("");
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
    event.target.value = "";
  }

  async function updateTemplate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingTemplate) return;
    const normalizedTitle = editTitle.trim();
    const normalizedDescription = editDescription.trim();
    if (!normalizedTitle || !normalizedDescription || !editCategoryId) {
      setError("请完整填写模板标题、描述和分类");
      return;
    }
    setUpdating(true);
    setError("");
    try {
      const next: TemplateUpdateInput = {
        id: editingTemplate.id,
        title: normalizedTitle,
        description: normalizedDescription,
        categoryId: editCategoryId,
      };
      if (editImage) {
        const { width, height } = await imageDimensions(editImage.dataUrl);
        next.imageDataUrl = editImage.dataUrl;
        next.imageFileName = editImage.name;
        next.aspectRatio = formatAspectRatio(width, height);
      }
      await onUpdate(next);
      setEditingTemplate(null);
      setEditImage(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUpdating(false);
    }
  }

  async function deleteTemplate(template: ImageTemplate): Promise<boolean> {
    if (deletingTemplateId) return false;
    setDeletingTemplateId(template.id);
    setError("");
    try {
      await onDelete(template);
      return true;
    } catch (cause: unknown) {
      setError(
        `删除模板失败：${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return false;
    } finally {
      setDeletingTemplateId(null);
    }
  }

  return (
    <div className="template-library">
      <div className="template-library-head">
        <div>
          <h2>模板库</h2>
          <p className="muted">选择一个模板后，回到聊天页补充内容即可生成。</p>
        </div>
        <div className="template-library-tools">
          <button className="ghost" onClick={openCategoryDialog}>
            编辑分类
          </button>
          <button className="primary" onClick={openTemplateDialog}>
            新建模板
          </button>
        </div>
      </div>
      <div className="template-filters">
        <button
          className={category === "全部" ? "active" : ""}
          onClick={() => setCategory("全部")}
        >
          全部
        </button>
        {categories.map((item) => (
          <button
            key={item.id}
            className={category === item.name ? "active" : ""}
            onClick={() => setCategory(item.name)}
          >
            {item.name}
          </button>
        ))}
      </div>
      {error && <p className="err ai-image-error">{error}</p>}

      {visible.length === 0 ? (
        <div className="template-empty">
          <strong>还没有模板</strong>
          <span className="muted">
            先上传一张模板图片，创建自己的海报模板库。
          </span>
        </div>
      ) : (
        <div className="template-grid">
          {visible.map((template) => (
            <article
              className={`template-card ${selected?.id === template.id ? "selected" : ""}`}
              key={template.id}
            >
              <div
                className="template-card-media"
                onClick={() => onPreview(template)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onPreview(template);
                  }
                }}
              >
                <img
                  className="template-preview"
                  src={template.imageDataUrl}
                  alt={template.title}
                />
              </div>
              <div className="template-card-info">
                <h3>{template.title}</h3>
                <dl>
                  <div>
                    <dt>模板类型</dt>
                    <dd>{template.category}</dd>
                  </div>
                  <div>
                    <dt>模板简介</dt>
                    <dd>{template.description}</dd>
                  </div>
                </dl>
              </div>
              <div className="template-card-actions">
                <button
                  className="mini"
                  onClick={() => openEditDialog(template)}
                >
                  编辑
                </button>
                <button
                  className="mini"
                  disabled={deletingTemplateId === template.id}
                  onClick={() => setDeleteCandidate(template)}
                >
                  删除
                </button>
                <button className="primary" onClick={() => onUse(template)}>
                  使用模板
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {showTemplateDialog && (
        <div
          className="modal-mask"
          onClick={() => setShowTemplateDialog(false)}
        >
          <div
            className="modal template-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <span>新建模板</span>
              <button
                className="link"
                onClick={() => setShowTemplateDialog(false)}
              >
                关闭
              </button>
            </div>
            <form onSubmit={createTemplate}>
              <div className="modal-body template-dialog-body">
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={chooseTemplateImage}
                />
                <button
                  type="button"
                  className="template-image-picker"
                  onClick={() => imageInputRef.current?.click()}
                >
                  {image ? (
                    <img src={image.dataUrl} alt="模板图片预览" />
                  ) : (
                    <>
                      <strong>上传模板图片</strong>
                      <span>JPG、PNG、WebP</span>
                    </>
                  )}
                </button>
                <label>
                  标题
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="例如：新品发布海报"
                  />
                </label>
                <label>
                  描述
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="说明模板的版式、风格或适用场景"
                  />
                </label>
                <label>
                  分类
                  <select
                    value={categoryId}
                    onChange={(event) => setCategoryId(event.target.value)}
                  >
                    <option value="">请选择分类</option>
                    {categories.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                {categories.length === 0 && (
                  <p className="muted small">请先新建一个模板分类。</p>
                )}
                {error && <p className="err">{error}</p>}
              </div>
              <div className="modal-foot">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setShowTemplateDialog(false)}
                >
                  取消
                </button>
                <button className="primary" disabled={submitting}>
                  {submitting ? (
                    <>
                      <Spinner /> 保存中…
                    </>
                  ) : (
                    "保存模板"
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showCategoryDialog && (
        <div
          className="modal-mask"
          onClick={() => setShowCategoryDialog(false)}
        >
          <div
            className="modal template-category-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <span>编辑分类</span>
              <button
                className="link"
                onClick={() => setShowCategoryDialog(false)}
              >
                关闭
              </button>
            </div>
            <div className="modal-body template-dialog-body">
              <div className="category-editor-list">
                {categoryItems.length === 0 && (
                  <div className="empty">暂无分类</div>
                )}
                {categoryItems.map((item) => (
                  <div
                    className="category-editor-row"
                    key={item.id}
                    draggable={editingCategoryId !== item.id}
                    onDragStart={() => setDraggingCategoryId(item.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (draggingCategoryId)
                        moveCategory(draggingCategoryId, item.id);
                      setDraggingCategoryId(null);
                    }}
                    onDragEnd={() => setDraggingCategoryId(null)}
                  >
                    <button
                      type="button"
                      className="category-drag-handle"
                      title="拖动排序"
                      aria-label="拖动排序"
                    >
                      ⋮⋮
                    </button>
                    {editingCategoryId === item.id ? (
                      <input
                        autoFocus
                        value={editingCategoryName}
                        onChange={(event) =>
                          setEditingCategoryName(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter")
                            void saveCategoryName(item);
                        }}
                      />
                    ) : (
                      <span className="category-editor-name">{item.name}</span>
                    )}
                    {editingCategoryId === item.id ? (
                      <button
                        className="mini"
                        disabled={creatingCategory}
                        onClick={() => void saveCategoryName(item)}
                      >
                        保存
                      </button>
                    ) : (
                      <button
                        className="mini"
                        onClick={() => {
                          setEditingCategoryId(item.id);
                          setEditingCategoryName(item.name);
                          setCategoryError("");
                        }}
                      >
                        编辑
                      </button>
                    )}
                    <button
                      className="mini danger"
                      disabled={!!deletingCategoryId}
                      onClick={() => void removeCategory(item)}
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
              {categoryError && <p className="err">{categoryError}</p>}
            </div>
            <div className="modal-foot category-editor-foot">
              <input
                value={newCategoryName}
                onChange={(event) => setNewCategoryName(event.target.value)}
                placeholder="输入新分类名称"
              />
              <button
                className="primary"
                disabled={creatingCategory}
                onClick={() => {
                  const name = newCategoryName.trim();
                  if (!name) {
                    setCategoryError("请输入分类名称");
                    return;
                  }
                  setCreatingCategory(true);
                  setCategoryError("");
                  void onCreateCategory(name)
                    .then((created) => {
                      setCategoryItems((previous) => [...previous, created]);
                      setNewCategoryName("");
                      setCategoryError("");
                    })
                    .catch((cause: unknown) => {
                      setCategoryError(
                        cause instanceof Error ? cause.message : String(cause),
                      );
                    })
                    .finally(() => setCreatingCategory(false));
                }}
              >
                {creatingCategory ? (
                  <>
                    <Spinner /> 添加中…
                  </>
                ) : (
                  "添加分类"
                )}
              </button>
              <button
                className="ghost"
                onClick={() => setShowCategoryDialog(false)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {editingTemplate && (
        <div
          className="modal-mask"
          onClick={() => !updating && setEditingTemplate(null)}
        >
          <div
            className="modal template-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <span>编辑模板</span>
              <button
                className="link"
                disabled={updating}
                onClick={() => setEditingTemplate(null)}
              >
                关闭
              </button>
            </div>
            <form onSubmit={updateTemplate}>
              <div className="modal-body template-dialog-body">
                <input
                  ref={editImageInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={chooseEditImage}
                />
                <button
                  type="button"
                  className="template-image-picker"
                  onClick={() => editImageInputRef.current?.click()}
                >
                  <img
                    src={editImage?.dataUrl || editingTemplate.imageDataUrl}
                    alt="模板图片预览"
                  />
                  <span className="template-image-picker-caption">
                    点击替换模板图片
                  </span>
                </button>
                <label>
                  标题
                  <input
                    value={editTitle}
                    onChange={(event) => setEditTitle(event.target.value)}
                  />
                </label>
                <label>
                  描述
                  <textarea
                    value={editDescription}
                    onChange={(event) => setEditDescription(event.target.value)}
                  />
                </label>
                <label>
                  分类
                  <select
                    value={editCategoryId}
                    onChange={(event) => setEditCategoryId(event.target.value)}
                  >
                    <option value="">请选择分类</option>
                    {categories.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                {error && <p className="err">{error}</p>}
              </div>
              <div className="modal-foot">
                <button
                  type="button"
                  className="ghost"
                  disabled={updating}
                  onClick={() => setEditingTemplate(null)}
                >
                  取消
                </button>
                <button className="primary" disabled={updating}>
                  {updating ? (
                    <>
                      <Spinner /> 保存中…
                    </>
                  ) : (
                    "保存修改"
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteCandidate && (
        <div
          className="modal-mask"
          onClick={() => !deletingTemplateId && setDeleteCandidate(null)}
        >
          <div
            className="modal template-delete-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <span>删除模板</span>
            </div>
            <div className="modal-body">
              <p>确认删除“{deleteCandidate.title}”？删除后无法恢复。</p>
              {error && <p className="err">{error}</p>}
            </div>
            <div className="modal-foot">
              <button
                className="ghost"
                disabled={!!deletingTemplateId}
                onClick={() => setDeleteCandidate(null)}
              >
                取消
              </button>
              <button
                className="danger"
                disabled={!!deletingTemplateId}
                onClick={() =>
                  void deleteTemplate(deleteCandidate).then((deleted) => {
                    if (deleted) setDeleteCandidate(null);
                  })
                }
              >
                {deletingTemplateId ? (
                  <>
                    <Spinner /> 删除中…
                  </>
                ) : (
                  "确认删除"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
