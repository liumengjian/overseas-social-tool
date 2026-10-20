import React, { useEffect, useRef, useState } from "react";
import { Card, Spinner } from "../components/ui";
import { AppConfig } from "../../shared/types";
import {
  EditMaterial,
  EditPlan,
  EditGenerationOptions,
} from "../../analysis/ai-edit";
import { useWorkflow } from "../workflowStore";

type Row = {
  start: number;
  end: number;
  analyze: boolean;
  preserveAudio: boolean;
  shot: string;
  camera: string;
  caption: string;
  title: string;
  filePath: string;
};
type Outcome = {
  outputPath: string;
  error?: string;
  direction?: string;
  platform?: string;
};
const nameOf = (p: string) => p.split(/[\\/]/).pop() || p;
const localVideoUrl = (filePath: string) =>
  encodeURI(`file:///${filePath.replace(/\\/g, "/")}`);

async function uploadMaterialsForAnalysis(
  materials: EditMaterial[],
): Promise<EditMaterial[]> {
  return Promise.all(
    materials.map(async (material) => {
      if (!material.filePath) return material;
      const result = await window.api.uploadVideoToCos({
        filePath: material.filePath,
      });
      const url = result?.url;
      if (!url) throw new Error(`素材上传 COS 失败：${material.name}`);
      return { ...material, url };
    }),
  );
}
const BUNDLED_FONT_NAMES = [
  "BubblegumSans-Regular.ttf",
  "CabinSketch-Regular.ttf",
  "Fredoka-Regular.ttf",
  "Montserrat-Regular.ttf",
  "NotoSans-Regular.ttf",
  "Outfit-Regular.ttf",
  "Quicksand-Bold.ttf",
  "Roboto-Medium.ttf",
];

const REGION_NAMES: Record<string, string> = {
  CN: "中国",
  TW: "中国台湾",
  HK: "中国香港",
  MO: "中国澳门",
  US: "美国",
  GB: "英国",
  AU: "澳大利亚",
  CA: "加拿大",
  IN: "印度",
  JP: "日本",
  KR: "韩国",
  SG: "新加坡",
  MY: "马来西亚",
  FR: "法国",
  DE: "德国",
  ES: "西班牙",
  IT: "意大利",
  BR: "巴西",
  MX: "墨西哥",
  RU: "俄罗斯",
  ZA: "南非",
  NZ: "新西兰",
  IE: "爱尔兰",
};

function countryCodeOfLocale(locale: string): string {
  return locale.split("-")[1]?.toUpperCase() || locale.split("-")[0] || "OTHER";
}

function countryLabelOfLocale(locale: string): string {
  const code = countryCodeOfLocale(locale);
  if (REGION_NAMES[code]) return REGION_NAMES[code];
  try {
    return new Intl.DisplayNames(["zh-CN"], { type: "region" }).of(code) || code;
  } catch {
    return code;
  }
}

function translatedLanguageLabel(label: string, locale: string): string {
  const value = label || locale;
  if (locale.toLowerCase() === "zh-cn-shaanxi") return "中原官话陕西方言";
  if (locale.toLowerCase() === "zh-cn-liaoning") return "东北官话";
  if (locale.toLowerCase() === "zh-hk") return "粤语";
  if (locale.toLowerCase() === "zh-tw") return "台湾普通话";
  if (/Zhongyuan Mandarin Shaanxi/i.test(value)) return "中原官话陕西方言";
  if (/Northeastern Mandarin/i.test(value)) return "东北官话";
  if (/Cantonese/i.test(value)) return "粤语";
  if (/Taiwanese Mandarin/i.test(value)) return "台湾普通话";
  if (/Mandarin/i.test(value)) return "普通话";
  const language = locale.split("-")[0].toLowerCase();
  const languageNames: Record<string, string> = {
    zh: "中文",
    en: "英语",
    ja: "日语",
    ko: "韩语",
    fr: "法语",
    de: "德语",
    es: "西班牙语",
    it: "意大利语",
    pt: "葡萄牙语",
    ru: "俄语",
    ar: "阿拉伯语",
    hi: "印地语",
  };
  if (languageNames[language]) return languageNames[language];
  try {
    return (
      new Intl.DisplayNames(["zh-CN"], { type: "language" }).of(language) ||
      value.replace(/\s*\([^)]*\)\s*$/, "") ||
      locale
    );
  } catch {
    return value.replace(/\s*\([^)]*\)\s*$/, "") || locale;
  }
}

