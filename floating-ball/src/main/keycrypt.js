// 默认 API Key 混淆存储：XOR + base64
// 说明：客户端分发无法做到真正加密（密钥必须随程序分发），
// 这里的目的是让 Key 不以明文 sk-... 出现在 exe/asar 中，避免被直接 grep/字符串提取。
// 用户在设置中填写自己的 Key 后，以明文存在各自机器的配置文件中（不影响）。

const PAD = 'chunxiao-ball::chunxiao-study::2026';

function xor(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    out.push(str.charCodeAt(i) ^ PAD.charCodeAt(i % PAD.length));
  }
  return out;
}

// 编码：明文 → 密文（base64）
function encode(plain) {
  const bytes = xor(plain);
  return Buffer.from(bytes).toString('base64');
}

// 解码：密文（base64）→ 明文
function decode(obf) {
  try {
    const bytes = Array.from(Buffer.from(obf, 'base64'));
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      out += String.fromCharCode(bytes[i] ^ PAD.charCodeAt(i % PAD.length));
    }
    return out;
  } catch {
    return '';
  }
}

// 【BYOK 决策】本产品不内置共享 API Key。
// 与参考母本不同：母本内置了共享 Key 让分发版开箱即用，
// 但学生产品这样做会带来不可控的账单与滥用风险，故一律由用户自带。
// 保留本函数是为了配置结构兼容（返回空串 → 未配置状态 → 走演示模式提示）。
function getDefaultApiKey() {
  return '';
}

// 配置文件落盘加密：明文 → 'enc.'+密文；已加密则原样返回
const ENC_PREFIX = 'enc.';
function encrypt(plain) {
  if (!plain || typeof plain !== 'string') return plain;
  if (plain.startsWith(ENC_PREFIX)) return plain;
  return ENC_PREFIX + encode(plain);
}

// 读取时解密：'enc.' 密文 → 明文；历史明文原样返回（兼容）
function decrypt(val) {
  if (!val || typeof val !== 'string') return val;
  if (val.startsWith(ENC_PREFIX)) return decode(val.slice(ENC_PREFIX.length));
  return val;
}

module.exports = { encode, decode, getDefaultApiKey, encrypt, decrypt };
