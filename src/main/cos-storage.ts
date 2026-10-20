import COS = require("cos-nodejs-sdk-v5");
import { randomUUID } from "crypto";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { extname } from "path";
import type { AppConfig } from "../shared/types";

const TEMPLATE_PREFIX = "bt/tools/image_templates";
const VIDEO_PREFIX = "bt/tools/video_temp";

const EXTENSIONS_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

const VIDEO_CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
};

export interface TemplateImageUploadInput {
  dataUrl: string;
  fileName?: string;
  contentType?: string;
}

export interface VideoUploadInput {
  filePath: string;
}

interface CosConfig {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  cdnDomain: string;
}

function requiredConfig(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`未配置 ${label}，无法上传模板图片到 COS。`);
  return normalized;
}

function cosConfig(config: AppConfig): CosConfig {
  const bucket = requiredConfig(config.cosBucket, "COS Bucket");
  const region = requiredConfig(config.cosRegion, "COS 地域");
  const cdnDomain = (
    config.cosCdnDomain.trim() || `https://${bucket}.cos.${region}.myqcloud.com`
  )
    .replace(/^\[|\]$/g, "")
    .replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(cdnDomain)) {
    throw new Error(
      "COS_CDN_DOMAIN 必须是以 http:// 或 https:// 开头的公开访问域名。",
    );
  }
  return {
    secretId: requiredConfig(config.cosSecretId, "COS SecretId"),
    secretKey: requiredConfig(config.cosSecretKey, "COS SecretKey"),
    bucket,
    region,
    cdnDomain,
  };
}

function parseDataUrl(input: TemplateImageUploadInput): {
  body: Buffer;
  contentType: string;
  extension: string;
} {
  const dataUrl = input.dataUrl?.trim();
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl ?? "");
  if (!match) throw new Error("模板图片必须是有效的 Base64 Data URL。");

  const contentType = match[1].toLowerCase();
  const extension = EXTENSIONS_BY_CONTENT_TYPE[contentType];
  if (!extension) {
    throw new Error("模板图片仅支持 JPEG、PNG、WebP、GIF 或 AVIF 格式。");
  }

  const encoded = match[2].replace(/\s/g, "");
  const body = Buffer.from(encoded, "base64");
  if (!body.length) throw new Error("模板图片不能为空。");
  return { body, contentType, extension };
}

/**
 * 图片字节和 COS 密钥只在 Electron 主进程中处理；渲染进程只能得到公开 CDN 地址。
 */
export async function uploadTemplateImage(
  config: AppConfig,
  input: TemplateImageUploadInput,
): Promise<string> {
  return uploadImageDataUrl(config, input, TEMPLATE_PREFIX);
}

export async function uploadImageDataUrl(
  config: AppConfig,
  input: TemplateImageUploadInput,
  prefix: string,
): Promise<string> {
  const cos = cosConfig(config);
  const image = parseDataUrl(input);
  const key = `${prefix}/${randomUUID()}.${image.extension}`;
  const client = new COS({ SecretId: cos.secretId, SecretKey: cos.secretKey });

  try {
    await client.putObject({
      Bucket: cos.bucket,
      Region: cos.region,
      Key: key,
      Body: image.body,
      ContentLength: image.body.length,
      ContentType: image.contentType,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`上传模板图片到 COS 失败：${message}`);
  }

  return `${cos.cdnDomain}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export async function uploadVideoToCos(
  config: AppConfig,
  input: VideoUploadInput,
): Promise<string> {
  const cos = cosConfig(config);
  const filePath = input.filePath?.trim();
  if (!filePath) throw new Error("视频文件路径不能为空。");
  const extension = extname(filePath).toLowerCase();
  const contentType = VIDEO_CONTENT_TYPES[extension];
  if (!contentType) throw new Error(`不支持的视频格式：${extension || "未知"}`);
  const fileStat = await stat(filePath);
  if (!fileStat.size) throw new Error("视频文件不能为空。");
  const key = `${VIDEO_PREFIX}/${randomUUID()}${extension}`;
  const client = new COS({ SecretId: cos.secretId, SecretKey: cos.secretKey });
  try {
    await client.putObject({
      Bucket: cos.bucket,
      Region: cos.region,
      Key: key,
      Body: createReadStream(filePath),
      ContentLength: fileStat.size,
      ContentType: contentType,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`上传视频到 COS 失败：${message}`);
  }
  return `${cos.cdnDomain}/${key.split("/").map(encodeURIComponent).join("/")}`;
}
