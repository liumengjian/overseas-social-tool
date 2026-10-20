import React, { useEffect, useState } from "react";
import { Card, Spinner } from "../components/ui";
import type { ImageModelConfig } from "../../shared/types";
import { AppConfig } from "../../shared/types";

// 设置页可编辑的字段（.env 提供默认值，保存后覆盖）
type EditableConfig = Pick<
  AppConfig,
  | "tikhubApiToken"
  | "tikhubBaseUrl"
  | "fetchVideoCount"
  | "llmApiKey"
  | "llmBaseUrl"
  | "llmModel"
  | "llmFileUploadPath"
  | "sopApiKey"
  | "sopBaseUrl"
  | "sopModel"
  | "imageApiFormat"
  | "imageApiKey"
  | "imageBaseUrl"
  | "imageGeneratePath"
  | "imageEditPath"
  | "imageModel"
  | "imageModels"
  | "imageMaxResolution"
  | "imageBodyMode"
  | "imageEditStyle"
  | "imageAdvancedParams"
  | "mysqlHost"
  | "mysqlPort"
  | "mysqlUser"
  | "mysqlPassword"
  | "mysqlDatabase"
  | "cosSecretId"
  | "cosSecretKey"
  | "cosBucket"
  | "cosRegion"
  | "cosCdnDomain"
  | "hotspotCacheDays"
  | "accountCacheDays"
  | "ytdlpPath"
