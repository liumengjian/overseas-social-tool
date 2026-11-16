// AI 生图聊天记录的分片存储：索引（index.json）只放轻量条目，每条记录单独一个文件。
//
// 旧实现把整份历史（版本 2）写在一个 JSON 里，实测已到 280MB：主进程每次都要整体
// JSON.parse 再整体串回渲染进程，每生成一张图还要整体 stringify 重写一次。拆开之后
// 打开页面只读索引（几十条 id），取历史按「距末尾偏移」分页读对应文件，保存只追加新记录。
import { app, nativeImage } from "electron";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import type { ImageHistoryPage, ImageHistoryTurn } from "../shared/ipc";

// 旧版单文件历史（oss-data/ai_image_chat_history.json）
const LEGACY_HISTORY_FILE = "ai_image_chat_history.json";
const INDEX_VERSION = 3;
// 参考图只会以 64px 缩略图展示（历史里的 references 不参与后续生成），落盘前缩到这个边长，
// 避免每页 10 条记录里再拖着几十 MB 的原图。
const REFERENCE_THUMB_EDGE = 360;
// 聊天区图片卡片最宽 520px，缩略图按 640px 落盘（够 520px 宽显示，又比原图小得多）。
// 原图仍完整保留在记录里：复制、下载、查看大图、局部修改都必须用原图，不能给缩略图。
const CHAT_THUMB_EDGE = 640;

interface IndexEntry {
  id: string;
}

interface IndexFile {
  version: number;
  turns: IndexEntry[];
}

function ossDir(): string {
  return join(app.getPath("userData"), "oss-data");
}

