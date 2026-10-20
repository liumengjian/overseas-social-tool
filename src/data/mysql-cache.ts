// MySQL 云端缓存：为「热点 / 账号分析 / 爆款拆解」三类结果提供跨重启、跨设备共享的缓存存储。
// 设计要点：
//   - 懒连接：首次读写时才建连接池；连接失败（服务器不可达/网络断）静默降级为「不缓存」，
//     绝不影响主流程（缓存只是优化不是依赖）。
//   - 失败冷却：连接失败后 60s 内不再重试，避免每次请求都空等超时。
//   - 表结构兼容 MySQL 5.7（无窗口函数、LONGTEXT 存 JSON、utf8mb4）。
import mysql, { Pool } from "mysql2/promise";
import type { AppConfig } from "../shared/types";

export interface MysqlCacheOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** 缓存条目（读取结果） */
export interface CacheEntry {
  data: any; // 已 JSON.parse
  createdAt: string; // 'YYYY-MM-DD HH:mm:ss'
  date?: string; // 热点类：当天日期 'YYYY-MM-DD'
}

/** AI 生图模板分类。模板数据只允许存储在 MySQL，不使用本地 JSON 作为降级。 */
export interface ImageTemplateCategoryRecord {
  id: string;
  name: string;
  createdAt: string;
}

/** AI 生图模板，category 是联表返回的分类名称，便于渲染进程直接展示。 */
export interface ImageTemplateRecord {
  id: string;
  title: string;
  description: string;
  categoryId: string;
  category: string;
  imageDataUrl: string;
  aspectRatio: string;
  createdAt: string;
}

export interface CreateImageTemplateInput {
  id: string;
  title: string;
  description: string;
  categoryId: string;
  imageDataUrl: string;
  aspectRatio: string;
}

export interface UpdateImageTemplateInput {
  id: string;
  title: string;
  description: string;
  categoryId: string;
  imageDataUrl?: string;
  aspectRatio?: string;
}

export interface SopReplyRecord {
  id: string;
  label: string;
  content: string;
  createdAt: string;
}

const RETRY_COOLDOWN_MS = 60_000; // 连接失败后 60s 冷却
const QUERY_TIMEOUT_MS = 8_000; // 单次读写超时（服务器慢不拖累主流程）

export class MysqlCache {
  private pool: Pool | null = null;
  private lastFailAt = 0;
  private lastError: string | null = null;
  private opts: MysqlCacheOptions | null = null;

  constructor(cfg?: Partial<AppConfig> | null) {
    this.applyConfig(cfg);
  }

  /** 配置变更后调用：清空旧连接池，下次读写按新配置连接 */
  applyConfig(cfg?: Partial<AppConfig> | null): void {
    const host = (cfg?.mysqlHost ?? "").trim();
    const password = (cfg?.mysqlPassword ?? "").trim();
    if (host && password && cfg?.mysqlDatabase) {
      this.opts = {
        host,
        port: Number(cfg.mysqlPort ?? 3306) || 3306,
        user: (cfg.mysqlUser ?? "").trim(),
        password,
        database: cfg.mysqlDatabase.trim(),
      };
    } else {
      this.opts = null;
    }
    this.pool = null;
    this.lastFailAt = 0;
    this.lastError = null;
  }

  get enabled(): boolean {
    return !!this.opts;
  }

  /** 应用启动时调用：提前建立连接池并确保 api_cache 表存在（失败静默，首次读写时会再尝试） */
  async init(): Promise<boolean> {
    return !!(await this.connect());
  }

