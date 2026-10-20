import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card, Spinner, formatDateTime } from "../components/ui";
import type { SopReply } from "../../shared/ipc";
import { useWorkflow } from "../workflowStore";

const DEFAULT_SYSTEM_PROMPT =
  "You are a professional customer service assistant working in Chongqing inbound tourism in China. Follow all rules: 1. Reply in English. 2. Help travelers with attraction tickets and other ticketing services, customized tours, itinerary planning, and related travel consultations. 3. Write a concise, natural, professional, and friendly reply that can be sent directly to the guest. 4. Do not output explanations, reasoning, greetings beyond what the guest needs, quotation marks, or Markdown. Return only the final reply.";
const SOP_SYSTEM_PROMPT_STORAGE_KEY = "customer_sop_system_prompt";

export default function CustomerSop() {
  const [question, setQuestion] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [reply, setReply] = useState("");
  const [items, setItems] = useState<SopReply[]>([]);
  const [editing, setEditing] = useState<SopReply | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [draft, setDraft] = useState("");
  const [filterInput, setFilterInput] = useState("");
  const [selectedFilterLabel, setSelectedFilterLabel] = useState("");
  const [filterPickerOpen, setFilterPickerOpen] = useState(false);
  const [labelPickerOpen, setLabelPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const filterPickerRef = useRef<HTMLDivElement>(null);
  const labelPickerRef = useRef<HTMLDivElement>(null);
  const pipe = useWorkflow("客服SOP语料库");

  async function load() {
    try {
      setError("");
      setItems(await window.api.listSopReplies());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }
  useEffect(() => {
    void load();
    void window.api
      .getJson(SOP_SYSTEM_PROMPT_STORAGE_KEY)
      .then((saved) => {
        if (typeof saved === "string" && saved.trim()) setSystemPrompt(saved);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    function closePickersOnOutsideClick(event: PointerEvent) {
      const target = event.target as Node;
      if (!filterPickerRef.current?.contains(target))
        setFilterPickerOpen(false);
      if (!labelPickerRef.current?.contains(target)) setLabelPickerOpen(false);
    }
    document.addEventListener("pointerdown", closePickersOnOutsideClick);
    return () =>
      document.removeEventListener("pointerdown", closePickersOnOutsideClick);
  }, []);

  const labels = useMemo(
    () =>
      Array.from(
        new Set(items.map((item) => item.label.trim()).filter(Boolean)),
      ),
    [items],
  );
  const filterOptions = useMemo(() => {
    const query = filterInput.trim().toLowerCase();
    return labels.filter(
      (label) => !query || label.toLowerCase().includes(query),
    );
  }, [filterInput, labels]);
  const labelOptions = useMemo(() => {
    const query = labelDraft.trim().toLowerCase();
    return labels.filter(
      (label) => !query || label.toLowerCase().includes(query),
    );
  }, [labelDraft, labels]);
  const filteredItems = useMemo(
    () =>
      selectedFilterLabel
        ? items.filter((item) => item.label === selectedFilterLabel)
        : items,
    [selectedFilterLabel, items],
  );

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(
      () => setToast((current) => (current === message ? "" : current)),
      2200,
    );
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      showToast("已复制");
    } catch {
      showToast("复制失败，请手动复制");
    }
  }
  function generate() {
    if (!question.trim() || busy) return;
    pipe.enqueue("生成客服 SOP 回复", async (runId, signal) => {
      setBusy(true);
      setError("");
      setReply("");
      try {
        const result = await window.api.generateSopReply({
          question,
          systemPrompt,
          runId,
        });
        if (!signal.aborted) setReply(result);
      } catch (e: any) {
        if (!signal.aborted) {
          setError(e?.message ?? String(e));
          throw e;
        }
      } finally {
        setBusy(false);
      }
    });
  }
  function openNew(content = "") {
    setEditing({ id: "", label: "", content, createdAt: "" });
    setLabelDraft("");
    setDraft(content);
    setLabelPickerOpen(false);
  }
  async function saveNew() {
    try {
      setError("");
      await window.api.createSopReply({ label: labelDraft, content: draft });
      setReply("");
      setEditing(null);
      setDraft("");
      setLabelDraft("");
      await load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }
  async function saveEdit() {
    if (!editing) return;
    try {
      setError("");
      await window.api.updateSopReply({
        id: editing.id,
        label: labelDraft,
        content: draft,
      });
      setEditing(null);
      await load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }
  function edit(item: SopReply) {
    setEditing(item);
    setLabelDraft(item.label);
    setDraft(item.content);
    setLabelPickerOpen(false);
  }
  async function remove(item: SopReply) {
    if (!window.confirm("确认删除这条 SOP 回复吗？")) return;
    try {
      await window.api.deleteSopReply({ id: item.id });
      await load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await load();
      showToast("已刷新");
    } finally {
      setRefreshing(false);
    }
  }
  function changeSystemPrompt(value: string) {
    setSystemPrompt(value);
    void window.api
      .setJson(SOP_SYSTEM_PROMPT_STORAGE_KEY, value)
      .catch(() => undefined);
  }

  return (
    <div className="page sop-page">
      <h1>十二、客服SOP语料库</h1>
      <p className="muted">
        输入用户问题，让 AI 生成可直接发送的客服回复，并沉淀为团队可复用的 SOP
        话术。
      </p>
      {error && <p className="err">{error}</p>}
      <Card title="AI 对话生成">
        <label className="sop-system-label">角色设定（System）</label>
        <textarea
          className="sop-system-prompt"
          value={systemPrompt}
          onChange={(e) => changeSystemPrompt(e.target.value)}
          placeholder="请输入系统角色设定"
        />
        <textarea
          className="sop-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="输入客人的咨询，例如：Can you help me book tickets for the Dazu Rock Carvings?"
        />
        <div className="sop-generate-actions">
          <button
            className="primary sop-generate-button"
            onClick={generate}
            disabled={busy || !question.trim() || !systemPrompt.trim()}
          >
            {busy ? <Spinner text="生成中…" /> : "生成回复"}
          </button>
        </div>
        {reply && (
          <div className="sop-generated">
            <div className="sop-generated-head">
              <strong>AI 回复语</strong>
              <div>
                <button onClick={() => copy(reply)}>复制</button>
                <button className="primary" onClick={() => openNew(reply)}>
                  加入 SOP
                </button>
              </div>
            </div>
            <p>{reply}</p>
          </div>
        )}
      </Card>
      <Card
        title={
          <div className="sop-list-head">
            <span>SOP 回复列表</span>
            <div className="sop-list-tools">
              <div className="sop-picker-wrap" ref={filterPickerRef}>
                <input
                  className="sop-filter-picker"
                  value={filterInput}
                  placeholder="按标签筛选"
                  onChange={(e) => {
                    const value = e.target.value;
                    setFilterInput(value);
                    setSelectedFilterLabel("");
                    setFilterPickerOpen(Boolean(value.trim()));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      setSelectedFilterLabel(filterInput.trim());
                      setFilterPickerOpen(false);
                    }
                  }}
                />
                {filterPickerOpen &&
                  filterInput.trim() &&
                  filterOptions.length > 0 && (
                    <div className="sop-picker-menu">
                      {filterOptions.map((label) => (
                        <button
                          type="button"
                          className="sop-picker-option"
                          key={label}
                          onMouseDown={() => {
                            setFilterInput(label);
                            setSelectedFilterLabel(label);
                            setFilterPickerOpen(false);
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
              </div>
              <button className="primary" onClick={() => openNew()}>
                新增
              </button>
              <button onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? "刷新中…" : "刷新"}
              </button>
            </div>
          </div>
        }
      >
        {filteredItems.length === 0 ? (
          <div className="empty">
            {items.length === 0
              ? "暂无 SOP 回复，请生成或手动新增。"
              : "暂无匹配的 SOP 回复。"}
          </div>
        ) : (
          <div className="sop-table-wrap">
            <table className="sop-table">
              <thead>
                <tr>
                  <th>标签</th>
                  <th>文案</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => (
                  <tr key={item.id}>
                    <td className="sop-label">{item.label || "—"}</td>
                    <td className="sop-content">{item.content}</td>
                    <td>{formatDateTime(item.createdAt)}</td>
                    <td>
                      <div className="sop-actions">
                        <button onClick={() => copy(item.content)}>复制</button>
                        <button onClick={() => edit(item)}>编辑</button>
                        <button
                          className="danger"
                          onClick={() => void remove(item)}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && (
        <div className="modal-mask" onClick={() => setEditing(null)}>
          <div
            className="modal sop-edit-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <span>{editing.id ? "编辑 SOP 回复" : "新增 SOP 回复"}</span>
              <button className="link" onClick={() => setEditing(null)}>
                关闭
              </button>
            </div>
            <div className="modal-body">
              <label className="sop-form-label">
                标签<span className="required">*</span>
              </label>
              <div className="sop-label-input-wrap" ref={labelPickerRef}>
                <input
                  autoFocus
                  className="sop-label-input"
                  value={labelDraft}
                  onChange={(e) => {
                    const value = e.target.value;
                    setLabelDraft(value);
                    setLabelPickerOpen(Boolean(value.trim()));
                  }}
                  placeholder="请输入或选择标签"
                />
                {labelPickerOpen &&
                  labelDraft.trim() &&
                  labelOptions.length > 0 && (
                    <div className="sop-picker-menu sop-label-menu">
                      {labelOptions.map((label) => (
                        <button
                          type="button"
                          className="sop-picker-option"
                          key={label}
                          onMouseDown={() => {
                            setLabelDraft(label);
                            setLabelPickerOpen(false);
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
              </div>
              <label className="sop-form-label">
                文案<span className="required">*</span>
              </label>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="请输入可直接发送的客服回复语"
              />
            </div>
            <div className="modal-foot">
              <button className="ghost" onClick={() => setEditing(null)}>
                取消
              </button>
              <button
                className="primary"
                disabled={!labelDraft.trim() || !draft.trim()}
                onClick={() => (editing.id ? void saveEdit() : void saveNew())}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div className="sop-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
