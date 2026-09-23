// API Key 混淆存储（前端侧，与 Rust 侧 src-tauri/src/keycrypt.rs 对称）
// 算法：XOR(PAD 循环) → hex；带 `enc.` 前缀表示已加密；无前缀视为历史明文。
// 用途：settings 里 ai.api_key 落盘（localStorage / 发送给
// Rust 落 SQLite）前加密，读取后解密为明文供 AI 使用。
//
// 前缀口径：契约《01-M0骨架契约》§四 规定为 `enc.`（点），本文件按契约写出；
// 读取时同时兼容母本沿用下来的 `enc:`（冒号）前缀，避免旧数据解不出来。

const PAD = "chunxiao::study-assistant::2026";

/** 当前写出口径（契约 §四） */
const PREFIX = "enc.";
/** 兼容读取的历史前缀 */
const LEGACY_PREFIX = "enc:";

function xorText(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    out.push(s.charCodeAt(i) ^ PAD.charCodeAt(i % PAD.length));
  }
  return out;
}

function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const v = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(v)) return [];
    out.push(v);
  }
  return out;
}

function decodeHexBytes(bytes: number[]): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i] ^ PAD.charCodeAt(i % PAD.length));
  }
  return s;
}

/** 是否已是密文（含新旧两种前缀） */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX) || value.startsWith(LEGACY_PREFIX);
}

export function encryptSecret(plain: string): string {
  if (!plain) return plain;
  if (isEncrypted(plain)) return plain;
  return PREFIX + toHex(xorText(plain));
}

export function decryptSecret(value: string): string {
  if (!value) return value;
  if (value.startsWith(PREFIX)) {
    return decodeHexBytes(fromHex(value.slice(PREFIX.length)));
  }
  if (value.startsWith(LEGACY_PREFIX)) {
    return decodeHexBytes(fromHex(value.slice(LEGACY_PREFIX.length)));
  }
  return value;
}