  private async connect(): Promise<Pool | null> {
    if (!this.opts) return null;
    if (this.pool) return this.pool;
    if (Date.now() - this.lastFailAt < RETRY_COOLDOWN_MS) return null;
    try {
      const pool = mysql.createPool({
        ...this.opts!,
        connectionLimit: 3,
        waitForConnections: true,
        queueLimit: 10,
        charset: "utf8mb4",
        connectTimeout: QUERY_TIMEOUT_MS,
        dateStrings: true, // DATETIME 以 'YYYY-MM-DD HH:mm:ss' 字符串返回，便于过期判断
      });
      // 建表（幂等）：cache_type 区分热点、自身账号、竞对账号和视频拆解。
      await pool.query(`
        CREATE TABLE IF NOT EXISTS api_cache (
          cache_key   VARCHAR(255) NOT NULL PRIMARY KEY,
          cache_type  VARCHAR(32)  NOT NULL,
          cache_date  VARCHAR(10)  NULL,
          ref_url     VARCHAR(512) NULL,
          data        LONGTEXT     NOT NULL,
          created_at  DATETIME     NOT NULL,
          KEY idx_type_date (cache_type, cache_date),
          KEY idx_ref (ref_url)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      // 兼容旧版本已经创建的 VARCHAR(16) 表结构。
      await pool
        .query(
          "ALTER TABLE api_cache MODIFY COLUMN cache_type VARCHAR(32) NOT NULL",
        )
        .catch(() => {});
      // AI 生图模板由用户创建且必须保存在数据库中。分类独立建表，避免模板以
      // 自由文本保存分类后产生孤儿分类或重复分类。
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ai_image_template_categories (
          id          CHAR(36)     NOT NULL PRIMARY KEY,
          name        VARCHAR(191) NOT NULL,
          created_at  DATETIME     NOT NULL,
          sort_order  INT          NOT NULL DEFAULT 0,
          UNIQUE KEY uq_ai_image_template_category_name (name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await pool
        .query(
          "ALTER TABLE ai_image_template_categories ADD COLUMN sort_order INT NOT NULL DEFAULT 0",
        )
        .catch(() => {});
      // 旧版本可能已经创建了不同排序规则或非 InnoDB 表；先统一父表，避免
      // 后续模板表外键因字符集/引擎不一致而初始化失败。
      await pool
        .query(
          "ALTER TABLE ai_image_template_categories ENGINE=InnoDB, CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
        )
        .catch(() => {});
      await pool
        .query(
          "ALTER TABLE ai_image_templates ENGINE=InnoDB, CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
        )
        .catch(() => {});
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ai_image_templates (
          id              CHAR(36)     NOT NULL PRIMARY KEY,
          title           VARCHAR(255) NOT NULL,
          description     TEXT         NOT NULL,
          category_id     CHAR(36)     NOT NULL,
          image_data_url  LONGTEXT     NOT NULL,
          aspect_ratio    VARCHAR(32)  NOT NULL,
          created_at      DATETIME     NOT NULL,
          KEY idx_ai_image_templates_category_id (category_id),
          CONSTRAINT fk_ai_image_templates_category
            FOREIGN KEY (category_id) REFERENCES ai_image_template_categories(id)
            ON DELETE RESTRICT ON UPDATE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS customer_sop_replies (
          id CHAR(36) NOT NULL PRIMARY KEY,
          label VARCHAR(255) NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          created_at DATETIME NOT NULL,
          KEY idx_customer_sop_replies_label (label),
          KEY idx_customer_sop_replies_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await pool
        .query(
          "ALTER TABLE customer_sop_replies ADD COLUMN label VARCHAR(255) NOT NULL DEFAULT '' AFTER id",
        )
        .catch(() => {});
      await pool
        .query(
          "ALTER TABLE customer_sop_replies ADD KEY idx_customer_sop_replies_label (label)",
        )
        .catch(() => {});
      // TTS 音色表：存储所有可用音色
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tts_voices (
          id              INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
          name            VARCHAR(255) NOT NULL,
          short_name      VARCHAR(255) NOT NULL,
          gender          VARCHAR(32)  NOT NULL,
          locale          VARCHAR(32)  NOT NULL,
          friendly_name   VARCHAR(255) NOT NULL,
          voice_type      VARCHAR(32)  NOT NULL,
          created_at      DATETIME     NOT NULL,
          KEY idx_tts_voices_locale (locale),
          UNIQUE KEY uq_tts_voices_short_name (short_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      // TTS 音色国家/地区表：存储所有可用的 Locale
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tts_locales (
          id              INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
          locale          VARCHAR(32)  NOT NULL,
          label           VARCHAR(255) NOT NULL,
          sort_order      INT          NOT NULL DEFAULT 0,
          created_at      DATETIME     NOT NULL,
          UNIQUE KEY uq_tts_locales_locale (locale)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      this.pool = pool;
      this.lastError = null;
      return pool;
    } catch (error) {
      this.lastFailAt = Date.now();
      this.pool = null;
      this.lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  /** 模板是业务数据，不能像缓存一样悄悄降级。 */
  private async requirePool(): Promise<Pool> {
    if (!this.opts)
      throw new Error("未配置数据库，请先在设置页完成数据库配置。");
    const pool = await this.connect();
    if (!pool) {
      const reason = this.lastError ? `：${this.lastError}` : "";
      throw new Error(`数据库连接或模板表初始化失败${reason}`);
    }
    return pool;
  }

  private now(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  }

  private templateError(action: string, error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`${action}失败：${message}`);
  }

  async listImageTemplateCategories(): Promise<ImageTemplateCategoryRecord[]> {
    try {
      const pool = await this.requirePool();
      const [rows] = await pool.query(
        "SELECT id, name, created_at FROM ai_image_template_categories ORDER BY sort_order ASC, created_at DESC, name ASC",
      );
      return (rows as any[]).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        createdAt: String(row.created_at),
      }));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("未配置数据库"))
        throw error;
      if (
        error instanceof Error &&
        error.message.startsWith("数据库连接或模板表初始化失败")
      )
        throw error;
      throw this.templateError("读取模板分类", error);
    }
  }

  async createImageTemplateCategory(
    id: string,
    name: string,
  ): Promise<ImageTemplateCategoryRecord> {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("模板分类名称不能为空。");
    if (normalizedName.length > 191)
      throw new Error("模板分类名称不能超过 191 个字符。");
    try {
      const pool = await this.requirePool();
      const [maxRows] = await pool.query(
        "SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM ai_image_template_categories",
      );
      const nextOrder = Number((maxRows as any[])[0]?.max_order ?? -1) + 1;
      await pool.query(
        "INSERT INTO ai_image_template_categories (id, name, created_at, sort_order) VALUES (?, ?, ?, ?)",
        [id, normalizedName, this.now(), nextOrder],
      );
      const [rows] = await pool.query(
        "SELECT id, name, created_at FROM ai_image_template_categories WHERE id = ? LIMIT 1",
        [id],
      );
      const row = (rows as any[])[0];
      return {
        id: String(row.id),
        name: String(row.name),
        createdAt: String(row.created_at),
      };
    } catch (error: any) {
      if (error?.code === "ER_DUP_ENTRY")
        throw new Error("模板分类已存在，请使用已有分类。");
      if (
        error instanceof Error &&
        (error.message.startsWith("未配置数据库") ||
          error.message.startsWith("数据库连接或模板表初始化失败"))
      )
        throw error;
      throw this.templateError("创建模板分类", error);
    }
  }

  async updateImageTemplateCategory(
    id: string,
    name: string,
  ): Promise<ImageTemplateCategoryRecord> {
    const normalizedId = id.trim();
    const normalizedName = name.trim();
    if (!normalizedId || !normalizedName)
      throw new Error("模板分类名称不能为空。");
    if (normalizedName.length > 191)
      throw new Error("模板分类名称不能超过 191 个字符。");
    try {
      const pool = await this.requirePool();
      const [result] = await pool.query(
        "UPDATE ai_image_template_categories SET name = ? WHERE id = ?",
        [normalizedName, normalizedId],
      );
      if (Number((result as any).affectedRows ?? 0) === 0)
        throw new Error("模板分类不存在或已被删除，请刷新后重试。");
      const [rows] = await pool.query(
        "SELECT id, name, created_at FROM ai_image_template_categories WHERE id = ? LIMIT 1",
        [normalizedId],
      );
      const row = (rows as any[])[0];
      return {
        id: String(row.id),
        name: String(row.name),
        createdAt: String(row.created_at),
      };
    } catch (error: any) {
      if (error?.code === "ER_DUP_ENTRY")
        throw new Error("模板分类已存在，请使用其他名称。");
      if (
        error instanceof Error &&
        (error.message.startsWith("未配置数据库") ||
          error.message.startsWith("数据库连接或模板表初始化失败") ||
          error.message.startsWith("模板分类不存在"))
      )
        throw error;
      throw this.templateError("更新模板分类", error);
    }
  }

  async reorderImageTemplateCategories(ids: string[]): Promise<void> {
    const normalizedIds = ids.map((id) => id.trim()).filter(Boolean);
    if (!normalizedIds.length) return;
    try {
      const pool = await this.requirePool();
      await Promise.all(
        normalizedIds.map((id, index) =>
          pool.query(
            "UPDATE ai_image_template_categories SET sort_order = ? WHERE id = ?",
            [index, id],
          ),
        ),
      );
    } catch (error) {
      throw this.templateError("保存模板分类排序", error);
    }
  }

  async deleteImageTemplateCategory(id: string): Promise<boolean> {
    const normalizedId = id.trim();
    if (!normalizedId) throw new Error("模板分类 ID 不能为空。");
    try {
      const pool = await this.requirePool();
      const [templateRows] = await pool.query(
        "SELECT COUNT(*) AS total FROM ai_image_templates WHERE category_id = ?",
        [normalizedId],
      );
      const total = Number((templateRows as any[])[0]?.total ?? 0);
      if (total > 0)
        throw new Error(
          `该分类下还有 ${total} 个模板，请先移走或删除模板后再删除分类。`,
        );
      const [result] = await pool.query(
        "DELETE FROM ai_image_template_categories WHERE id = ?",
        [normalizedId],
      );
      if (Number((result as any).affectedRows ?? 0) === 0)
        throw new Error("模板分类不存在或已被删除，请刷新后重试。");
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("未配置数据库") ||
          error.message.startsWith("数据库连接或模板表初始化失败") ||
          error.message.startsWith("该分类下还有") ||
          error.message.startsWith("模板分类不存在"))
      )
        throw error;
      throw this.templateError("删除模板分类", error);
    }
  }

  async listImageTemplates(): Promise<ImageTemplateRecord[]> {
    try {
      const pool = await this.requirePool();
      const [rows] = await pool.query(`
        SELECT t.id, t.title, t.description, t.category_id, c.name AS category,
               t.image_data_url, t.aspect_ratio, t.created_at
        FROM ai_image_templates t
        INNER JOIN ai_image_template_categories c ON c.id = t.category_id
        ORDER BY t.created_at DESC
      `);
      return (rows as any[]).map((row) => ({
        id: String(row.id),
        title: String(row.title),
        description: String(row.description),
        categoryId: String(row.category_id),
        category: String(row.category),
        imageDataUrl: String(row.image_data_url),
        aspectRatio: String(row.aspect_ratio),
        createdAt: String(row.created_at),
      }));
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("未配置数据库") ||
          error.message.startsWith("数据库连接或模板表初始化失败"))
      )
        throw error;
      throw this.templateError("读取模板库", error);
    }
  }

  async createImageTemplate(
    input: CreateImageTemplateInput,
  ): Promise<ImageTemplateRecord> {
    const title = input.title.trim();
    const description = input.description.trim();
    const categoryId = input.categoryId.trim();
    const imageDataUrl = input.imageDataUrl.trim();
    const aspectRatio = input.aspectRatio.trim();
    if (
      !title ||
      !description ||
      !categoryId ||
      !imageDataUrl ||
      !aspectRatio
    ) {
      throw new Error("模板图片、标题、描述、分类均为必填项。");
    }
    if (title.length > 255) throw new Error("模板标题不能超过 255 个字符。");
    try {
      const pool = await this.requirePool();
      const [categoryRows] = await pool.query(
        "SELECT id FROM ai_image_template_categories WHERE id = ? LIMIT 1",
        [categoryId],
      );
      if (!(categoryRows as any[])[0])
        throw new Error("所选模板分类不存在，请刷新后重试。");
      await pool.query(
        `INSERT INTO ai_image_templates
          (id, title, description, category_id, image_data_url, aspect_ratio, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          title,
          description,
          categoryId,
          imageDataUrl,
          aspectRatio,
          this.now(),
        ],
      );
      const [rows] = await pool.query(
        `
        SELECT t.id, t.title, t.description, t.category_id, c.name AS category,
               t.image_data_url, t.aspect_ratio, t.created_at
        FROM ai_image_templates t
        INNER JOIN ai_image_template_categories c ON c.id = t.category_id
        WHERE t.id = ? LIMIT 1
      `,
        [input.id],
      );
      const row = (rows as any[])[0];
      return {
        id: String(row.id),
        title: String(row.title),
        description: String(row.description),
        categoryId: String(row.category_id),
        category: String(row.category),
        imageDataUrl: String(row.image_data_url),
        aspectRatio: String(row.aspect_ratio),
        createdAt: String(row.created_at),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("未配置数据库") ||
          error.message.startsWith("数据库连接或模板表初始化失败") ||
          error.message.startsWith("所选模板分类不存在"))
      )
        throw error;
      throw this.templateError("创建模板", error);
    }
  }

  async updateImageTemplate(
    input: UpdateImageTemplateInput,
  ): Promise<ImageTemplateRecord> {
    const id = input.id.trim();
    const title = input.title.trim();
    const description = input.description.trim();
    const categoryId = input.categoryId.trim();
    const imageDataUrl = input.imageDataUrl?.trim();
    const aspectRatio = input.aspectRatio?.trim();
    if (!id || !title || !description || !categoryId) {
      throw new Error("模板标题、描述和分类均为必填项。");
    }
    if (title.length > 255) throw new Error("模板标题不能超过 255 个字符。");
    if (imageDataUrl && !aspectRatio)
      throw new Error("替换模板图片时缺少图片比例。");
    try {
      const pool = await this.requirePool();
      const [categoryRows] = await pool.query(
        "SELECT id FROM ai_image_template_categories WHERE id = ? LIMIT 1",
        [categoryId],
      );
      if (!(categoryRows as any[])[0])
        throw new Error("所选模板分类不存在，请刷新后重试。");
      const [result] = await pool.query(
        `UPDATE ai_image_templates
         SET title = ?, description = ?, category_id = ?,
             image_data_url = COALESCE(?, image_data_url),
             aspect_ratio = COALESCE(?, aspect_ratio)
         WHERE id = ?`,
        [
          title,
          description,
          categoryId,
          imageDataUrl || null,
          aspectRatio || null,
          id,
        ],
      );
      if (Number((result as any).affectedRows ?? 0) === 0)
        throw new Error("模板不存在或已被删除，请刷新后重试。");
      const [rows] = await pool.query(
        `
        SELECT t.id, t.title, t.description, t.category_id, c.name AS category,
               t.image_data_url, t.aspect_ratio, t.created_at
        FROM ai_image_templates t
        INNER JOIN ai_image_template_categories c ON c.id = t.category_id
        WHERE t.id = ? LIMIT 1
      `,
        [id],
      );
      const row = (rows as any[])[0];
      return {
        id: String(row.id),
        title: String(row.title),
        description: String(row.description),
        categoryId: String(row.category_id),
        category: String(row.category),
        imageDataUrl: String(row.image_data_url),
        aspectRatio: String(row.aspect_ratio),
        createdAt: String(row.created_at),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("未配置数据库") ||
          error.message.startsWith("数据库连接或模板表初始化失败") ||
          error.message.startsWith("所选模板分类不存在") ||
          error.message.startsWith("模板不存在"))
      )
        throw error;
      throw this.templateError("更新模板", error);
    }
  }

  async deleteImageTemplate(id: string): Promise<boolean> {
    if (!id.trim()) throw new Error("模板 ID 不能为空。");
    try {
      const pool = await this.requirePool();
      const [result] = await pool.query(
        "DELETE FROM ai_image_templates WHERE id = ?",
        [id],
      );
      return Number((result as any).affectedRows ?? 0) > 0;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("未配置数据库") ||
          error.message.startsWith("数据库连接或模板表初始化失败"))
      )
        throw error;
      throw this.templateError("删除模板", error);
    }
  }

  async listSopReplies(): Promise<SopReplyRecord[]> {
    try {
      const pool = await this.requirePool();
      const [rows] = await pool.query(
        "SELECT id, label, content, created_at FROM customer_sop_replies ORDER BY created_at DESC",
      );
      return (rows as any[]).map((row) => ({
        id: String(row.id),
        label: String(row.label ?? ""),
        content: String(row.content),
        createdAt: String(row.created_at),
      }));
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith("未配置数据库") || error.message.startsWith("数据库连接或模板表初始化失败"))) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/ECONNRESET|PROTOCOL_CONNECTION_LOST|EPIPE|ETIMEDOUT/i.test(message)) {
        this.pool = null;
        this.lastFailAt = 0;
        throw new Error("读取客服 SOP 记录失败：数据库连接已断开，请检查数据库服务或网络后重试。");
      }
      throw new Error(`读取客服 SOP 记录失败：${message}`);
    }
  }

  async createSopReply(
    id: string,
    label: string,
    content: string,
  ): Promise<SopReplyRecord> {
    const labelValue = label.trim();
    const value = content.trim();
    if (!labelValue || !value) throw new Error("SOP 标签和回复文案不能为空。");
    const pool = await this.requirePool();
    const createdAt = this.now();
    await pool.query(
      "INSERT INTO customer_sop_replies (id, label, content, created_at) VALUES (?, ?, ?, ?)",
      [id, labelValue, value, createdAt],
    );
    return { id, label: labelValue, content: value, createdAt };
  }

  async updateSopReply(
    id: string,
    label: string,
    content: string,
  ): Promise<SopReplyRecord> {
    const labelValue = label.trim();
    const value = content.trim();
    if (!id.trim() || !labelValue || !value)
      throw new Error("SOP 标签和回复文案不能为空。");
    const pool = await this.requirePool();
    const [result] = await pool.query(
      "UPDATE customer_sop_replies SET label = ?, content = ? WHERE id = ?",
      [labelValue, value, id],
    );
    if (Number((result as any).affectedRows ?? 0) === 0)
      throw new Error("SOP 回复不存在或已被删除，请刷新后重试。");
    const [rows] = await pool.query(
      "SELECT id, label, content, created_at FROM customer_sop_replies WHERE id = ? LIMIT 1",
      [id],
    );
    const row = (rows as any[])[0];
    return {
      id: String(row.id),
      label: String(row.label ?? ""),
      content: String(row.content),
      createdAt: String(row.created_at),
    };
  }

  async deleteSopReply(id: string): Promise<boolean> {
    const pool = await this.requirePool();
    const [result] = await pool.query(
      "DELETE FROM customer_sop_replies WHERE id = ?",
      [id],
    );
    return Number((result as any).affectedRows ?? 0) > 0;
  }

  // TTS 音色管理方法

  /** 同步音色数据到数据库（从 node-edge-tts 在线获取） */
  async syncTtsVoices(voices: any[]): Promise<void> {
    const pool = await this.requirePool();
    const now = this.now();

    // 提取所有唯一的 locale
    const localeLabels = new Map<string, string>();
    voices.forEach((v) => {
      const locale = String(v.Locale ?? v.locale ?? "").trim();
      if (locale) {
        localeLabels.set(
          locale,
          String(v.LocaleName ?? v.localeName ?? locale).trim() || locale,
        );
      }
    });

    // 插入或更新 locales（按中文优先排序）
    const locales = Array.from(localeLabels.keys()).sort((a, b) => {
      if (a.startsWith('zh-')) return -1;
      if (b.startsWith('zh-')) return 1;
      return a.localeCompare(b);
    });

    for (let i = 0; i < locales.length; i++) {
      const locale = locales[i];
      await pool.query(
        `INSERT INTO tts_locales (locale, label, sort_order, created_at)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE label = ?, sort_order = ?`,
        [locale, localeLabels.get(locale) || locale, i, now, localeLabels.get(locale) || locale, i]
      );
    }

    // 插入或更新音色
    for (const v of voices) {
      await pool.query(
        `INSERT INTO tts_voices (name, short_name, gender, locale, friendly_name, voice_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           gender = VALUES(gender),
           locale = VALUES(locale),
           friendly_name = VALUES(friendly_name),
           voice_type = VALUES(voice_type)`,
        [
          v.Name ?? v.name ?? '',
          v.ShortName ?? v.shortName ?? '',
          v.Gender ?? v.gender ?? '',
          v.Locale ?? v.locale ?? '',
          v.FriendlyName ?? v.friendlyName ?? '',
          v.VoiceType ?? v.voiceType ?? 'Neural',
          now
        ]
      );
    }
  }

  /** 获取所有 locale（国家/地区列表） */
  async listTtsLocales(): Promise<Array<{ locale: string; label: string }>> {
    try {
      const pool = await this.requirePool();
      const [rows] = await pool.query(
        "SELECT locale, label FROM tts_locales ORDER BY sort_order ASC"
      );
      return (rows as any[]).map(row => ({
        locale: String(row.locale),
        label: String(row.label),
      }));
    } catch (error) {
      return [];
    }
  }

  /** 根据 locale 获取音色列表 */
  async listTtsVoicesByLocale(locale: string): Promise<Array<{
    name: string;
    shortName: string;
    gender: string;
    locale: string;
    friendlyName: string;
    voiceType: string;
  }>> {
    try {
      const pool = await this.requirePool();
      const [rows] = await pool.query(
        `SELECT name, short_name, gender, locale, friendly_name, voice_type
         FROM tts_voices
         WHERE locale = ?
         ORDER BY friendly_name ASC`,
        [locale]
      );
      return (rows as any[]).map(row => ({
        name: String(row.name),
        shortName: String(row.short_name),
        gender: String(row.gender),
        locale: String(row.locale),
        friendlyName: String(row.friendly_name),
        voiceType: String(row.voice_type),
      }));
    } catch (error) {
      return [];
    }
  }

  /** 检查音色数据库是否为空 */
  async isTtsVoicesEmpty(): Promise<boolean> {
    try {
      const pool = await this.requirePool();
      const [rows] = await pool.query("SELECT COUNT(*) as count FROM tts_voices");
      const count = Number((rows as any[])[0]?.count ?? 0);
      return count === 0;
    } catch (error) {
      return true;
    }
  }

  /** 读取缓存；失败/未命中返回 null */
  async get(cacheKey: string): Promise<CacheEntry | null> {
    const pool = await this.connect();
    if (!pool) return null;
    try {
      const [rows] = await pool.query(
        "SELECT data, cache_date, created_at FROM api_cache WHERE cache_key = ? LIMIT 1",
        [cacheKey],
      );
      const row = (rows as any[])[0];
      if (!row) return null;
      return {
        data: JSON.parse(row.data),
        date: row.cache_date ?? undefined,
        createdAt: row.created_at,
      };
    } catch {
      return null;
    }
  }

  /** 写入缓存（覆盖同 key）；失败返回 false（不影响主流程） */
  async set(
    cacheKey: string,
    type:
      | "hotspot"
      | "own_account"
      | "competitor_account"
      | "viral"
      | "voiceover"
      | "settings",
    data: unknown,
    opts: { date?: string; refUrl?: string } = {},
  ): Promise<boolean> {
    const pool = await this.connect();
    if (!pool) return false;
    try {
      const now = new Date();
      const dt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      await pool.query(
        `INSERT INTO api_cache (cache_key, cache_type, cache_date, ref_url, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data), cache_date = VALUES(cache_date), ref_url = VALUES(ref_url), created_at = VALUES(created_at)`,
        [
          cacheKey,
          type,
          opts.date ?? null,
          opts.refUrl ?? null,
          JSON.stringify(data),
          dt,
        ],
      );
      return true;
    } catch {
      return false;
    }
  }

  /** 按 ref_url 删除（用于账号数据过期后强制刷新时清理） */
  async deleteByRef(refUrl: string): Promise<boolean> {
    const pool = await this.connect();
    if (!pool) return false;
    try {
      await pool.query("DELETE FROM api_cache WHERE ref_url = ?", [refUrl]);
      return true;
    } catch {
      return false;
    }
  }
}
