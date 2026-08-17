// 渲染端流式工作流 Hook
// 订阅主进程经 IPC 推送的实时进度（progress）/ AI 流式输出（aichunk）事件，
// 按 runId 归并到当前一次「分析动作」，暴露实时累积的 trace 步骤与 AI 文本给组件渲染。
//
// 用法：
//   const pipe = usePipeline();
//   async function analyze() {
//     const runId = pipe.start();              // 重置状态、拿到本次 runId
//     const res = await window.api.xxx({ ..., runId });  // 把所有 IPC 调用都带上同一个 runId
//     pipe.finish();                           // 结束（loading=false）
//   }
//   // 渲染：<Pipeline state={pipe.state} />
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiChunkEvent, ProgressEvent } from '../../shared/ipc';
import type { TraceStep } from '../../shared/trace';

export interface PipelineState {
  loading: boolean;
  steps: TraceStep[];
  aiText: string;
  error: string;
}

function genRunId(): string {
  return 'run-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

export function usePipeline() {
  const [state, setState] = useState<PipelineState>({ loading: false, steps: [], aiText: '', error: '' });
  const runIdRef = useRef<string>('');

  // 订阅 IPC 事件（仅挂载一次）；按当前 runId 过滤，避免串台
  useEffect(() => {
    const offP = window.api.onProgress((e: ProgressEvent) => {
      if (!runIdRef.current || e.runId !== runIdRef.current) return;
      setState((s) => ({ ...s, steps: [...s.steps, e.step] }));
    });
    const offA = window.api.onAiChunk((e: AiChunkEvent) => {
      if (!runIdRef.current || e.runId !== runIdRef.current) return;
      setState((s) => ({ ...s, aiText: s.aiText + e.text }));
    });
    return () => {
      offP();
      offA();
    };
  }, []);

  /** 开始一次新的工作流：清空状态并返回本次 runId（应传给所有相关 IPC 调用） */
  const start = useCallback((): string => {
    runIdRef.current = genRunId();
    setState({ loading: true, steps: [], aiText: '', error: '' });
    return runIdRef.current;
  }, []);

  const finish = useCallback(() => setState((s) => ({ ...s, loading: false })), []);
  const fail = useCallback((err: string) => setState((s) => ({ ...s, loading: false, error: err })), []);

  return { state, start, finish, fail, runIdRef };
}
