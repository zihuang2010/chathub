// silk(silk_v3)语音解码工具:企微/微信语音原始编码是 silk,WebView 原生 <audio> 解不了。
// 用 silk-wasm 把 silk 解成裸 PCM(s16le, mono),再手写 WAV 头封成 audio/wav Blob 交回 <audio>
// 播放。仅在点击 silk 语音时由 MessageContent 懒加载调用(wasm 进异步 chunk,不拖首屏)。
//
// 注:silk-wasm 是 wasm,正式包需 tauri.conf.json 生产 csp 的 script-src 含 'wasm-unsafe-eval'
// 才能编译(否则 WKWebView 拦 WebAssembly.instantiate);失败由调用方 catch 回退外部打开。

// 微信/企微 silk 语音业界普遍 24000Hz 单声道。silk-wasm 的 decode 需显式给采样率。
const SILK_SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

// 往 DataView 写 ASCII(每字符 1 字节),用于 WAV 头的 "RIFF"/"WAVE"/"fmt "/"data" 标记。
function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

// 裸 pcm_s16le(mono)前拼 44 字节标准 WAV(RIFF/PCM)头,返回 audio/wav Blob。
function pcmS16leToWav(pcm: Uint8Array): Blob {
  const dataLen = pcm.byteLength;
  const byteRate = SILK_SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLen, true); // ChunkSize = 36 + 数据长度
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size = 16(PCM)
  view.setUint16(20, 1, true); // AudioFormat = 1(PCM)
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SILK_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLen, true); // Subchunk2Size = 数据长度
  new Uint8Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

// 解码 silk 字节 → 可播放 WAV Blob + 时长(秒)。任何失败(非 silk / wasm 被 CSP 拦 / 解码错)
// 直接抛出,由调用方 catch 回退 openExternal。silk-wasm 自己消费 #!SILK_V3 头,无需手工剥。
export async function decodeSilkToWav(
  bytes: Uint8Array,
): Promise<{ wav: Blob; durationSec: number }> {
  const { decode } = await import("silk-wasm");
  const { data, duration } = await decode(bytes, SILK_SAMPLE_RATE);
  return {
    wav: pcmS16leToWav(data),
    durationSec: Math.max(0, Math.round(duration / 1000)), // silk-wasm duration 单位为毫秒
  };
}
