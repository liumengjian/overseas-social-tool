// 全局实时工作流状态（模块级单例 + 队列）
// 取代原先「每个页面各自维护一份 usePipeline」的实现：所有页面的工作流动作都汇入同一个全局队列，
// 由固定在右下角的「实时工作流」面板统一展示，不随页面切换而消失。
//
// 队列语义（满足产品需求）：
//   - 同一时刻只执行队首工作流，其余在队列中等待；
//   - 当某个工作流完成后，其展示仍保留在面板中（不清空），直到「下一个工作流开始执行」才被移除；
//   - 在页面 A 的工作流进行中切换到页面 B 又发起工作流时，新工作流进入队列并展示其名称（排队中），
//     等上一个执行完成后再自动开始执行（顺序执行，不并发）。
import { useSyncExternalStore } from "react";
import type {
  AiChunkEvent,
  BatchProgressEvent,
  ProgressEvent,
  TraceStep,
} from "../shared/ipc";
import type { PipelineState } from "./hooks/usePipeline";

export type WorkflowStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export interface WorkflowItem {
  id: string;
  runId: string;
  title?: string;
  /** 当前执行工作流所属模块名（如「热点与Tag追踪」「爆款视频拆解」），用于面板副标题展示 */
  module?: string;
  status: WorkflowStatus;
  steps: TraceStep[];
  aiText: string;
  error: string;
  /** 批量任务总进度（如「全部替换为本地路径」逐条处理时的 current/total），用于弹窗展示 1/10 */
  progress?: { current: number; total: number; label?: string };
  /** 是否已被用户取消（取消后 run 回调内可通过 signal.aborted 提前退出，不再更新页面） */
  cancelled?: boolean;
  /** 取消信号源，cancelWorkflow 触发 abort() */
  abort?: AbortController;
  /** 实际执行函数，由 enqueueWorkflow 传入，pump() 顺序调用；第二个参数 signal 供回调内检查是否被取消 */
  run: (runId: string, signal: AbortSignal) => Promise<void>;
}

export interface WorkflowState extends PipelineState {
  items: WorkflowItem[];
}

const genId = () =>
  "wf-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
const genRunId = () =>
  "run-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);

let items: WorkflowItem[] = [];
let state: WorkflowState = {
  loading: false,
  steps: [],
  aiText: "",
  error: "",
  items,
};
let running = false;
const listeners = new Set<() => void>();
let subscribed = false;

function emit() {
  state = {
    loading: items[0]?.status === "running",
    steps: items[0]?.steps ?? [],
    aiText: items[0]?.aiText ?? "",
    error: items[0]?.error ?? "",
    items,
  };
  listeners.forEach((l) => l());
}

function updateItem(id: string, patch: Partial<WorkflowItem>) {
  items = items.map((it) => (it.id === id ? { ...it, ...patch } : it));
  emit();
}

function onProgress(e: ProgressEvent) {
  const it = items.find((i) => i.runId === e.runId);
  if (!it || it.cancelled) return;
  updateItem(it.id, { steps: [...it.steps, e.step] });
}
function onAiChunk(e: AiChunkEvent) {
  const it = items.find((i) => i.runId === e.runId);
  if (!it || it.cancelled) return;
  updateItem(it.id, { aiText: it.aiText + e.text });
}
function onBatchProgress(e: BatchProgressEvent) {
  const it = items.find((i) => i.runId === e.runId);
  if (!it || it.cancelled) return;
  updateItem(it.id, {
    progress: { current: e.current, total: e.total, label: e.label },
  });
}

function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  window.api.onProgress(onProgress);
  window.api.onAiChunk(onAiChunk);
  window.api.onBatchProgress(onBatchProgress);
}

/**
 * 入队一个工作流：生成 runId，加入队列末尾，并触发顺序执行。
 * @param run 实际执行函数，会收到本次 runId，应使用它发起 IPC 调用（进度/AI 流式事件据此匹配）。
 *            执行中抛出的异常会被捕获并标记为 error，无需在 run 内部自行处理 finish。
 */
export function enqueueWorkflow(opts: {
  title?: string;
  module?: string;
  run: (runId: string, signal: AbortSignal) => Promise<void>;
}): void {
  ensureSubscribed();
  const item: WorkflowItem = {
    id: genId(),
    runId: genRunId(),
    title: opts.title,
    module: opts.module,
    status: "queued",
    steps: [],
    aiText: "",
    error: "",
    progress: undefined,
    cancelled: false,
    abort: new AbortController(),
    run: opts.run,
  };
  items = [...items, item];
  emit();
  pump();
}

