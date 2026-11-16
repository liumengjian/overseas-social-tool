// 图片模型网关对 size 有三道硬约束（违反都会 400）：
// 1. 单边不得超过 3840：Invalid value for 'size': width and height must not exceed 3840；
// 2. 宽高必须是 16 的倍数：width and height must be multiples of 16；
// 3. 总像素必须在 655360（640×1024）到 8294400（3840×2160）之间：total pixels must be between 655360 and 8294400。
// 所以 4K 档位不能取 4096，也不能取正方形 3840×3840（总像素 1474 万已超上限），必须按总像素上限收敛。
export const IMAGE_MAX_EDGE = 3840;
// 宽高必须是 16 的倍数。
export const IMAGE_SIZE_STEP = 16;
// 总像素上限 8294400（= 3840×2160）与下限 655360（= 640×1024）。
export const IMAGE_MAX_PIXELS = 8294400;
export const IMAGE_MIN_PIXELS = 655360;

function snapEdge(value: number, mode: "round" | "floor" | "ceil"): number {
  const divide =
    mode === "floor" ? Math.floor : mode === "ceil" ? Math.ceil : Math.round;
  const snapped = divide(value / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
  return Math.min(IMAGE_MAX_EDGE, Math.max(IMAGE_SIZE_STEP, snapped));
}

/**
 * 把「宽x高」收敛到模型可接受的尺寸：单边 ≤3840、宽高为 16 的倍数、总像素落在允许区间，
 * 并尽量保持原宽高比。解析不出合法尺寸时回落到 fallback。
 */
export function clampImageSize(size: string, fallback: string): string {
  const match = /(\d{2,5})\s*[x×]\s*(\d{2,5})/i.exec(size ?? "");
  if (!match) return fallback;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return fallback;

  // 先按单边上限和总像素上限一起缩，再对齐 16 的倍数（对齐时向下取，避免缩完又越界）。
  const scale = Math.min(
    1,
    IMAGE_MAX_EDGE / Math.max(width, height),
    Math.sqrt(IMAGE_MAX_PIXELS / (width * height)),
  );
  let scaledWidth = snapEdge(width * scale, "floor");
  let scaledHeight = snapEdge(height * scale, "floor");

  // 总像素不足下限时等比放大（极端比例可能放大不到下限，此时保持最大可用尺寸）。
  for (let attempt = 0; attempt < 8 && scaledWidth * scaledHeight < IMAGE_MIN_PIXELS; attempt += 1) {
    const up = Math.sqrt(IMAGE_MIN_PIXELS / (scaledWidth * scaledHeight));
    scaledWidth = snapEdge(scaledWidth * up, "ceil");
    scaledHeight = snapEdge(scaledHeight * up, "ceil");
  }

  // 放大后可能越过上限：把较长的一边逐格收回。
  while (scaledWidth * scaledHeight > IMAGE_MAX_PIXELS) {
    if (Math.max(scaledWidth, scaledHeight) <= IMAGE_SIZE_STEP) break;
    if (scaledWidth >= scaledHeight) scaledWidth -= IMAGE_SIZE_STEP;
    else scaledHeight -= IMAGE_SIZE_STEP;
  }

  return `${scaledWidth}x${scaledHeight}`;
}