>;

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label
        style={{
          display: "block",
          fontSize: 12,
          color: "var(--muted)",
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      {children}
      {hint && (
        <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
};

export default function Settings() {
  const [form, setForm] = useState<EditableConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const [toast, setToast] = useState("");
  function showToast(text: string) { setToast(text); window.setTimeout(() => setToast((v) => v === text ? "" : v), 2400); }

  useEffect(() => {
    window.api
      .getConfig()
      .then((c) => {
        setForm(pick(c));
        setLoading(false);
      })
      .catch((e) => {
        setMsg({ kind: "err", text: e?.message ?? String(e) });
        setLoading(false);
      });
  }, []);

  function pick(c: AppConfig): EditableConfig {
    return {
      tikhubApiToken: c.tikhubApiToken ?? "",
      tikhubBaseUrl: c.tikhubBaseUrl ?? "",
      fetchVideoCount: c.fetchVideoCount ?? 50,
      llmApiKey: c.llmApiKey ?? "",
      llmBaseUrl: c.llmBaseUrl ?? "https://api.new.bi/v1",
      llmModel: c.llmModel ?? "gemini-3.1-pro-preview",
      llmFileUploadPath: c.llmFileUploadPath ?? "/files/upload",
      sopApiKey: c.sopApiKey ?? "",
      sopBaseUrl: c.sopBaseUrl ?? "https://ark.cn-beijing.volces.com/api/v3",
      sopModel: c.sopModel ?? "doubao-seed-2-0-lite-260215",
      imageApiFormat: c.imageApiFormat ?? "openai",
      imageApiKey: c.imageApiKey ?? "",
      imageBaseUrl: c.imageBaseUrl ?? "https://api.new.bi/v1",
      imageGeneratePath: c.imageGeneratePath ?? "/images/generations",
      imageEditPath: c.imageEditPath ?? "/images/edits",
      imageModel: c.imageModel ?? "gpt-image-2-1k",
      imageModels: c.imageModels ?? [],
      imageMaxResolution: c.imageMaxResolution ?? "1k",
      imageBodyMode: c.imageBodyMode ?? "json",
      imageEditStyle: c.imageEditStyle ?? "auto",
      imageAdvancedParams: c.imageAdvancedParams ?? "",
      mysqlHost: c.mysqlHost ?? "",
      mysqlPort: c.mysqlPort ?? 3306,
      mysqlUser: c.mysqlUser ?? "",
      mysqlPassword: c.mysqlPassword ?? "",
      mysqlDatabase: c.mysqlDatabase ?? "",
      cosSecretId: c.cosSecretId ?? "",
      cosSecretKey: c.cosSecretKey ?? "",
      cosBucket: c.cosBucket ?? "",
      cosRegion: c.cosRegion ?? "",
      cosCdnDomain: c.cosCdnDomain ?? "",
      hotspotCacheDays: c.hotspotCacheDays ?? 1,
      accountCacheDays: c.accountCacheDays ?? 7,
      ytdlpPath: c.ytdlpPath ?? "yt-dlp",
    };
  }

  function set<K extends keyof EditableConfig>(k: K, v: string) {
    setForm((f) =>
      f
        ? {
            ...f,
            [k]: [
              "fetchVideoCount",
              "mysqlPort",
              "hotspotCacheDays",
              "accountCacheDays",
            ].includes(k)
              ? Number(v) || 0
              : v,
          }
        : f,
    );
  }

  function toConfig(f: EditableConfig): AppConfig {
    const mysqlOn = !!(
      (f.mysqlHost ?? "").trim() &&
      (f.mysqlPassword ?? "").trim() &&
      (f.mysqlDatabase ?? "").trim()
    );
    const cosOn = !!(
      (f.cosSecretId ?? "").trim() &&
      (f.cosSecretKey ?? "").trim() &&
      (f.cosBucket ?? "").trim() &&
      (f.cosRegion ?? "").trim()
    );
    return {
      ...f,
      tokenConfigured: (f.tikhubApiToken ?? "").trim().length > 0,
      minimaxConfigured: (f.llmApiKey ?? "").trim().length > 0,
      imageConfigured: !!(
        (f.imageApiKey ?? "").trim() &&
        (f.imageBaseUrl ?? "").trim() &&
        (f.imageModel ?? "").trim()
      ),
      mysqlEnabled: mysqlOn,
      cosConfigured: cosOn,
    };
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    setMsg(null);
    try {
      const updated = await window.api.saveConfig(toConfig(form));
      setForm(pick(updated));
      showToast("配置已保存，立即生效。");
    } catch (e: any) {
      showToast(`保存失败：${e?.message ?? String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setSaving(true);
    setMsg(null);
    try {
      const updated = await window.api.resetConfig();
      setForm(pick(updated));
      showToast("已恢复为 .env 默认配置。");
    } catch (e: any) {
      showToast(`恢复失败：${e?.message ?? String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner text="加载配置…" />;

  return (
    <div className="page">
      <h1>十二、设置</h1>
      <p className="muted">
        依次配置数据接口、视频与生图模型、数据库及存储桶。默认值来自{" "}
        <code>.env</code>，保存后立即生效、无需重启；「恢复默认」回到 .env
        的配置。
      </p>

      {msg && <p className={msg.kind === "ok" ? "ok" : "err"}>{msg.text}</p>}

      <div className="settings-cards">
        <Card
          title="TiKhub 数据接口"
          right={
            <BadgeHint
              ok={!!(form?.tikhubApiToken ?? "").trim()}
              label="已配置"
            />
          }
        >
          <Field label="API Key" hint="留空则接口不可用（页面呈现空状态）">
            <input
              type="password"
              style={inputStyle}
              value={form?.tikhubApiToken ?? ""}
              onChange={(e) => set("tikhubApiToken", e.target.value)}
              placeholder="TIKHUB_API_TOKEN"
            />
          </Field>
          <Field label="Base URL" hint="大陆网络可改为 https://api.tikhub.dev">
            <input
              type="text"
              style={inputStyle}
              value={form?.tikhubBaseUrl ?? ""}
              onChange={(e) => set("tikhubBaseUrl", e.target.value)}
              placeholder="https://api.tikhub.io"
            />
          </Field>
          <Field label="默认抓取视频数量（上限 50，账号不足 50 条则全部抓取）">
            <input
              type="number"
              min={1}
              max={50}
              style={inputStyle}
              value={form?.fetchVideoCount ?? 50}
              onChange={(e) => set("fetchVideoCount", e.target.value)}
            />
          </Field>
        </Card>

        <Card
          title="视频解析大模型"
          right={
            <BadgeHint ok={!!(form?.llmApiKey ?? "").trim()} label="已配置" />
          }
        >
          <Field label="API Key">
            <input
              type="password"
              style={inputStyle}
              value={form?.llmApiKey ?? ""}
              onChange={(e) => set("llmApiKey", e.target.value)}
              placeholder="OpenAI 兼容 API Key"
            />
          </Field>
          <Field label="Base URL" >
            <input
              type="text"
              style={inputStyle}
              value={form?.llmBaseUrl ?? ""}
              onChange={(e) => set("llmBaseUrl", e.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </Field>
          <Field label="模型名称">
            <input
              type="text"
              style={inputStyle}
              value={form?.llmModel ?? ""}
              onChange={(e) => set("llmModel", e.target.value)}
              placeholder="填写当前使用的模型名称"
            />
          </Field>
        </Card>

        <Card
          title="文本(多模态)模型"
          right={
            <BadgeHint ok={!!(form?.sopApiKey ?? "").trim()} label="已配置" />
          }
        >
          <Field
            label="API Key"
            hint="用于SOP语料库中的回复语生成、口播文案分析。"
          >
            <input
              type="password"
              style={inputStyle}
              value={form?.sopApiKey ?? ""}
              onChange={(e) => set("sopApiKey", e.target.value)}
              placeholder="SOP_API_KEY"
            />
          </Field>
          <Field label="Base URL">
            <input
              type="text"
              style={inputStyle}
              value={form?.sopBaseUrl ?? ""}
              onChange={(e) => set("sopBaseUrl", e.target.value)}
              placeholder="https://ark.cn-beijing.volces.com/api/v3"
            />
          </Field>
          <Field label="模型名称">
            <input
              type="text"
              style={inputStyle}
              value={form?.sopModel ?? ""}
              onChange={(e) => set("sopModel", e.target.value)}
              placeholder="doubao-seed-2-0-lite-260215"
            />
          </Field>
        </Card>

        <Card
          title="生图大模型"
          right={
            <BadgeHint
              ok={
                !!(
                  (form?.imageApiKey ?? "").trim() &&
                  (form?.imageBaseUrl ?? "").trim() &&
                  (form?.imageModel ?? "").trim()
                )
              }
              label="已配置"
            />
          }
        >
          <div>
            <Field label="API Key">
              <input
                type="password"
                style={inputStyle}
                value={form?.imageApiKey ?? ""}
                onChange={(e) => set("imageApiKey", e.target.value)}
                placeholder="图像模型 API Key"
              />
            </Field>
            <Field label="Base URL">
              <input
                type="text"
                style={inputStyle}
                value={form?.imageBaseUrl ?? ""}
                onChange={(e) => set("imageBaseUrl", e.target.value)}
                placeholder="https://ark.cn-beijing.volces.com/api/v3"
              />
            </Field>
            <Field label="模型配置" hint="AI 生图时可在输入框选择模型。">
              {(form?.imageModels ?? []).map((model, index) => (
                <div className="row" style={{ gap: 6, marginBottom: 6 }} key={index}>
                  <input placeholder="模型名称" value={model.name} onChange={(e) => setForm((f) => f && ({ ...f, imageModels: f.imageModels.map((m, i) => i === index ? { ...m, name: e.target.value } : m) }))} />
                  <input type="password" placeholder="API Key" value={model.apiKey} onChange={(e) => setForm((f) => f && ({ ...f, imageModels: f.imageModels.map((m, i) => i === index ? { ...m, apiKey: e.target.value } : m) }))} />
                  <select value={model.resolution} onChange={(e) => setForm((f) => f && ({ ...f, imageModels: f.imageModels.map((m, i) => i === index ? { ...m, resolution: e.target.value } : m) }))}><option>1k</option><option>2k</option><option>4k</option></select>
                  <input placeholder="描述" value={model.description} onChange={(e) => setForm((f) => f && ({ ...f, imageModels: f.imageModels.map((m, i) => i === index ? { ...m, description: e.target.value } : m) }))} />
                </div>
              ))}
              <button className="ghost" onClick={() => setForm((f) => f && ({ ...f, imageModels: [...f.imageModels, { name: "", apiKey: "", resolution: "1k", description: "" }] }))}>添加模型</button>
            </Field>
          </div>
        </Card>

        {/* 云端缓存 & 结果缓存配置：缓存命中可大幅节省三方接口与 AI 额度 */}
        <Card
          title="数据库配置"
          right={
            <BadgeHint
              ok={
                !!(
                  (form?.mysqlHost ?? "").trim() &&
                  (form?.mysqlPassword ?? "").trim() &&
                  (form?.mysqlDatabase ?? "").trim()
                )
              }
              label="已启用"
            />
          }
        >
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 30%", minWidth: 220 }}>
              <Field
                label="MySQL 主机"
                hint="留空 = 不启用云端缓存（结果仅存本地）"
              >
                <input
                  type="text"
                  style={inputStyle}
                  value={form?.mysqlHost ?? ""}
                  onChange={(e) => set("mysqlHost", e.target.value)}
                  placeholder="如 111.229.133.119"
                />
              </Field>
            </div>
            <div style={{ flex: "1 1 15%", minWidth: 120 }}>
              <Field label="端口">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  style={inputStyle}
                  value={form?.mysqlPort ?? 3306}
                  onChange={(e) => set("mysqlPort", e.target.value)}
                />
              </Field>
            </div>
            <div style={{ flex: "1 1 25%", minWidth: 160 }}>
              <Field label="用户名">
                <input
                  type="text"
                  style={inputStyle}
                  value={form?.mysqlUser ?? ""}
                  onChange={(e) => set("mysqlUser", e.target.value)}
                  placeholder="MySQL 用户名"
                />
              </Field>
            </div>
            <div style={{ flex: "1 1 25%", minWidth: 160 }}>
              <Field label="密码">
                <input
                  type="password"
                  style={inputStyle}
                  value={form?.mysqlPassword ?? ""}
                  onChange={(e) => set("mysqlPassword", e.target.value)}
                  placeholder="MySQL 密码"
                />
              </Field>
            </div>
            <div style={{ flex: "1 1 30%", minWidth: 220 }}>
              <Field label="数据库名">
                <input
                  type="text"
                  style={inputStyle}
                  value={form?.mysqlDatabase ?? ""}
                  onChange={(e) => set("mysqlDatabase", e.target.value)}
                  placeholder="overseas_tool"
                />
              </Field>
            </div>
          </div>
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 25%", minWidth: 180 }}>
              <Field
                label="热点缓存天数"
                hint="热点/Tag 结果缓存有效天数（默认 1 = 当天有效，第二天自动失效重拉）；设为 0 = 禁用热点缓存，每次重新调用接口"
              >
                <input
                  type="number"
                  min={0}
                  max={30}
                  style={inputStyle}
                  value={form?.hotspotCacheDays ?? 1}
                  onChange={(e) => set("hotspotCacheDays", e.target.value)}
                />
              </Field>
            </div>
            <div style={{ flex: "1 1 25%", minWidth: 180 }}>
              <Field
                label="账号分析缓存天数"
                hint="竞对 / 自身账号分析结果缓存有效天数（默认 7）；设为 0 = 禁用账号缓存，每次重新分析"
              >
                <input
                  type="number"
                  min={0}
                  max={90}
                  style={inputStyle}
                  value={form?.accountCacheDays ?? 7}
                  onChange={(e) => set("accountCacheDays", e.target.value)}
                />
              </Field>
            </div>
            <div style={{ flex: "1 1 40%", minWidth: 260 }}>
              <Field
                label="yt-dlp 路径"
                hint="应用已内置 yt-dlp，打包版会优先使用内置文件；此处路径仅作为内置文件不可用时的备用路径，可填如 C:/tools/yt-dlp.exe"
              >
                <input
                  type="text"
                  style={inputStyle}
                  value={form?.ytdlpPath ?? "yt-dlp"}
                  onChange={(e) => set("ytdlpPath", e.target.value)}
                  placeholder="yt-dlp"
                />
              </Field>
            </div>
          </div>
          <p className="muted small">
            缓存内容存于 MySQL 的 api_cache
            表：热点按「当天」判断、账号分析按「缓存天数」判断、爆款拆解永久有效；MySQL
            不可达时自动跳过缓存（不影响正常功能）。
          </p>
        </Card>

        <Card
          title="腾讯云 COS 存储桶"
          right={
            <BadgeHint
              ok={
                !!(
                  (form?.cosSecretId ?? "").trim() &&
                  (form?.cosSecretKey ?? "").trim() &&
                  (form?.cosBucket ?? "").trim() &&
                  (form?.cosRegion ?? "").trim()
                )
              }
              label="已配置"
            />
          }
        >
          <Field label="SecretId">
            <input
              type="password"
              style={inputStyle}
              value={form?.cosSecretId ?? ""}
              onChange={(e) => set("cosSecretId", e.target.value)}
              placeholder="COS_SECRET_ID"
            />
          </Field>
          <Field label="SecretKey">
            <input
              type="password"
              style={inputStyle}
              value={form?.cosSecretKey ?? ""}
              onChange={(e) => set("cosSecretKey", e.target.value)}
              placeholder="COS_SECRET_KEY"
            />
          </Field>
          <Field label="存储桶" hint="模板图片固定上传到 bt/tools/ 目录">
            <input
              type="text"
              style={inputStyle}
              value={form?.cosBucket ?? ""}
              onChange={(e) => set("cosBucket", e.target.value)}
              placeholder="prina-1413661498"
            />
          </Field>
          <Field label="地域">
            <input
              type="text"
              style={inputStyle}
              value={form?.cosRegion ?? ""}
              onChange={(e) => set("cosRegion", e.target.value)}
              placeholder="ap-shanghai"
            />
          </Field>
          <Field label="CDN 域名" hint="用于生成模板图片访问地址">
            <input
              type="text"
              style={inputStyle}
              value={form?.cosCdnDomain ?? ""}
              onChange={(e) => set("cosCdnDomain", e.target.value)}
              placeholder="https://bucket.cos.ap-shanghai.myqcloud.com"
            />
          </Field>
        </Card>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={save} disabled={saving || !form}>
          保存配置
        </button>
        <button className="ghost" onClick={reset} disabled={saving || !form}>
          恢复默认(.env)
        </button>
      </div>
      {toast && <div className="ai-image-toast" role="status">{toast}</div>}
    </div>
  );
}

function BadgeHint({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`badge ${ok ? "badge-ok" : "badge-warn"}`}>
      {ok ? label : "未配置"}
    </span>
  );
}