export default function AiEditing() {
  const [tab, setTab] = useState<"free" | "script" | "audio" | "settings" | "fonts">("free");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([
    {
      start: 0,
      end: 5,
      analyze: false,
      preserveAudio: false,
      shot: "",
      camera: "",
      caption: "",
      title: "",
      filePath: "",
    },
  ]);
  const [direction, setDirection] =
    useState<EditGenerationOptions["direction"]>("traffic");
  const [videoType, setVideoType] = useState<"landscape" | "portrait">(
    "landscape",
  );
  const [duration, setDuration] = useState(30);
  const [voice, setVoice] = useState(false);
  const [voiceText, setVoiceText] = useState("");
  const [voiceName, setVoiceName] = useState("");
  const [voiceRate, setVoiceRate] = useState(1);
  const [voiceLocale, setVoiceLocale] = useState("");
  const [voiceCountry, setVoiceCountry] = useState("");
  const [locales, setLocales] = useState<
    Array<{ locale: string; label: string }>
  >([]);
  const [voicesByLocale, setVoicesByLocale] = useState<
    Array<{
      name: string;
      shortName: string;
      gender: string;
      locale: string;
      friendlyName: string;
      voiceType: string;
    }>
  >([]);
  const [burn, setBurn] = useState(false);
  const [subPos, setSubPos] = useState<"top" | "center" | "bottom">("bottom");
  const [subColor, setSubColor] = useState("white");
  const [subSize, setSubSize] = useState(48);
  const [subFont, setSubFont] = useState("");
  const [titleStyle] = useState<any>({
    position: "top",
    color: "#ffffff",
    fontSize: 48,
    font: "",
    outlineColor: "#000000",
    outlineWidth: 0,
  });
  const [captionStyle] = useState<any>({
    position: "bottom",
    color: "#ffffff",
    fontSize: 42,
    font: "",
    outlineColor: "#000000",
    outlineWidth: 0,
  });
  // Keep independent style objects for each output orientation.  Do not derive
  // these from a shared object after initialization, otherwise editing one
  // orientation unexpectedly changes the other.
  const [landscapeCaptionStyle, setLandscapeCaptionStyle] = useState<any>(
    () => ({ ...captionStyle }),
  );
  const [portraitCaptionStyle, setPortraitCaptionStyle] = useState<any>(() => ({
    ...captionStyle,
  }));
  const [landscapeTitleStyle, setLandscapeTitleStyle] = useState<any>(() => ({
    ...titleStyle,
  }));
  const [portraitTitleStyle, setPortraitTitleStyle] = useState<any>(() => ({
    ...titleStyle,
  }));
  const [settingsEditing, setSettingsEditing] = useState(false);
  const [savedSettings, setSavedSettings] = useState<any>(null);
  const [settingsNotice, setSettingsNotice] = useState("");
  const [voicePreviewing, setVoicePreviewing] = useState(false);
  const [voicePreviewUrl, setVoicePreviewUrl] = useState("");
  const voicePreviewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [aspect, setAspect] = useState<"landscape" | "portrait">("landscape");
  const [dragging, setDragging] = useState<"caption" | "title" | null>(null);
  const [resizing, setResizing] = useState<"caption" | "title" | null>(null);
  const [resizeStartWidth, setResizeStartWidth] = useState<number | null>(null);
  const [resizeStartX, setResizeStartX] = useState<number | null>(null);
  const [selectedSubtitle, setSelectedSubtitle] = useState<
    "caption" | "title" | null
  >(null);
  const [dragAspect, setDragAspect] = useState<"landscape" | "portrait">(
    "landscape",
  );
  const [previewSize, setPreviewSize] = useState<"landscape" | "portrait">(
    "landscape",
  );
  const [fontList, setFontList] = useState<Array<{ name: string; path: string; builtIn: boolean }>>([]);
  const [fontDialog, setFontDialog] = useState(false);
  const [fontSource, setFontSource] = useState<string | null>(null);
  const [plans, setPlans] = useState<EditPlan[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );
  const [error, setError] = useState("");
  const [renderState, setRenderState] = useState<
    "idle" | "loading" | "done" | "error"
  >("idle");
  const [freeResults, setFreeResults] = useState<Outcome[]>([]);
  const [scriptResults, setScriptResults] = useState<Outcome[]>([]);
  const [renderError, setRenderError] = useState("");
  const [audioText, setAudioText] = useState("");
  const [audioFormat, setAudioFormat] = useState<"mp3" | "wav" | "m4a" | "ogg">("mp3");
  const [audioState, setAudioState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [audioOutput, setAudioOutput] = useState("");
  const [audioVoiceName, setAudioVoiceName] = useState("");
  const [audioVoiceRate, setAudioVoiceRate] = useState(1);
  const [audioVoiceLocale, setAudioVoiceLocale] = useState("");
  const [audioVoiceCountry, setAudioVoiceCountry] = useState("");
  const [audioVoicesByLocale, setAudioVoicesByLocale] = useState<Array<{
    name: string; shortName: string; gender: string; locale: string;
    friendlyName: string; voiceType: string;
  }>>([]);
  const localeGroups = Array.from(
    locales.reduce((groups, item) => {
      const country = countryCodeOfLocale(item.locale);
      const current = groups.get(country) || [];
      current.push(item);
      groups.set(country, current);
      return groups;
    }, new Map<string, Array<{ locale: string; label: string }>>()),
  ).sort((a, b) => countryLabelOfLocale(a[0]).localeCompare(countryLabelOfLocale(b[0]), "zh-CN"));
  const localesForCountry = locales.filter(
    (item) => countryCodeOfLocale(item.locale) === voiceCountry,
  );
  const audioLocalesForCountry = locales.filter(
    (item) => countryCodeOfLocale(item.locale) === audioVoiceCountry,
  );
  const pipe = useWorkflow("AI批量视频剪辑");
  useEffect(() => {
    window.api.getConfig().then(setConfig);
    window.api.getJson("ai_edit_settings").then((v: any) => {
      const fallbackCaption = v?.captionStyle || captionStyle;
      const fallbackTitle = v?.titleStyle || titleStyle;
      const normalize = (s: any, fallback: any) => ({
        ...fallback,
        ...(s || {}),
        outlineWidth: Number(s?.outlineWidth ?? fallback.outlineWidth ?? 0),
      });
      const lsCaption = normalize(v?.landscapeCaptionStyle || v?.captionStyle, {
        ...fallbackCaption,
        outlineWidth: 0,
      });
      const ptCaption = normalize(v?.portraitCaptionStyle || v?.captionStyle, {
        ...fallbackCaption,
        outlineWidth: 0,
      });
      const lsTitle = normalize(v?.landscapeTitleStyle || v?.titleStyle, {
        ...fallbackTitle,
        outlineWidth: 0,
      });
      const ptTitle = normalize(v?.portraitTitleStyle || v?.titleStyle, {
        ...fallbackTitle,
        outlineWidth: 0,
      });
      setLandscapeCaptionStyle(lsCaption);
      setPortraitCaptionStyle(ptCaption);
      setLandscapeTitleStyle(lsTitle);
      setPortraitTitleStyle(ptTitle);
      setSavedSettings({
        landscapeCaptionStyle: lsCaption,
        portraitCaptionStyle: ptCaption,
        landscapeTitleStyle: lsTitle,
        portraitTitleStyle: ptTitle,
        voiceName: v?.voiceName || "",
        voiceRate: Number(v?.voiceRate ?? 1),
        voiceLocale: v?.voiceLocale || "",
        voiceCountry: v?.voiceLocale ? countryCodeOfLocale(v.voiceLocale) : "",
      });
      setVoiceName(v?.voiceName || "");
      setVoiceRate(Number(v?.voiceRate ?? 1));
      if (v?.voiceLocale) {
        setVoiceLocale(v.voiceLocale);
        setVoiceCountry(countryCodeOfLocale(v.voiceLocale));
      }
    });
    // 加载 TTS locales（国家列表）
    loadTtsLocales();
  }, []);
  async function refreshFonts() {
    const bundledFonts = BUNDLED_FONT_NAMES.map((name) => ({ name, path: name, builtIn: true }));
    try {
      const fonts = await window.api.listFonts();
      const merged = new Map(bundledFonts.map((font) => [font.name, font]));
      fonts.forEach((font) => merged.set(font.name, font));
      setFontList(Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      setFontList(bundledFonts);
    }
  }
  useEffect(() => { refreshFonts(); }, []);
  const fontFiles = fontList.map((font) => font.name);
  async function chooseFont() {
    const selected = await window.api.pickFontFile();
    if (selected) { setFontSource(selected); setFontDialog(true); }
  }
  async function confirmFontUpload() {
    if (!fontSource) return;
    const result = await window.api.uploadFont({ sourcePath: fontSource });
    if (result?.error) setError(result.error);
    else { setFontDialog(false); setFontSource(null); await refreshFonts(); setSettingsNotice("字体已新增"); window.setTimeout(() => setSettingsNotice(""), 2200); }
  }
  async function removeFont(name: string) {
    const result = await window.api.deleteFont({ name });
    if (result?.error) setError(result.error);
    else { await refreshFonts(); setSettingsNotice("字体已删除"); window.setTimeout(() => setSettingsNotice(""), 2200); }
  }
  const usedFontNames = new Set(
    [landscapeCaptionStyle, portraitCaptionStyle, landscapeTitleStyle, portraitTitleStyle]
      .map((style: any) => style?.font)
      .filter(Boolean)
      .map((font: string) => font.split(/[\\/]/).pop()),
  );

  async function loadTtsLocales() {
    try {
      const data = await window.api.getTtsLocales();
      setLocales(data);
      // 恢复之前保存的 locale
      const saved = await window.api.getJson("ai_edit_settings");
      if (saved?.voiceLocale) {
        setVoiceCountry(countryCodeOfLocale(saved.voiceLocale));
        setVoiceLocale(saved.voiceLocale);
        loadTtsVoices(saved.voiceLocale);
      } else if (data.length > 0) {
        // 默认选中第一个（通常是中文）
        setVoiceCountry(countryCodeOfLocale(data[0].locale));
        setVoiceLocale(data[0].locale);
        loadTtsVoices(data[0].locale);
      } else {
      }
    } catch (error) {
      console.error("[AiEditing] 加载 TTS locales 失败:", error);
    }
  }

  async function loadTtsVoices(locale: string) {
    try {
      const voices = await window.api.getTtsVoicesByLocale({ locale });
      setVoicesByLocale(voices);
    } catch (error) {
    }
  }
  async function saveSettings() {
    const value = {
      captionStyle: landscapeCaptionStyle,
      titleStyle: landscapeTitleStyle,
      landscapeCaptionStyle,
      portraitCaptionStyle,
      landscapeTitleStyle,
      portraitTitleStyle,
      voiceName,
      voiceRate,
      voiceLocale,
    };
    try {
      await window.api.setJson("ai_edit_settings", value);
      setSavedSettings({
        landscapeCaptionStyle,
        portraitCaptionStyle,
        landscapeTitleStyle,
        portraitTitleStyle,
        voiceName,
        voiceRate,
        voiceLocale,
        voiceCountry,
      });
      setSettingsEditing(false);
      setError("");
      setSettingsNotice("设置已保存");
      window.setTimeout(() => setSettingsNotice(""), 2200);
    } catch (e: any) {
      setError(`设置保存失败：${e?.message || String(e)}`);
    }
  }
  function cancelSettings() {
    if (savedSettings) {
      setLandscapeCaptionStyle(savedSettings.landscapeCaptionStyle);
      setPortraitCaptionStyle(savedSettings.portraitCaptionStyle);
      setLandscapeTitleStyle(savedSettings.landscapeTitleStyle);
      setPortraitTitleStyle(savedSettings.portraitTitleStyle);
      setVoiceName(savedSettings.voiceName || "");
      setVoiceRate(Number(savedSettings.voiceRate ?? 1));
      setVoiceLocale(savedSettings.voiceLocale || "");
      setVoiceCountry(savedSettings.voiceCountry || "");
      setVoicesByLocale([]);
      if (savedSettings.voiceLocale) loadTtsVoices(savedSettings.voiceLocale);
    }
    setSettingsEditing(false);
  }

  function previewTextForLocale(locale: string): string {
    const language = locale.split("-")[0].toLowerCase();
    const texts: Record<string, string> = {
      zh: "欢迎来到中国",
      en: "Welcome to China",
      ja: "中国へようこそ",
      ko: "중국에 오신 것을 환영합니다",
      fr: "Bienvenue en Chine",
      de: "Willkommen in China",
      es: "Bienvenido a China",
      it: "Benvenuti in Cina",
      pt: "Bem-vindo à China",
      ru: "Добро пожаловать в Китай",
    };
    return texts[language] || "Welcome to China";
  }

  async function previewVoice() {
    if (!voiceLocale) return;
    setVoicePreviewing(true);
    setError("");
    try {
      const result = await window.api.previewTts({
        text: previewTextForLocale(voiceLocale),
        voice: voiceName || undefined,
        locale: voiceLocale,
        rate: voiceRate,
      });
      if (result?.audioDataUrl) {
        setVoicePreviewUrl(result.audioDataUrl);
        window.setTimeout(() => {
          void voicePreviewAudioRef.current?.play().catch(() => undefined);
        }, 0);
      } else {
        setError(result?.error || "试听生成失败");
      }
    } catch (e: any) {
      setError(`试听失败：${e?.message || String(e)}`);
    } finally {
      setVoicePreviewing(false);
    }
  }
  async function loadAudioTtsVoices(locale: string) {
    try {
      setAudioVoicesByLocale(await window.api.getTtsVoicesByLocale({ locale }));
    } catch {
      setAudioVoicesByLocale([]);
    }
  }
  async function previewAudioVoice() {
    if (!audioVoiceLocale) return;
    setVoicePreviewing(true);
    setError("");
    try {
      const result = await window.api.previewTts({
        text: previewTextForLocale(audioVoiceLocale),
        voice: audioVoiceName || undefined,
        locale: audioVoiceLocale,
        rate: audioVoiceRate,
      });
      if (result?.audioDataUrl) {
        setVoicePreviewUrl(result.audioDataUrl);
        window.setTimeout(() => {
          void voicePreviewAudioRef.current?.play().catch(() => undefined);
        }, 0);
      } else setError(result?.error || "试听生成失败");
    } catch (e: any) {
      setError(`试听失败：${e?.message || String(e)}`);
    } finally {
      setVoicePreviewing(false);
    }
  }
  function generateAudio() {
    if (!audioText.trim()) {
      setError("请输入口播文案");
      setAudioState("error");
      return;
    }
    if (!audioVoiceLocale) {
      setError("请选择区域和语言");
      setAudioState("error");
      return;
    }
    pipe.enqueue("生成口播音频", async (_runId, signal) => {
      setAudioState("loading");
      setError("");
      try {
        const result = await window.api.generateSpeechAudio({
          text: audioText.trim(),
          format: audioFormat,
          voice: audioVoiceName || undefined,
          locale: audioVoiceLocale,
          rate: audioVoiceRate,
        });
        if (signal.aborted) return;
        setAudioOutput(result.outputPath);
        setAudioState("done");
      } catch (e: any) {
        if (!signal.aborted) {
          setError(e?.message || String(e));
          setAudioState("error");
        }
        throw e;
      }
    });
  }
  function movePreview(e: React.MouseEvent<HTMLDivElement>) {
    if (!dragging && !resizing) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (resizing && resizeStartWidth != null && resizeStartX != null) {
      // 计算鼠标移动的距离（相对于预览容器）
      const mouseDeltaX = (e.clientX - resizeStartX) / r.width;
      // 横屏最大480px（100%），竖屏最大270px（100%）
      const maxWidthPercent =
        dragAspect === "landscape" ? 480 / 480 : 270 / 270; // 都是1.0（100%）
      const newWidth = Math.max(
        0.15,
        Math.min(maxWidthPercent, resizeStartWidth + mouseDeltaX),
      );
      const setter =
        resizing === "caption"
          ? dragAspect === "landscape"
            ? setLandscapeCaptionStyle
            : setPortraitCaptionStyle
          : dragAspect === "landscape"
            ? setLandscapeTitleStyle
            : setPortraitTitleStyle;
      setter((s: any) => ({ ...s, width: newWidth }));
      return;
    }
    const x = Math.max(0.05, Math.min(0.95, (e.clientX - r.left) / r.width));
    const y = Math.max(0.05, Math.min(0.95, (e.clientY - r.top) / r.height));
    const setter =
      dragging === "caption"
        ? dragAspect === "landscape"
          ? setLandscapeCaptionStyle
          : setPortraitCaptionStyle
        : dragAspect === "landscape"
          ? setLandscapeTitleStyle
          : setPortraitTitleStyle;
    setter((s: any) => ({ ...s, x, y }));
  }
  const materials: EditMaterial[] = paths.map((filePath) => ({
    filePath,
    name: nameOf(filePath),
  }));
  const scriptMaterials: EditMaterial[] = rows
    .filter((r) => r.filePath)
    .map((r) => ({ filePath: r.filePath, name: nameOf(r.filePath) }));
  async function pickVideos() {
    try {
      const p = await window.api.pickVideoFiles();
      if (p?.length) setPaths((a) => [...a, ...p]);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }
  async function pickRow(i: number) {
    try {
      const p = await window.api.pickVideoFiles();
      if (p?.[0])
        setRows((a) =>
          a.map((r, j) => (j === i ? { ...r, filePath: p[0] } : r)),
        );
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }
  const updateRow = (i: number, patch: Partial<Row>) =>
    setRows((a) => a.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  async function generate() {
    const mats = materials;
    if (!mats.length) {
      setError("请先上传本地素材");
      setState("error");
      return;
    }
    if (
      tab === "free" &&
      (!Number.isFinite(duration) || duration <= 0 || duration < 5)
    ) {
      setError("生成时长最小为 5 秒");
      setState("error");
      return;
    }
    if (tab === "free" && voice && !voiceText.trim()) {
      setError("请输入口播文案");
      setState("error");
      return;
    }
    const options: EditGenerationOptions = {
      direction,
      videoType,
      durationSec: duration,
      includeVoiceover: voice,
      voiceoverText: voice ? voiceText.trim() : undefined,
    };
    pipe.enqueue("生成剪辑方案", async (runId, signal) => {
      setState("loading");
      setError("");
      try {
        const analysisMaterials = await uploadMaterialsForAnalysis(mats);
        const res = await window.api.generateEditPlan(analysisMaterials, options, runId);
        if (signal.aborted) return;
        const arr = Array.isArray(res) ? res : [];
        if (!arr.length) throw new Error("模型未返回有效方案");
        setPlans(arr);
        setState("done");
      } catch (e: any) {
        if (!signal.aborted) {
          setError(e?.message || String(e));
          setState("error");
        }
        throw e;
      }
    });
  }
  async function render(nextPlans = plans, mats = materials) {
    if (!nextPlans?.length) return;
    const activeCaptionStyle =
      videoType === "landscape" ? landscapeCaptionStyle : portraitCaptionStyle;
    const activeTitleStyle =
      videoType === "landscape" ? landscapeTitleStyle : portraitTitleStyle;
    pipe.enqueue("导出成片", async (runId, signal) => {
      setRenderState("loading");
      try {
        const sourcePlan: any = nextPlans[0];
        const syncedPlan = voice && sourcePlan.voiceoverSegments?.length
          ? {
              ...sourcePlan,
              // 按成片时间轴把口播片段归并到对应镜头，保证画面下方字幕与当前音频内容一致。
              captions: (() => {
                const ranges = Array.isArray(sourcePlan.clipRanges) ? sourcePlan.clipRanges : [];
                const captions = (sourcePlan.clips || []).map(() => "");
                let cursor = 0;
                for (let index = 0; index < captions.length; index++) {
                  const duration = Math.max(0, Number(ranges[index]?.endSec) - Number(ranges[index]?.startSec));
                  const end = cursor + duration;
                  captions[index] = sourcePlan.voiceoverSegments
                    .filter((segment: any) => Number(segment.endSec) > cursor && Number(segment.startSec) < end)
                    .map((segment: any) => String(segment.text || "").trim())
                    .filter(Boolean)
                    .join(" ");
                  cursor = end;
                }
                return captions.length ? captions : sourcePlan.captions;
              })(),
            }
          : sourcePlan;
        const r = await window.api.renderEditPlan({
          materials: mats,
          plans: [syncedPlan],
          runId,
          burnCaptions:
            burn ||
            !!nextPlans[0].captions?.some(Boolean) ||
            !!nextPlans[0].titleCaptions?.some(Boolean),
          subtitle: {
            position: activeCaptionStyle.position,
            x: activeCaptionStyle.x,
            y: activeCaptionStyle.y,
            color: activeCaptionStyle.color,
            fontSize: activeCaptionStyle.fontSize,
            font: activeCaptionStyle.font || undefined,
            fontWeight: activeCaptionStyle.fontWeight,
            width: activeCaptionStyle.width,
            outlineColor: activeCaptionStyle.outlineColor,
            outlineWidth: activeCaptionStyle.outlineWidth,
          },
          titleSubtitle: {
            position: activeTitleStyle.position,
            x: activeTitleStyle.x,
            y: activeTitleStyle.y,
            color: activeTitleStyle.color,
            fontSize: activeTitleStyle.fontSize,
            font: activeTitleStyle.font || undefined,
            fontWeight: activeTitleStyle.fontWeight,
            width: activeTitleStyle.width,
            outlineColor: activeTitleStyle.outlineColor,
            outlineWidth: activeTitleStyle.outlineWidth,
          },
          voiceoverText: voice ? (nextPlans[0].voiceoverSegments ? undefined : voiceText.trim()) : undefined,
          voiceoverSegments: voice ? nextPlans[0].voiceoverSegments : undefined,
          voiceoverVoice: voiceName || undefined,
          voiceoverRate: voiceRate,
          voiceoverLocale: voiceLocale || undefined,
          videoType,
        });
        if (signal.aborted) return;
        setFreeResults(r as Outcome[]);
        setRenderState("done");
      } catch (e: any) {
        setRenderError(e?.message || String(e));
        setRenderState("error");
        throw e;
      }
    });
  }
  async function exportScript() {
    if (!scriptMaterials.length) {
      setError("请为至少一个分镜选择本地素材");
      return;
    }
    const invalidRow = rows.find(
      (row) =>
        row.filePath &&
        (!Number.isFinite(row.start) ||
          !Number.isFinite(row.end) ||
          row.end <= row.start),
    );
    if (invalidRow) {
      setError("分镜结束时间必须大于开始时间");
      return;
    }

    const scriptSegments = rows
      .filter((row) => row.filePath)
      .map((row) => ({
        startSec: row.start,
        endSec: row.end,
        shot: row.shot || undefined,
        camera: row.camera || undefined,
        caption: row.caption || undefined,
        title: row.title || undefined,
        analyze: row.analyze,
        preserveAudio: row.preserveAudio,
        material: nameOf(row.filePath),
      }));
    const analyzedSegments = scriptSegments.filter((segment) => segment.analyze);
    const analyzedMaterialNames = new Set(
      analyzedSegments.map((segment) => segment.material),
    );
    const analyzedMaterials = scriptMaterials.filter((material) =>
      analyzedMaterialNames.has(material.name),
    ).filter(
      (material, index, all) =>
        all.findIndex((candidate) => candidate.name === material.name) === index,
    );
    pipe.enqueue("分析脚本分镜并导出成片", async (runId, signal) => {
      setState("loading");
      setRenderState("loading");
      setError("");
      setRenderError("");
      setScriptResults([]);
      try {
        let generatedPlan: EditPlan | undefined;
        if (analyzedSegments.length > 0) {
          const analysisMaterials = await uploadMaterialsForAnalysis(analyzedMaterials);
          const planResponse = await window.api.generateEditPlan(
            analysisMaterials,
            { direction, videoType, scriptSegments: analyzedSegments },
            runId,
          );
          if (signal.aborted) return;
          generatedPlan = (Array.isArray(planResponse) ? planResponse : [])[0];
          if (!generatedPlan) throw new Error("AI 未返回有效的脚本剪辑方案");
          if (generatedPlan.clips.length !== analyzedSegments.length) {
            throw new Error("AI 未为每个勾选的分镜返回对应素材，请重试");
          }
          if (
            generatedPlan.clips.some(
              (material, index) => material !== analyzedSegments[index].material,
            )
          ) {
            throw new Error("AI 返回的分镜顺序与脚本不一致，请重试");
          }
        }
        const remainingRanges = [...(generatedPlan?.clipRanges ?? [])];
        const finalRanges = scriptSegments.map((segment) => {
          const durationSec = segment.endSec - segment.startSec;
          if (!segment.analyze) {
            return { material: segment.material, startSec: 0, endSec: durationSec };
          }
          const index = remainingRanges.findIndex(
            (range) => range.material === segment.material,
          );
          if (index < 0) return undefined;
          return remainingRanges.splice(index, 1)[0];
        });
        if (finalRanges.some((range) => !range)) {
          throw new Error("AI 未返回完整的源素材截取区间，请重试");
        }
        const alignedClipRanges = finalRanges as NonNullable<EditPlan["clipRanges"]>;
        if (
          alignedClipRanges.some((range, index) =>
            Math.abs(
              range.endSec - range.startSec -
                (scriptSegments[index].endSec - scriptSegments[index].startSec),
            ) > 1,
          )
        ) {
          throw new Error("AI 返回的源素材区间与分镜目标时长不一致，请重试");
        }
        const alignedPlan: EditPlan = {
          ...(generatedPlan ?? {
            direction: direction || "traffic",
            platform: "tiktok",
            durationSec: 0,
            hook: "",
            transitions: "cut",
            note: "未勾选 AI 分析，按素材开头时段导出",
          }),
          clips: scriptSegments.map((segment) => segment.material),
          durationSec: scriptSegments.reduce(
            (sum, segment) => sum + segment.endSec - segment.startSec,
            0,
          ),
          clipRanges: alignedClipRanges,
          captions: scriptSegments.map((segment) => segment.caption || ""),
          titleCaptions: scriptSegments.map((segment) => segment.title || ""),
          preserveAudio: scriptSegments.map((segment) => segment.preserveAudio),
        };

        const activeCaptionStyle =
          videoType === "landscape"
            ? landscapeCaptionStyle
            : portraitCaptionStyle;
        const activeTitleStyle =
          videoType === "landscape" ? landscapeTitleStyle : portraitTitleStyle;
        const output = await window.api.renderEditPlan({
          materials: scriptMaterials,
          plans: [alignedPlan],
          runId,
          burnCaptions: true,
          subtitle: activeCaptionStyle,
          titleSubtitle: activeTitleStyle,
          voiceoverSegments: scriptSegments
            .filter((segment) => segment.caption?.trim())
            .map((segment) => ({
              text: segment.caption!.trim(),
              startSec: segment.startSec,
              endSec: segment.endSec,
            })),
          voiceoverVoice: voiceName || undefined,
          voiceoverRate: voiceRate,
          voiceoverLocale: voiceLocale || undefined,
          videoType,
        });
        if (signal.aborted) return;
        setScriptResults(output as Outcome[]);
        setState("idle");
        setRenderState("done");
      } catch (e: any) {
        if (!signal.aborted) {
          const message = e?.message || String(e);
          setError(message);
          setRenderError(message);
          setState("error");
          setRenderState("error");
        }
        throw e;
      }
    });
  }
  return (
    <div className="page">
      {settingsNotice && (
        <div className="ai-image-toast" role="status">
          {settingsNotice}
        </div>
      )}
      <h1>七、AI 批量视频剪辑</h1>
      <p className="muted">
        AI 仅分析并裁剪、拼接、字幕和配音，不修改原始画面。
      </p>
      <div className="ai-image-tabs" role="tablist">
        <button
          className={tab === "free" ? "active" : ""}
          onClick={() => setTab("free")}
        >
          自由生成
        </button>
        <button
          className={tab === "script" ? "active" : ""}
          onClick={() => setTab("script")}
        >
          脚本生成
        </button>
        <button
          className={tab === "audio" ? "active" : ""}
          onClick={() => setTab("audio")}
        >
          音频输出
        </button>
        <button
          className={tab === "settings" ? "active" : ""}
          onClick={() => setTab("settings")}
        >
          设置
        </button>
        <button
          className={tab === "fonts" ? "active" : ""}
          onClick={() => setTab("fonts")}
        >
          字体维护
        </button>
      </div>
      {tab === "audio" ? (
        <Card title="音频输出">
          <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            <label>区域 <select value={audioVoiceCountry} onChange={(e) => { setAudioVoiceCountry(e.target.value); setAudioVoiceLocale(""); setAudioVoiceName(""); setAudioVoicesByLocale([]); }}>
              <option value="">请选择国家/地区</option>
              {localeGroups.map(([country]) => <option key={country} value={country}>{countryLabelOfLocale(country)}</option>)}
            </select></label>
            <label>语言 <select value={audioVoiceLocale} disabled={!audioVoiceCountry} onChange={(e) => { const locale = e.target.value; setAudioVoiceLocale(locale); setAudioVoiceName(""); setAudioVoicesByLocale([]); if (locale) loadAudioTtsVoices(locale); }}>
              <option value="">请选择语言/方言</option>
              {audioLocalesForCountry.map((item) => <option key={item.locale} value={item.locale}>{translatedLanguageLabel(item.label, item.locale)}</option>)}
            </select></label>
            <label>音色 <select value={audioVoiceName} disabled={!audioVoiceLocale || !audioVoicesByLocale.length} onChange={(e) => setAudioVoiceName(e.target.value)}>
              <option value="">系统默认</option>
              {audioVoicesByLocale.map((item) => <option key={item.shortName} value={item.shortName}>{item.friendlyName} ({item.gender})</option>)}
            </select></label>
            <button type="button" className="ghost" onClick={previewAudioVoice} disabled={!audioVoiceLocale || voicePreviewing}>{voicePreviewing ? "试听中…" : "试听"}</button>
            <label>语速 <input type="number" step="0.1" min="0.1" value={audioVoiceRate} onChange={(e) => setAudioVoiceRate(Number(e.target.value))} /></label>
          </div>
          <textarea value={audioText} onChange={(e) => setAudioText(e.target.value)} placeholder="输入口播文案" style={{ minHeight: 160, width: "100%", marginTop: 16 }} />
          <div className="row" style={{ gap: 16, marginTop: 16 }}>
            <label>输出格式 <select value={audioFormat} onChange={(e) => setAudioFormat(e.target.value as any)}><option value="mp3">MP3</option><option value="wav">WAV</option><option value="m4a">M4A</option><option value="ogg">OGG</option></select></label>
            <button className="primary" onClick={generateAudio} disabled={audioState === "loading"}>{audioState === "loading" ? "生成中…" : "生成音频"}</button>
          </div>
          {audioOutput && audioState === "done" && <div style={{ marginTop: 16 }}><audio controls src={encodeURI(`file:///${audioOutput.replace(/\\/g, "/")}`)} /><button className="ghost" style={{ marginLeft: 8 }} onClick={() => window.api.showItemInFolder(audioOutput)}>打开文件位置</button></div>}
          {error && <p className="err">{error}</p>}
        </Card>
      ) : tab === "fonts" ? (
        <Card title="字体文件维护" right={<button className="primary" onClick={chooseFont}>新增字体</button>}>
          <style>{fontList.filter((font) => !font.builtIn).map((font) => {
            const fontUrl = encodeURI(`file:///${font.path.replace(/\\/g, "/")}`);
            return `@font-face{font-family:${JSON.stringify(font.name)};src:url(${JSON.stringify(fontUrl)}) format('truetype');font-display:swap;}`;
          }).join("\n")}</style>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>字体文件</th><th>来源</th><th>操作</th></tr></thead>
              <tbody>
                {fontList.map((font) => (
                  <tr key={font.name}>
                    <td style={{ fontFamily: `'${font.name}', sans-serif`, fontSize: 18 }}>
                      {font.name}
                    </td>
                    <td>{font.builtIn ? "内置" : "已上传"}</td>
                    <td>
                      <button className="mini" disabled={font.builtIn || usedFontNames.has(font.name)} onClick={() => removeFont(font.name)}>
                        {font.builtIn ? "内置" : usedFontNames.has(font.name) ? "使用中" : "删除"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!fontList.length && <p className="empty">暂无字体文件</p>}
        </Card>
      ) : tab === "settings" ? (
        <Card
          title="字幕与口播设置"
          right={
            settingsEditing ? (
              <span className="row" style={{ gap: 8 }}>
                <button className="ghost" onClick={cancelSettings}>
                  取消
                </button>
                <button className="primary" onClick={saveSettings}>
                  保存
                </button>
              </span>
            ) : (
              <button
                className="ghost"
                onClick={() => setSettingsEditing(true)}
              >
                编辑
              </button>
            )
          }
        >
          <div
            role="alert"
            style={{
              marginBottom: 14,
              padding: "10px 12px",
              border: "1px solid rgba(79, 140, 255, 0.45)",
              borderRadius: 8,
              color: "var(--muted)",
              background: "rgba(79, 140, 255, 0.1)",
              lineHeight: 1.5,
            }}
          >
            点击右上角“编辑”进入编辑模式。编辑模式下，可拖动预览图中的标题字幕和口播字幕文字来调整位置；保存后会应用到最终生成的视频。
          </div>
          <fieldset
            disabled={!settingsEditing}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            <div
              className="row"
              style={{ marginBottom: 16, justifyContent: "center", gap: 60}}
            >
              <label style={{ width: 320 }}>
                区域{" "}
                <select
                  value={voiceCountry}
                  style={{ width: "80%" }}
                  onChange={(e) => {
                    setVoiceCountry(e.target.value);
                    setVoiceLocale("");
                    setVoiceName("");
                    setVoicesByLocale([]);
                  }}
                >
                  <option value="">请选择国家/地区</option>
                  {localeGroups.map(([country]) => (
                    <option key={country} value={country}>
                      {countryLabelOfLocale(country)}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ width: 320 }}>
                语言{" "}
                <select
                  value={voiceLocale}
                  style={{ width: "80%" }}
                  disabled={!voiceCountry}
                  onChange={(e) => {
                    const newLocale = e.target.value;
                    setVoiceLocale(newLocale);
                    setVoiceName("");
                    setVoicesByLocale([]);
                    if (newLocale) loadTtsVoices(newLocale);
                  }}
                >
                  <option value="">请选择语言/方言</option>
                  {localesForCountry.map((item) => (
                    <option key={item.locale} value={item.locale}>
                      {countryLabelOfLocale(item.locale)}-
                      {translatedLanguageLabel(item.label, item.locale)}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ width: 320, whiteSpace: 'nowrap' }}>
                音色{" "}
                <select
                  value={voiceName}
                  style={{ width: "70%" }}
                  onChange={(e) => setVoiceName(e.target.value)}
                  disabled={!voiceLocale || voicesByLocale.length === 0}
                >
                  <option value="">系统默认</option>
                  {voicesByLocale.map((voice) => (
                    <option key={voice.shortName} value={voice.shortName}>
                      {voice.friendlyName} ({voice.gender})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="ghost"
                  onClick={previewVoice}
                  disabled={!voiceLocale || voicePreviewing}
                  style={{ marginLeft: 8 }}
                >
                  {voicePreviewing ? "试听中…" : "试听"}
                </button>
                <audio ref={voicePreviewAudioRef} src={voicePreviewUrl} preload="auto" style={{ display: "none" }} />
              </label>
              <label style={{ width: 320 }}>
                语速{" "}
                <input
                  type="number"
                  step="0.1"
                  min="0.1"
                  value={voiceRate}
                   style={{
                    width: '80%'
                  }}
                  onChange={(e) => setVoiceRate(Number(e.target.value))}
                />
              </label>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, 480px)",
                gap: 120,
                justifyContent: "center",
                overflowX: "auto",
              }}
            >
              {(["landscape", "portrait"] as const).map((mode) => {
                const caption =
                  mode === "landscape"
                    ? landscapeCaptionStyle
                    : portraitCaptionStyle;
                const title =
                  mode === "landscape"
                    ? landscapeTitleStyle
                    : portraitTitleStyle;
                const setCaption =
                  mode === "landscape"
                    ? setLandscapeCaptionStyle
                    : setPortraitCaptionStyle;
                const setTitle =
                  mode === "landscape"
                    ? setLandscapeTitleStyle
                    : setPortraitTitleStyle;
                // Preview uses a fixed logical canvas (1920x1080 landscape or
                // 1080x1920 portrait) and scales every text metric down to the
                // displayed size. This keeps font and outline proportions
                // identical to the final video.
                const previewScale = 0.25;
                return (
                  <div
                    key={mode}
                    onMouseDown={() => settingsEditing && setDragAspect(mode)}
                    style={{ pointerEvents: settingsEditing ? "auto" : "none" }}
                  >
                    <h4>{mode === "landscape" ? "横屏配置" : "竖屏配置"}</h4>
                    <div
                      style={{
                        width: 480,
                        height: 480,
                        margin: "10px auto",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        border: "1px solid #555",
                        background: "#111",
                      }}
                    >
                      <div
                        onMouseMove={movePreview}
                        onMouseUp={() => {
                          setDragging(null);
                          setResizing(null);
                          setResizeStartWidth(null);
                          setResizeStartX(null);
                        }}
                        onMouseLeave={() => {
                          setDragging(null);
                          setResizing(null);
                          setResizeStartWidth(null);
                          setResizeStartX(null);
                        }}
                        style={{
                          background: "#000",
                          width: mode === "landscape" ? 480 : 270,
                          aspectRatio: mode === "landscape" ? "16/9" : "9/16",
                          position: "relative",
                          border: "1px solid #555",
                          userSelect: "none",
                        }}
                      >
                        <div
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setSelectedSubtitle("title");
                            const box = e.currentTarget.getBoundingClientRect();
                            const previewBox =
                              e.currentTarget.parentElement!.getBoundingClientRect();
                            if (e.clientX >= box.right - 14) {
                              setResizing("title");
                              setResizeStartWidth(title.width ?? 0.5);
                              setResizeStartX(e.clientX);
                            } else {
                              setDragging("title");
                            }
                          }}
                          onMouseMove={(e) => {
                            const box = e.currentTarget.getBoundingClientRect();
                            e.currentTarget.style.cursor =
                              e.clientX >= box.right - 14
                                ? "ew-resize"
                                : "move";
                          }}
                          style={{
                            position: "absolute",
                            left: `${(title.x ?? 0.5) * 100}%`,
                            top: `${(title.y ?? 0.15) * 100}%`,
                            transform: `translate(-50%,-50%) scale(${previewScale})`,
                            transformOrigin: "center",
                            color: title.color || "#ffffff",
                            fontSize: title.fontSize || 48,
                            fontFamily: title.font
                              ? `'${title.font}'`
                              : "sans-serif",
                            fontWeight: title.fontWeight || "normal",
                            WebkitTextStroke: `${title.outlineWidth || 0}px ${title.outlineColor || "#000"}`,
                            cursor: "move",
                            whiteSpace: "nowrap",
                            width: title.width
                              ? mode === "landscape"
                                ? `${title.width * 1920}px`
                                : `${title.width * 1080}px`
                              : "auto",
                            maxWidth:
                              mode === "landscape" ? "1920px" : "1080px",
                            border:
                              selectedSubtitle === "title"
                                ? "1px dashed rgba(255,255,255,.8)"
                                : "1px solid transparent",
                            padding: "2px 4px",
                            boxSizing: "border-box",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            userSelect: "none",
                            display: title.width ? "block" : "inline-block",
                            background: title.width
                              ? "rgba(255,255,255,0.15)"
                              : "transparent",
                          }}
                        >
                          {title.width
                            ? "Title Preview".repeat(
                                Math.ceil(title.width * 20),
                              )
                            : "Title Preview"}
                        </div>
                        <div
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setSelectedSubtitle("caption");
                            const box = e.currentTarget.getBoundingClientRect();
                            const previewBox =
                              e.currentTarget.parentElement!.getBoundingClientRect();
                            if (e.clientX >= box.right - 14) {
                              setResizing("caption");
                              setResizeStartWidth(caption.width ?? 0.5);
                              setResizeStartX(e.clientX);
                            } else {
                              setDragging("caption");
                            }
                          }}
                          onMouseMove={(e) => {
                            const box = e.currentTarget.getBoundingClientRect();
                            e.currentTarget.style.cursor =
                              e.clientX >= box.right - 14
                                ? "ew-resize"
                                : "move";
                          }}
                          style={{
                            position: "absolute",
                            left: `${(caption.x ?? 0.5) * 100}%`,
                            top: `${(caption.y ?? 0.82) * 100}%`,
                            transform: `translate(-50%,-50%) scale(${previewScale})`,
                            transformOrigin: "center",
                            color: caption.color || "#ffffff",
                            fontSize: caption.fontSize || 42,
                            fontFamily: caption.font
                              ? `'${caption.font}'`
                              : "sans-serif",
                            fontWeight: caption.fontWeight || "normal",
                            WebkitTextStroke: `${caption.outlineWidth || 0}px ${caption.outlineColor || "#000"}`,
                            cursor: "move",
                            whiteSpace: "nowrap",
                            width: caption.width
                              ? mode === "landscape"
                                ? `${caption.width * 1920}px`
                                : `${caption.width * 1080}px`
                              : "auto",
                            maxWidth:
                              mode === "landscape" ? "1920px" : "1080px",
                            border:
                              selectedSubtitle === "caption"
                                ? "1px dashed rgba(255,255,255,.8)"
                                : "1px solid transparent",
                            padding: "2px 4px",
                            boxSizing: "border-box",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            userSelect: "none",
                            display: caption.width ? "block" : "inline-block",
                            background: caption.width
                              ? "rgba(255,255,255,0.15)"
                              : "transparent",
                          }}
                        >
                          {caption.width
                            ? "SubTitle Preview".repeat(
                                Math.ceil(caption.width * 20),
                              )
                            : "SubTitle Preview"}
                        </div>
                      </div>
                    </div>
                    <h4>口播字幕样式</h4>
                    {(
                      [
                        "color",
                        "fontSize",
                        "font",
                        "fontWeight",
                        "outlineColor",
                        "outlineWidth",
                      ] as const
                    ).map((k) => (
                      <label
                        key={k}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          margin: "8px 0",
                        }}
                      >
                        {k === "color"
                          ? "文字颜色"
                          : k === "fontSize"
                            ? "字号"
                            : k === "font"
                              ? "字体"
                              : k === "fontWeight"
                                ? "粗细"
                                : k === "outlineColor"
                                  ? "描边颜色"
                                  : "描边粗细"}{" "}
                        {k === "color" || k === "outlineColor" ? (
                          <input
                            type="color"
                            value={caption[k] || "#ffffff"}
                            onChange={(e) =>
                              setCaption((prev: any) => ({
                                ...prev,
                                [k]: e.target.value,
                              }))
                            }
                          />
                        ) : k === "font" ? (
                          <select
                            value={caption.font || ""}
                            onChange={(e) =>
                              setCaption((prev: any) => ({
                                ...prev,
                                font: e.target.value,
                              }))
                            }
                          >
                            <option value="">默认字体</option>
                            {fontFiles.map((f) => (
                              <option
                                key={f}
                                value={f}
                                style={{ fontFamily: `'${f}'` }}
                              >
                                {f}
                              </option>
                            ))}
                          </select>
                        ) : k === "fontWeight" ? (
                          <select
                            value={caption.fontWeight || "normal"}
                            onChange={(e) =>
                              setCaption((prev: any) => ({
                                ...prev,
                                fontWeight: e.target.value,
                              }))
                            }
                          >
                            <option value="normal">常规</option>
                            <option value="bold">粗体</option>
                          </select>
                        ) : (
                          <input
                            type="number"
                            value={caption[k] ?? 0}
                            onChange={(e) =>
                              setCaption((prev: any) => ({
                                ...prev,
                                [k]: Number(e.target.value),
                              }))
                            }
                          />
                        )}
                      </label>
                    ))}
                    <h4 style={{marginTop: 24}}>标题字幕样式</h4>
                    {(
                      [
                        "color",
                        "fontSize",
                        "font",
                        "fontWeight",
                        "outlineColor",
                        "outlineWidth",
                      ] as const
                    ).map((k) => (
                      <label
                        key={k}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          margin: "8px 0",
                        }}
                      >
                        {k === "color"
                          ? "文字颜色"
                          : k === "fontSize"
                            ? "字号"
                            : k === "font"
                              ? "字体"
                              : k === "fontWeight"
                                ? "粗细"
                                : k === "outlineColor"
                                  ? "描边颜色"
                                  : "描边粗细"}{" "}
                        {k === "color" || k === "outlineColor" ? (
                          <input
                            type="color"
                            value={title[k] || "#ffffff"}
                            onChange={(e) =>
                              setTitle((prev: any) => ({
                                ...prev,
                                [k]: e.target.value,
                              }))
                            }
                          />
                        ) : k === "font" ? (
                          <select
                            value={title.font || ""}
                            onChange={(e) =>
                              setTitle((prev: any) => ({
                                ...prev,
                                font: e.target.value,
                              }))
                            }
                          >
                            <option value="">默认字体</option>
                            {fontFiles.map((f) => (
                              <option key={f} value={f}>
                                {f}
                              </option>
                            ))}
                          </select>
                        ) : k === "fontWeight" ? (
                          <select
                            value={title.fontWeight || "normal"}
                            onChange={(e) =>
                              setTitle((prev: any) => ({
                                ...prev,
                                fontWeight: e.target.value,
                              }))
                            }
                          >
                            <option value="normal">常规</option>
                            <option value="bold">粗体</option>
                          </select>
                        ) : (
                          <input
                            type="number"
                            value={title[k] ?? 0}
                            onChange={(e) =>
                              setTitle((prev: any) => ({
                                ...prev,
                                [k]: Number(e.target.value),
                              }))
                            }
                          />
                        )}
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
          </fieldset>
        </Card>
      ) : tab === "free" ? (
        <Card title="上传本地素材">
          <button className="ghost" onClick={pickVideos}>
            选择本地视频
          </button>
          <span className="muted small"> 已选 {paths.length} 个</span>
          <ul className="kv small">
            {paths.map((p, i) => (
              <li key={p}>
                {nameOf(p)}{" "}
                <button
                  className="mini"
                  onClick={() => setPaths((a) => a.filter((_, j) => j !== i))}
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <Card title="脚本分镜列表">
          <table className="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>景别</th>
                <th>运镜描述</th>
                <th>标题字幕</th>
                <th>口播字幕</th>
                <th>是否分析</th>
                <th>保留原音频</th>
                <th>素材</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <input
                      type="number"
                      value={r.start}
                      onChange={(e) =>
                        updateRow(i, { start: Number(e.target.value) })
                      }
                      style={{
                        width: 80
                      }}
                    />{" "}
                    -{" "}
                    <input
                      type="number"
                      value={r.end}
                      onChange={(e) =>
                        updateRow(i, { end: Number(e.target.value) })
                      }
                      style={{
                        width: 80
                      }}
                    />
                  </td>
                  <td>
                    <input
                      value={r.shot}
                      onChange={(e) => updateRow(i, { shot: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={r.camera}
                      onChange={(e) => updateRow(i, { camera: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={r.title}
                      onChange={(e) => updateRow(i, { title: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={r.caption}
                      onChange={(e) =>
                        updateRow(i, { caption: e.target.value })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={r.analyze}
                      style={{
                        width: 80
                      }}
                      onChange={(e) =>
                        updateRow(i, { analyze: e.target.checked })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={r.preserveAudio}
                      style={{
                        width: 80
                      }}
                      onChange={(e) =>
                        updateRow(i, { preserveAudio: e.target.checked })
                      }
                    />
                  </td>
                  <td>
                    <button className="mini ghost" onClick={() => pickRow(i)}>
                      {r.filePath ? nameOf(r.filePath) : "选择素材"}
                    </button>
                  </td>
                  <td>
                    <button
                      className="mini"
                      disabled={rows.length <= 1}
                      onClick={() =>
                        setRows((a) => a.filter((_, j) => j !== i))
                      }
                      style={{
                        marginLeft: 24
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            className="ghost"
            onClick={() =>
              setRows((a) => [
                ...a,
                {
                  start: a[a.length - 1].end,
                  end: a[a.length - 1].end + 5,
                  analyze: false,
                  preserveAudio: false,
                  shot: "",
                  camera: "",
                  caption: "",
                  title: "",
                  filePath: "",
                },
              ])
            }
          >
            ＋增加一行
          </button>
        </Card>
      )}
      {fontDialog && (
        <div className="modal-mask" role="presentation">
          <div className="modal" role="dialog" aria-modal="true">
            <h3>新增字体</h3>
            <p className="small muted">{fontSource?.split(/[\\/]/).pop()}</p>
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button className="ghost" onClick={() => { setFontDialog(false); setFontSource(null); }}>取消</button>
              <button className="primary" onClick={confirmFontUpload}>确认上传</button>
            </div>
          </div>
        </div>
      )}
      {(tab === "free" || tab === "script") && (
        <Card title="生成参数">
          {tab === "free" && (
            <>
              <label>
                生成类型{" "}
                <select
                  value={direction}
                  onChange={(e) => setDirection(e.target.value as any)}
                  style={{ marginBottom: 12 }}
                >
                  <option value="traffic">流量型</option>
                  <option value="seed">种草型</option>
                  <option value="conversion">转化型</option>
                </select>
              </label>
              <br />
            </>
          )}
          <label>
            视频类型{" "}
            <select
              value={videoType}
              onChange={(e) => setVideoType(e.target.value as any)}
              style={{ marginBottom: 12 }}
            >
              <option value="landscape">横屏</option>
              <option value="portrait">竖屏</option>
            </select>
          </label>
          <br />
          {tab === "free" && (
            <>
              <label>
                生成时长{" "}
                <input
                  type="number"
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  style={{ marginBottom: 12 }}
                />{" "}
                秒
              </label>
              <br />
              <label className="check" style={{ margin: " 0" }}>
                <input
                  type="checkbox"
                  checked={voice}
                  onChange={(e) => setVoice(e.target.checked)}
                />{" "}
                添加口播文案
              </label>
              {voice && (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <textarea
                    value={voiceText}
                    onChange={(e) => setVoiceText(e.target.value)}
                    placeholder="输入口播文案"
                    style={{
                      minHeight: 140,
                      margin: "12px 0",
                    }}
                  />
                  <label className="check" style={{ margin: "12px 0 12px 0" }}>
                    <input
                      type="checkbox"
                      checked={burn}
                      onChange={(e) => setBurn(e.target.checked)}
                    />{" "}
                    添加字幕
                  </label>
                </div>
              )}
            </>
          )}
          <div>
            <button
              className="primary"
              onClick={tab === "script" ? exportScript : generate}
              disabled={
                state === "loading" ||
                renderState === "loading" ||
                !config?.minimaxConfigured
              }
              style={{
                marginTop: 12,
              }}
            >
              {state === "loading" || renderState === "loading"
                ? tab === "script"
                  ? "导出中…"
                  : "AI分析中…"
                : tab === "script"
                  ? "AI分析并导出成片"
                  : "生成剪辑方案"}
            </button>
          </div>
        </Card>
      )}
      {(tab === "free" || tab === "script") && error && (
        <p className="err">{error}</p>
      )}
      {tab === "free" && plans && state === "done" && (
        <Card title="各平台 Hook">
          <div className="grid-2">
            {plans.map((p, i) => (
              <div key={i}>
                <b>{p.platform}</b>
                <div>{p.hook}</div>
              </div>
            ))}
          </div>
          <button className="primary" onClick={() => render()}>
            导出成片
          </button>
        </Card>
      )}
      {tab === "free" && renderState === "loading" && <Spinner />}
      {tab === "free" && renderError && <p className="err">{renderError}</p>}
      {tab === "free" && freeResults.length > 0 && (
        <Card title="成片输出">
          <div style={{ display: "grid", gap: 16 }}>
            {freeResults.map((r, i) =>
              r.outputPath ? (
                <div key={i}>
                  <video
                    controls
                    preload="metadata"
                    src={localVideoUrl(r.outputPath)}
                    style={{
                      display: "block",
                      width: "100%",
                      maxWidth: 720,
                      background: "#000",
                    }}
                  />
                  <div className="row" style={{ marginTop: 8, gap: 8 }}>
                    <span className="muted small">{nameOf(r.outputPath)}</span>
                    <button
                      className="ghost"
                      onClick={() => window.api.showItemInFolder(r.outputPath)}
                    >
                      打开文件位置
                    </button>
                  </div>
                </div>
              ) : (
                <p className="err" key={i}>
                  {r.error || "导出失败"}
                </p>
              ),
            )}
          </div>
        </Card>
      )}
      {tab === "script" && renderState === "loading" && <Spinner />}
      {tab === "script" && renderError && <p className="err">{renderError}</p>}
      {tab === "script" && scriptResults.length > 0 && (
        <Card title="成片输出">
          <div style={{ display: "grid", gap: 16 }}>
            {scriptResults.map((r, i) =>
              r.outputPath ? (
                <div key={i}>
                  <video
                    controls
                    preload="metadata"
                    src={localVideoUrl(r.outputPath)}
                    style={{
                      display: "block",
                      width: "100%",
                      maxWidth: 720,
                      background: "#000",
                    }}
                  />
                  <div className="row" style={{ marginTop: 8, gap: 8 }}>
                    <span className="muted small">{nameOf(r.outputPath)}</span>
                    <button
                      className="ghost"
                      onClick={() => window.api.showItemInFolder(r.outputPath)}
                    >
                      打开文件位置
                    </button>
                  </div>
                </div>
              ) : (
                <p className="err" key={i}>
                  {r.error || "导出失败"}
                </p>
              ),
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
