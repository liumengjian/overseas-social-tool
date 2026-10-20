import React, { useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "../components/ui";
import ImageViewer from "../components/ImageViewer";
import type { AppConfig } from "../../shared/types";
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
const IMAGE_HISTORY_STORAGE_KEY = "ai_image_chat_history";
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

function imageSrc(image: GeneratedImage): string {
  if (image.url) return image.url;
  return `data:${image.contentType || "image/png"};base64,${image.b64 || ""}`;
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
      image.pending === true ||
      typeof image.error === "string")
  );
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
  const [historyLoading, setHistoryLoading] = useState(true);
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
  const [dragActive, setDragActive] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const pipe = useWorkflow("AI生图");

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
    void window.api
      .getJson(IMAGE_HISTORY_STORAGE_KEY)
      .then((history) => {
        // 旧版本按倒序保存，读取时翻转并立即回写，后续统一按时间正序追加。
        if (alive && Array.isArray(history)) {
          const migrated = history.filter(isChatImage).reverse();
          setImages(migrated);
          void window.api
            .setJson(IMAGE_HISTORY_STORAGE_KEY, {
              version: 2,
              images: migrated,
            })
            .catch(() => undefined);
        } else if (
          alive &&
          history &&
          typeof history === "object" &&
          (history as { version?: unknown }).version === 2
        ) {
          const storedImages = (history as { images?: unknown }).images;
          if (Array.isArray(storedImages))
            setImages(storedImages.filter(isChatImage));
        }
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

  useEffect(() => {
    if (!active || tab !== "chat") return;
    // The page stays mounted while hidden, so wait for it to become visible
    // before measuring scrollHeight and moving to the newest message.
    const frame = window.requestAnimationFrame(() => {
      const scroll = chatRef.current;
      if (!scroll) return;
      scroll.scrollTo({ top: scroll.scrollHeight, behavior: "auto" });
      window.requestAnimationFrame(() => {
        if (chatRef.current)
          chatRef.current.scrollTop = chatRef.current.scrollHeight;
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, tab, images.length, busy]);

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
          const maxPixels =
            maxResolution === "4k"
              ? 4096
              : maxResolution === "2k"
                ? 2048
                : 1024;
          let inferredSize = `${maxPixels}x${maxPixels}`;
          try {
            const inferred = await window.api.runAiTask({
              task: "inferImageSize",
              payload: { prompt: submittedPrompt, baseSize: inferredSize },
              runId,
            });
            if (inferred?.size) inferredSize = inferred.size;
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
          const generated = allReferences.length
            ? await window.api.editImage({
                prompt: submittedPrompt,
                images: allReferences,
                size: inferredSize,
                model,
                runId,
              })
            : await window.api.generateImage({
                prompt: submittedPrompt,
                size: inferredSize,
                model,
                runId,
              });
          if (signal.aborted) return;
          setImages((previous) => {
            const completed = generated.map((image, index) => ({
              ...image,
              id: `${Date.now()}-${index}`,
              prompt: submittedPrompt,
              references: submittedReferences,
            }));
            const at = previous.findIndex((item) => item.id === turnId);
            const next =
              at >= 0
                ? [
                    ...previous.slice(0, at),
                    ...completed,
                    ...previous.slice(at + 1),
                  ]
                : [...previous, ...completed];
            void window.api
              .setJson(IMAGE_HISTORY_STORAGE_KEY, { version: 2, images: next })
              .catch((cause: unknown) => {
                setError(
                  `保存聊天记录失败：${cause instanceof Error ? cause.message : String(cause)}`,
                );
              });
            return next;
          });
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
        setImages((previous) => {
          const next = [
            ...previous,
            ...generated.map((item, index) => ({
              ...item,
              id: `${Date.now()}-${index}`,
              prompt: image.prompt,
              references: image.references,
            })),
          ];
          void window.api
            .setJson(IMAGE_HISTORY_STORAGE_KEY, { version: 2, images: next })
            .catch((cause: unknown) => {
              setError(
                `保存聊天记录失败：${cause instanceof Error ? cause.message : String(cause)}`,
              );
            });
          return next;
        });
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
          setImages((previous) => {
            const next = [
              ...previous,
              ...protectedGenerated.map((item, index) => ({
                ...item,
                id: `${Date.now()}-${index}`,
                prompt: `局部修改：${promptForEdit}`,
                references: target.references,
              })),
            ];
            void window.api
              .setJson(IMAGE_HISTORY_STORAGE_KEY, { version: 2, images: next })
              .catch(() => undefined);
            return next;
          });
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

  function download(image: GeneratedImage, index: number) {
    const anchor = document.createElement("a");
    anchor.href = imageSrc(image);
    anchor.download = `ai-image-${index + 1}.${(image.contentType || "image/png").split("/")[1] || "png"}`;
    anchor.click();
  }

  async function copyImage(image: GeneratedImage) {
    try {
      const response = await fetch(imageSrc(image));
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
        await navigator.clipboard.writeText(image.url || imageSrc(image));
        setCopyStatus("图片地址已复制");
      } catch {
        setCopyStatus("复制失败，请手动下载");
      }
    }
    window.setTimeout(() => setCopyStatus(""), 2200);
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
          <div className="ai-chat-scroll" ref={chatRef}>
            <div className="ai-chat-messages">
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
              {images.map((image, index) => (
                <div className="ai-chat-turn" key={image.id}>
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
                          />
                        ))}
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
                          src={imageSrc(image)}
                          alt={image.prompt}
                          onClick={() =>
                            setViewerSrc({
                              src: imageSrc(image),
                              alt: image.prompt,
                            })
                          }
                          role="button"
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setViewerSrc({
                                src: imageSrc(image),
                                alt: image.prompt,
                              });
                            }
                          }}
                          onLoad={() => {
                            if (active && tab === "chat" && chatRef.current)
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
                            onClick={() => setLocalEditTarget({ image, index })}
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
                            onClick={() => download(image, index)}
                          >
                            下载
                          </button>
                        </div>
                      </figure>
                    )}
                  </div>
                </div>
              ))}
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
