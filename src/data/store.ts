// 简单的本地 JSON 持久化（视频库 / CRM 线索 / 配置缓存）
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

function dataDir(): string {
  const dir = join(app.getPath('userData'), 'oss-data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson<T>(name: string, fallback: T): T {
  try {
    const p = join(dataDir(), `${name}.json`);
    if (!existsSync(p)) return fallback;
    return JSON.parse(readFileSync(p, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson<T>(name: string, value: T): void {
  const p = join(dataDir(), `${name}.json`);
  writeFileSync(p, JSON.stringify(value, null, 2), 'utf-8');
}
