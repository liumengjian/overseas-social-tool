// 全局实时工作流状态（模块级单例）
// 取代原先「每个页面各自维护一份 usePipeline」的实现：所有页面的工作流动作都汇入同一个全局状态，
// 由固定在右下角的「实时工作流」面板统一展示，不随页面切换而消失。
import { useSyncExternalStore } from 'react';
import type { AiChunkEvent, ProgressEvent } from '../shared/ipc';
import type { PipelineState } from './hooks/usePipeline';

export interface WorkflowState extends PipelineState {
  title?: string;
}

let state: WorkflowState = { loading: false, steps: [], aiText: '', error: '' };
let runId = '';
const listeners = new Set<() => void>();
let subscribed = false;

function emit() {
  listeners.forEach((l) => l());
}

function onProgress(e: ProgressEvent) {
  if (!runId || e.runId !== runId) return;
  state = { ...state, steps: [...state.steps, e.step] };
  emit();
}
function onAiChunk(e: AiChunkEvent) {
  if (!runId || e.runId !== runId) return;
  state = { ...state, aiText: state.aiText + e.text };
  emit();
}

function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  window.api.onProgress(onProgress);
  window.api.onAiChunk(onAiChunk);
}

/** 开始一次新的工作流：清空状态并返回本次 runId（应传给所有相关 IPC 调用） */
export function startWorkflow(title?: string): string {
  runId = 'run-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  state = { loading: true, steps: [], aiText: '', error: '', title };
  ensureSubscribed();
  emit();
  return runId;
}
export function finishWorkflow() {
  state = { ...state, loading: false };
  emit();
}
export function failWorkflow(err: string) {
  state = { ...state, loading: false, error: err };
  emit();
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
 * 全局工作流 Hook：替换原先的 usePipeline。
 * 用法与 usePipeline 完全一致：const pipe = useWorkflow(); pipe.start() / .finish() / .fail() / .state。
 */
export function useWorkflow() {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  return { state: s, start: startWorkflow, finish: finishWorkflow, fail: failWorkflow };
}
