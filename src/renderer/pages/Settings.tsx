import React, { useEffect, useState } from 'react';
import { Card, Spinner } from '../components/ui';
import { AppConfig } from '../../shared/types';

// 设置页可编辑的字段（.env 提供默认值，保存后覆盖）
type EditableConfig = Pick<
  AppConfig,
  'tikhubApiToken' | 'tikhubBaseUrl' | 'fetchVideoCount' | 'llmApiKey' | 'llmBaseUrl' | 'llmModel'
>;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>{label}</label>
      {children}
      {hint && <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box' };

export default function Settings() {
  const [form, setForm] = useState<EditableConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    window.api
      .getConfig()
      .then((c) => {
        setForm(pick(c));
        setLoading(false);
      })
      .catch((e) => {
        setMsg({ kind: 'err', text: e?.message ?? String(e) });
        setLoading(false);
      });
  }, []);

  function pick(c: AppConfig): EditableConfig {
    return {
      tikhubApiToken: c.tikhubApiToken ?? '',
      tikhubBaseUrl: c.tikhubBaseUrl ?? '',
      fetchVideoCount: c.fetchVideoCount ?? 30,
      llmApiKey: c.llmApiKey ?? '',
      llmBaseUrl: c.llmBaseUrl ?? '',
      llmModel: c.llmModel ?? '',
    };
  }

  function set<K extends keyof EditableConfig>(k: K, v: string) {
    setForm((f) => (f ? { ...f, [k]: k === 'fetchVideoCount' ? Number(v) || 0 : v } : f));
  }

  function toConfig(f: EditableConfig): AppConfig {
    return {
      ...f,
      tokenConfigured: (f.tikhubApiToken ?? '').trim().length > 0,
      minimaxConfigured: (f.llmApiKey ?? '').trim().length > 0,
    };
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    setMsg(null);
    try {
      const updated = await window.api.saveConfig(toConfig(form));
      setForm(pick(updated));
      setMsg({ kind: 'ok', text: '配置已保存，立即生效。' });
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? String(e) });
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
      setMsg({ kind: 'ok', text: '已恢复为 .env 默认配置。' });
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? String(e) });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner text="加载配置…" />;

  return (
    <div className="page">
      <h1>九、设置</h1>
      <p className="muted">配置数据接入与 LLM 大模型。默认值来自 <code>.env</code>，保存后立即生效、无需重启；「恢复默认」回到 .env 的配置。</p>

      {msg && <p className={msg.kind === 'ok' ? 'ok' : 'err'}>{msg.text}</p>}

      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <Card title="TiKhub 数据接口" right={<BadgeHint ok={!!(form?.tikhubApiToken ?? '').trim()} label="已配置" />}>
          <Field label="API Key" hint="留空则接口不可用（页面呈现空状态）">
            <input type="password" style={inputStyle} value={form?.tikhubApiToken ?? ''} onChange={(e) => set('tikhubApiToken', e.target.value)} placeholder="TIKHUB_API_TOKEN" />
          </Field>
          <Field label="Base URL" hint="大陆网络可改为 https://api.tikhub.dev">
            <input type="text" style={inputStyle} value={form?.tikhubBaseUrl ?? ''} onChange={(e) => set('tikhubBaseUrl', e.target.value)} placeholder="https://api.tikhub.io" />
          </Field>
          <Field label="单页抓取视频数量上限">
            <input type="number" min={1} max={50} style={inputStyle} value={form?.fetchVideoCount ?? 30} onChange={(e) => set('fetchVideoCount', e.target.value)} />
          </Field>
        </Card>

        <Card title="LLM 大模型（OpenAI 兼容）" right={<BadgeHint ok={!!(form?.llmApiKey ?? '').trim()} label="已配置" />}>
          <Field label="API Key" hint="用于爆款拆解 / AI 剪辑等分析能力">
            <input type="password" style={inputStyle} value={form?.llmApiKey ?? ''} onChange={(e) => set('llmApiKey', e.target.value)} placeholder="MINIMAX_API_KEY 或任意 OpenAI 兼容 Key" />
          </Field>
          <Field label="Base URL" hint="OpenAI 兼容端点，默认 MiniMax https://api.minimax.io/v1">
            <input type="text" style={inputStyle} value={form?.llmBaseUrl ?? ''} onChange={(e) => set('llmBaseUrl', e.target.value)} placeholder="https://api.minimax.io/v1" />
          </Field>
          <Field label="模型名称">
            <input type="text" style={inputStyle} value={form?.llmModel ?? ''} onChange={(e) => set('llmModel', e.target.value)} placeholder="MiniMax-M3" />
          </Field>
        </Card>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={save} disabled={saving || !form}>保存配置</button>
        <button className="ghost" onClick={reset} disabled={saving || !form}>恢复默认(.env)</button>
      </div>
    </div>
  );
}

function BadgeHint({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`badge ${ok ? 'badge-ok' : 'badge-warn'}`}>{ok ? label : '未配置'}</span>;
}