/**
 * 取消一个工作流（通过 runId）：
 * - 若目标正在执行：**立即置为「已取消」**（弹窗即时反馈，不必等 IPC 返回），触发 abort 信号，
 *   并通过 cancelRun 通知主进程中断在途网络请求；**其后的排队任务保留**，3s 后自动开始执行；
 * - 若目标仍在排队：直接从队列移除（尚未开始，无需保留展示）。
 */
export function cancelWorkflow(runId: string): void {
  const it = items.find((i) => i.runId === runId);
  if (!it || it.cancelled) return;
  it.cancelled = true;
  if (it.status === "running") {
    // 正在执行：立即置为已取消（UI 即时反馈，不再等 IPC 返回）
    it.status = "cancelled";
    it.abort?.abort();
    // 通知主进程中断在途请求（fetch abort，真正停止执行）
    try {
      window.api.cancelRun(runId);
    } catch {
      /* 忽略 */
    }
    // 注意：不再移除其后的排队项——取消当前任务后，排队任务保留，3s 后自动开始
  } else {
    // 排队中：直接移除
    items = items.filter((x) => x.runId !== runId);
  }
  emit();
  pump();
}

/** 顺序执行队列：一次只跑队首；完成后保留展示，直到下一个开始执行才移除已完成的队首。 */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (true) {
      const head = items[0];
      if (!head) break;
      // 队首是已完成/已取消项：若后面还有排队项，则在「下一个开始执行时」移除它（保持展示直到下一个运行）
      if (
        head.status === "done" ||
        head.status === "error" ||
        head.status === "cancelled"
      ) {
        if (items.length > 1) {
          // 被取消的任务：停留 3s 展示「已取消」，再开始执行排队的任务（给用户看清取消结果的时间）
          if (head.status === "cancelled") await delay(3000);
          items = items.slice(1);
          emit();
          continue;
        }
        break; // 仅剩已完成项，保留展示，等待下一次入队
      }
      // 排队中但已被取消的项（取消发生在 pump 运行间隙）：直接跳过
      if (head.cancelled) {
        items = items.slice(1);
        emit();
        continue;
      }
      if (head.status === "queued") {
        updateItem(head.id, { status: "running" });
      }
      const cur = items.find((i) => i.id === head.id);
      if (!cur) break;
      // 取消看门狗：任务被取消后，若底层请求未感知取消导致 run 迟迟不退出，
      // 5s 后强制跳过，避免队列被卡死（后续任务永远排队中）。
      const watchdog = new Promise<void>((resolve) => {
        const sig = cur.abort?.signal;
        if (cur.cancelled) {
          setTimeout(resolve, 5000);
          return;
        }
        if (!sig) return;
        sig.addEventListener("abort", () => setTimeout(resolve, 5000), {
          once: true,
        });
      });
      try {
        await Promise.race([
          cur.run(cur.runId, cur.abort?.signal ?? new AbortController().signal),
          watchdog,
        ]);
        updateItem(
          cur.id,
          cur.cancelled ? { status: "cancelled" } : { status: "done" },
        );
      } catch (e: any) {
        updateItem(
          cur.id,
          cur.cancelled
            ? { status: "cancelled" }
            : { status: "error", error: e?.message ?? String(e) },
        );
      }
      // 循环继续：若仍有排队项，下一轮会移除已完成的队首并开始下一个
    }
  } finally {
    running = false;
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  ensureSubscribed();
  return () => {
    listeners.delete(cb);
  };
}
function getSnapshot(): WorkflowState {
  return state;
}

/**
 * 全局工作流 Hook：替换原先的 usePipeline / pipe.start/finish。
 * 用法：const pipe = useWorkflow('模块名'); pipe.enqueue('任务名', async (runId, signal) => { ... });
 * 传入的 module 会作为工作流所属模块名（副标题）随每次 enqueue 自动带入。
 * run 的第二个参数 signal：用户在工作流弹窗点「取消」后变为 aborted，回调内应在每个
 * await IPC 之后检查 signal.aborted 并提前 return，避免取消后仍更新页面结果。
 */
export function useWorkflow(module?: string) {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  const enqueue = (
    title: string | undefined,
    run: (runId: string, signal: AbortSignal) => Promise<void>,
  ) => enqueueWorkflow({ title, module, run });
  return { state: s, enqueue, cancel: cancelWorkflow };
}
