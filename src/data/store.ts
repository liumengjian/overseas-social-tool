// 简单的本地 JSON 持久化（视频库 / CRM 线索 / 配置缓存）
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

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

/**
 * 本地视频落盘目录：
 * - 安装版（打包后）：放在「安装目录/video_files」下，随应用部署，不占用用户目录，
 *   便于随安装包一起分发/备份；安装目录下新建该文件夹即可（用户已确认此方式）。
 * - 开发态：仍用 userData 下的 video_files，避免污染项目目录。
 * 经 localmedia:// 协议供渲染进程播放（localmedia 协议内部按此目录做路径映射与越权防护）。
 */
export function mediaDir(): string {
  const base = app.isPackaged ? dirname(app.getPath('exe')) : app.getPath('userData');
  const dir = join(base, 'video_files');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