function historyDir(): string {
  const dir = join(ossDir(), "ai-image-history");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function turnsDir(): string {
  const dir = join(historyDir(), "turns");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(): string {
  return join(historyDir(), "index.json");
}

// id 来自渲染进程（时间戳-序号），这里只做文件名安全化，避免任何路径字符。
function safeId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  return safe || "turn";
}

function turnPath(id: string): string {
  return join(turnsDir(), `${safeId(id)}.json`);
}

function readIndex(): IndexFile {
  const file = indexPath();
  if (!existsSync(file)) return { version: INDEX_VERSION, turns: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as
      | Partial<IndexFile>
      | null;
    if (!parsed || !Array.isArray(parsed.turns)) {
      throw new Error("索引缺少 turns 列表");
    }
    const turns = parsed.turns.filter(
      (entry): entry is IndexEntry =>
        !!entry && typeof (entry as IndexEntry).id === "string",
    );
    return { version: INDEX_VERSION, turns };
  } catch (cause) {
    // 索引存在但读不出来时不能当成「没有历史」：那会让用户看不出数据其实还在。
    throw new Error(
      `读取聊天记录索引失败：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function writeIndex(index: IndexFile): void {
  writeFileSync(
    indexPath(),
    JSON.stringify({ version: INDEX_VERSION, turns: index.turns }, null, 2),
    "utf-8",
  );
}

function writeTurnFile(turn: ImageHistoryTurn): void {
  const target = turnPath(turn.id);
  const temp = `${target}.tmp`;
  writeFileSync(temp, JSON.stringify(turn), "utf-8");
  rmSync(target, { force: true });
  renameSync(temp, target);
}

function shrinkReference(dataUrl: string): string {
  if (!dataUrl.startsWith("data:image/")) return dataUrl;
  try {
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) return dataUrl;
    const { width, height } = image.getSize();
    if (!width || !height) return dataUrl;
    if (Math.max(width, height) <= REFERENCE_THUMB_EDGE) return dataUrl;
    const resized =
      width >= height
        ? image.resize({ width: REFERENCE_THUMB_EDGE, quality: "good" })
        : image.resize({ height: REFERENCE_THUMB_EDGE, quality: "good" });
    if (resized.isEmpty()) return dataUrl;
    return resized.toDataURL();
  } catch {
    // 缩放失败时保留原图，宁可占空间也不能丢用户的参考图。
    return dataUrl;
  }
}

/** 生成聊天区展示用的缩略图；失败时返回 undefined，前端会回退到原图。 */
function makeChatThumbnail(b64: string, contentType: string): string | undefined {
  const dataUrl = b64.startsWith("data:") ? b64 : `data:${contentType};base64,${b64}`;
  try {
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) return undefined;
    const { width, height } = image.getSize();
    if (!width || !height) return undefined;
    if (Math.max(width, height) <= CHAT_THUMB_EDGE) return dataUrl;
    const resized =
      width >= height
        ? image.resize({ width: CHAT_THUMB_EDGE, quality: "good" })
        : image.resize({ height: CHAT_THUMB_EDGE, quality: "good" });
    if (resized.isEmpty()) return undefined;
    return resized.toDataURL();
  } catch {
    return undefined;
  }
}

/**
 * 把宽松的输入收敛成可落盘的记录；返回 null 表示这条记录没有可展示内容（例如残留的 pending 占位）。
 */
function normalizeTurn(
  raw: unknown,
  options: { shrinkReferences: boolean; makeThumbnail: boolean },
): ImageHistoryTurn | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const b64 = typeof source.b64 === "string" && source.b64 ? source.b64 : undefined;
  const url = typeof source.url === "string" && source.url ? source.url : undefined;
  const error =
    typeof source.error === "string" && source.error ? source.error : undefined;
  if (!b64 && !url && !error) return null;
  const contentType =
    typeof source.contentType === "string" && source.contentType
      ? source.contentType
      : "image/png";
  const prompt = typeof source.prompt === "string" ? source.prompt : "";
  const id =
    typeof source.id === "string" && source.id.trim()
      ? source.id
      : `history-${Date.now()}`;
  let references: ImageHistoryTurn["references"];
  if (Array.isArray(source.references)) {
    const list: NonNullable<ImageHistoryTurn["references"]> = [];
    for (const item of source.references) {
      if (!item || typeof item !== "object") continue;
      const ref = item as Record<string, unknown>;
      if (typeof ref.dataUrl !== "string" || !ref.dataUrl) continue;
      list.push({
        name: typeof ref.name === "string" && ref.name ? ref.name : "参考图",
        dataUrl: options.shrinkReferences
          ? shrinkReference(ref.dataUrl)
          : ref.dataUrl,
      });
    }
    if (list.length) references = list;
  }
  // 已有缩略图就沿用（重复保存时不重新编码）；新记录写入时才生成。
  const existingThumb =
    typeof source.thumb === "string" && source.thumb ? source.thumb : undefined;
  const thumb =
    existingThumb ??
    (options.makeThumbnail && b64 ? makeChatThumbnail(b64, contentType) : undefined);
  return { id, prompt, contentType, b64, url, error, thumb, references };
}

function readTurnFile(id: string): ImageHistoryTurn | null {
  try {
    const turn = normalizeTurn(
      JSON.parse(readFileSync(turnPath(id), "utf-8")),
      { shrinkReferences: false, makeThumbnail: false },
    );
    if (!turn) return null;
    // 索引里的 id 是权威值，避免文件内容与索引不一致导致前端 id 混乱。
    return { ...turn, id };
  } catch {
    return null;
  }
}

/**
 * 迁移旧版单文件历史：拆成「索引 + 每条一个文件」。
 * 只有全部写入成功后才会把旧文件改名备份（绝不删除），迁移途中失败时不改名，下次仍可重来。
 */
function migrateLegacyHistory(legacyPath: string): void {
  const parsed = JSON.parse(readFileSync(legacyPath, "utf-8")) as unknown;
  const list: unknown[] = Array.isArray(parsed)
    ? // 旧版按倒序保存，翻转成时间正序
      [...(parsed as unknown[])].reverse()
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { images?: unknown }).images)
      ? ((parsed as { images: unknown[] }).images as unknown[])
      : [];
  const index: IndexFile = { version: INDEX_VERSION, turns: [] };
  const used = new Set<string>();
  for (const item of list) {
    const turn = normalizeTurn(item, {
      shrinkReferences: true,
      makeThumbnail: true,
    });
    if (!turn) continue;
    let id = turn.id;
    let suffix = 2;
    while (used.has(id)) id = `${turn.id}-${suffix++}`;
    used.add(id);
    writeTurnFile({ ...turn, id });
    index.turns.push({ id });
  }
  writeIndex(index);
  try {
    renameSync(legacyPath, `${legacyPath}.bak`);
  } catch {
    // 改名失败不致命：旧文件原样保留，新索引已可用。
  }
}

let migrationChecked = false;

function ensureHistoryMigrated(): void {
  if (migrationChecked) return;
  const legacyPath = join(ossDir(), LEGACY_HISTORY_FILE);
  // 已有新索引（或从来没有旧数据）就不用迁移。
  if (existsSync(indexPath()) || !existsSync(legacyPath)) {
    migrationChecked = true;
    return;
  }
  try {
    migrateLegacyHistory(legacyPath);
    migrationChecked = true;
  } catch (cause) {
    // 迁移失败时让调用方拿到错误：此时历史读不出来，必须让用户看见而不是静默变空。
    throw new Error(
      `迁移聊天记录失败：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * 按「距末尾的偏移」分页读取：offset=0 表示最新的一页，offset=已加载条数即可继续往前取。
 * 返回的 turns 按时间正序（旧 → 新），nextOffset 是下次继续往前取时应使用的偏移。
 */
export function pageImageHistory(args: {
  offset?: number;
  limit?: number;
}): ImageHistoryPage {
  ensureHistoryMigrated();
  const index = readIndex();
  const total = index.turns.length;
  const offset = Number.isFinite(args.offset)
    ? Math.max(0, Math.floor(Number(args.offset)))
    : 0;
  const limit = Number.isFinite(args.limit)
    ? Math.min(Math.max(1, Math.floor(Number(args.limit))), 100)
    : 10;
  const end = Math.max(total - offset, 0);
  const start = Math.max(end - limit, 0);
  const slice = index.turns.slice(start, end);
  const turns: ImageHistoryTurn[] = [];
  for (const entry of slice) {
    const turn = readTurnFile(entry.id);
    // 有缩略图时不再把原图传给渲染进程：聊天区只用缩略图展示，
    // 原图在复制 / 下载 / 查看大图 / 局部修改时按 id 单独取（见 readImageHistoryTurn）。
    if (turn) turns.push(turn.thumb && turn.b64 ? { ...turn, b64: undefined } : turn);
  }
  return { total, turns, nextOffset: offset + slice.length };
}

/**
 * 按 id 取单条完整记录（含原图），用于复制、下载、查看大图、局部修改。
 */
export function readImageHistoryTurn(id: unknown): ImageHistoryTurn | null {
  if (typeof id !== "string" || !id) return null;
  ensureHistoryMigrated();
  const index = readIndex();
  if (!index.turns.some((entry) => entry.id === id)) return null;
  return readTurnFile(id);
}

/**
 * 追加若干条新记录（生成 / 重新生成 / 局部修改后调用）。
 * 只写这几条自己的文件 + 更新索引，不再把整份历史重新序列化。
 */
export function saveImageHistoryTurns(rawTurns: unknown[]): {
  total: number;
  added: number;
  saved: Array<{ id: string; thumb?: string }>;
} {
  ensureHistoryMigrated();
  const index = readIndex();
  const existing = new Set(index.turns.map((entry) => entry.id));
  let added = 0;
  const saved: Array<{ id: string; thumb?: string }> = [];
  for (const raw of rawTurns) {
    const turn = normalizeTurn(raw, {
      shrinkReferences: true,
      makeThumbnail: true,
    });
    if (!turn) continue;
    // 同一批次重复提交（例如渲染层副作用被触发两次）直接跳过，保证幂等。
    if (existing.has(turn.id)) continue;
    writeTurnFile(turn);
    index.turns.push({ id: turn.id });
    existing.add(turn.id);
    // 把缩略图回传渲染层：原图已落盘，内存里可以只留缩略图。
    saved.push({ id: turn.id, thumb: turn.thumb });
    added++;
  }
  if (added) writeIndex(index);
  return { total: index.turns.length, added, saved };
}
