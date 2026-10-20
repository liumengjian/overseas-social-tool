import { BrowserWindow } from "electron";

const KEYSTREAM_SIZE = 131072;
const WASM_JS_URL =
  "https://aladin.wxqcloud.qq.com/aladin/ffmepeg/video-decode/1.2.46/wasm_video_decode.js";
const WASM_URL =
  "https://aladin.wxqcloud.qq.com/aladin/ffmepeg/video-decode/1.2.46/wasm_video_decode.wasm";

let decryptWindow: BrowserWindow | null = null;
let ready: Promise<BrowserWindow> | null = null;

async function getDecryptWindow(): Promise<BrowserWindow> {
  if (decryptWindow && !decryptWindow.isDestroyed()) return decryptWindow;
  if (ready) return ready;
  ready = (async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: false, nodeIntegration: false },
    });
    const html = `<!doctype html><script>
      var Module = { locateFile: function(path) { return ${JSON.stringify(WASM_URL)}; } };
      globalThis.wasm_isaac_generate = function(ptr, size) {
        globalThis.__wechatKeyStream = new Uint8Array(size);
        globalThis.__wechatKeyStream.set(Array.from(Module.HEAPU8.subarray(ptr, ptr + size)).reverse());
      };
    </script><script src="${WASM_JS_URL}"></script>`;
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
    await win.webContents.executeJavaScript(
      `new Promise((resolve, reject) => { const started = Date.now(); (function wait() { if (Module && Module.WxIsaac64) return resolve(true); if (Date.now() - started > 60000) return reject(new Error('微信视频解密模块加载超时')); setTimeout(wait, 50); })(); })`,
    );
    decryptWindow = win;
    return win;
  })().catch((error) => {
    ready = null;
    decryptWindow = null;
    throw error;
  });
  return ready;
}

/** 使用微信官方 Isaac64 WASM 生成密钥流并 XOR 解密前 128KB。 */
export async function decryptWechatVideo(
  encrypted: Buffer,
  decodeKey: string,
): Promise<Buffer> {
  if (!decodeKey || encrypted.length < 8)
    throw new Error("微信视频缺少有效 decode_key");
  const win = await getDecryptWindow();
  const base64 = await win.webContents.executeJavaScript(`(async () => {
    globalThis.__wechatKeyStream = null;
    const d = new Module.WxIsaac64(${JSON.stringify(decodeKey)});
    d.generate(${KEYSTREAM_SIZE}); d.delete();
    if (!globalThis.__wechatKeyStream) throw new Error('密钥流生成失败');
    let s = ''; const a = globalThis.__wechatKeyStream;
    for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode(...a.subarray(i, i + 8192));
    return btoa(s);
  })()`);
  const keyStream = Buffer.from(base64, "base64");
  const output = Buffer.from(encrypted);
  const length = Math.min(KEYSTREAM_SIZE, output.length, keyStream.length);
  for (let i = 0; i < length; i++) output[i] = encrypted[i] ^ keyStream[i];
  if (output.toString("ascii", 4, 8) !== "ftyp")
    throw new Error("微信视频解密失败：decode_key 与媒体链接不匹配");
  return output;
}

export function closeWechatDecryptWindow(): void {
  if (decryptWindow && !decryptWindow.isDestroyed()) decryptWindow.destroy();
  decryptWindow = null;
  ready = null;
}
