// 处理流程追踪（Pipeline Trace）
// 用途：记录每个模块在「数据抓取（TiKhub）」与「AI 推理（MiniMax-M3）」两个阶段
// 实际调用的接口、请求参数、返回摘要与原始响应，供前端以「处理流程」面板呈现。
//
// 该文件同时被「主进程」（tikhub-client / minimax / main）与「渲染进程」（类型与 UI）使用：
//   - 渲染进程统一用 `import type` 仅引入类型，避免把主进程的单例收集器打进渲染包。
//   - `trace` 单例只在主进程内运行，由 IPC handler 在返回结果上挂 `trace` 字段带回前端。

export type TraceKind = 'tikhub' | 'minimax';

export interface TraceStep {
  kind: TraceKind;
  /** 步骤标题，如 "TiKhub 接口：获取用户资料" / "MiniMax-M3 模型推理" */
  title: string;
  /** 完整请求地址（不含鉴权令牌） */
  endpoint?: string;
  method?: 'GET' | 'POST';
  /** 请求参数（已脱敏：不含令牌，仅 query / body 摘要） */
  params?: Record<string, unknown>;
  /** minimax 步骤：模型名 */
  model?: string;
  /** HTTP 状态码；-1 表示网络/未知错误 */
  status: number;
  ok: boolean;
  durationMs: number;
  /** 返回结果摘要（成功时调用了什么、拿到了什么） */
  summary?: string;
  /** 原始响应体（截断，便于排查） */
  raw?: string;
  error?: string;
}

/** 任意数据附带 trace 字段的辅助类型 */
export type Traced<T> = T & { trace?: TraceStep[] };

/**
 * 主进程内运行的收集器。每次「分析动作」开始前 reset，
 * 期间所有 TikHub / MiniMax 调用会向其中追加步骤，结束（或异常）时由 IPC 带回前端。
 */
export class TraceCollector {
  private steps: TraceStep[] = [];

  reset(): void {
    this.steps = [];
  }

  add(step: TraceStep): void {
    this.steps.push(step);
  }

  snapshot(): TraceStep[] {
    return this.steps.slice();
  }
}

// 主进程单例（仅 main 进程内使用；渲染进程只接收 TraceStep[]）
export const trace = new TraceCollector();

/**
 * 注册一个「实时推送」回调。主进程在每次处理动作期间，把新增的 trace 步骤
 * 通过 IPC 事件实时发给渲染进程（实现「流式工作流」），调用结束后应传 null 清除。
 */
let sink: ((step: TraceStep) => void) | null = null;
export function setTraceSink(fn: ((step: TraceStep) => void) | null): void {
  sink = fn;
}

// 在 add 时同步推送给 sink（保持原快照行为不变）
const _origAdd = TraceCollector.prototype.add;
TraceCollector.prototype.add = function (step: TraceStep) {
  _origAdd.call(this, step);
  sink?.(step);
};
