// 主应用密钥混淆存储（XOR + hex，零依赖）
//
// 说明：客户端无法做到真正加密（密钥随程序分发），此实现的目标是让 API Key
// 不以明文 `sk-...` 出现在 SQLite settings 表 / localStorage 中，避免被直接
// 读取 / grep 提取。
//
// 与前端 `src/lib/secret.ts` **逐字对称**：同 PAD、同 XOR、同 hex、同前缀。
// 盐值改动会让两侧互相解不开，改这个常量前必须同时改 secret.ts。
//
// 前缀口径（契约 §四）：写出用 `enc.`（点）；读取 / 迁移判断时额外容忍
// 母本沿用过的 `enc:`（冒号），避免历史值被当成明文再加密一次。
//
// 注：加密职责在 **Rust 侧**：`settings_set("ai.api_key", 明文)` 加密后落盘，
// `settings_get` 解密回明文给前端（前端桌面路径只发明文，不预加密）。
// settings 表其余键（ai.base_url / ai.model / theme …）原样明文存取。
// 用途：BYOK —— 本产品不内置共享 Key，一律由用户自带（见 docs/00 §7.5）。

/// 混淆盐：与 `src/lib/secret.ts` 的 PAD 完全一致
const PAD: &str = "chunxiao::study-assistant::2026";

/// 当前写出口径（契约 §四）
const ENC_PREFIX: &str = "enc.";
/// 兼容读取的历史前缀（母本用的是冒号）
const ENC_PREFIX_LEGACY: &str = "enc:";

/// XOR 混淆（盐循环使用）。API Key 都是 ASCII，与前端按码元逐位处理的结果一致。
fn xor_bytes_with(data: &[u8], pad: &str) -> Vec<u8> {
    let key = pad.as_bytes();
    if key.is_empty() {
        return data.to_vec();
    }
    data.iter()
        .enumerate()
        .map(|(i, b)| b ^ key[i % key.len()])
        .collect()
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn from_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.is_empty() || hex.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    let b = hex.as_bytes();
    for i in (0..hex.len()).step_by(2) {
        let hi = (b[i] as char).to_digit(16)?;
        let lo = (b[i + 1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

/// 明文 → 密文（带 `enc.` 前缀）。已加密的输入原样返回（幂等）。
pub fn encrypt(plain: &str) -> String {
    if plain.is_empty() {
        return plain.to_string();
    }
    if is_encrypted(plain) {
        return plain.to_string();
    }
    format!(
        "{ENC_PREFIX}{}",
        to_hex(&xor_bytes_with(plain.as_bytes(), PAD))
    )
}

/// 密文 / 明文 → 明文；无法识别时原样返回（不破坏既有数据）。
pub fn decrypt(value: &str) -> String {
    let body = if let Some(b) = value.strip_prefix(ENC_PREFIX) {
        b
    } else if let Some(b) = value.strip_prefix(ENC_PREFIX_LEGACY) {
        b
    } else {
        // 无前缀 = 历史明文，原样返回
        return value.to_string();
    };

    match from_hex(body) {
        Some(bytes) => match String::from_utf8(xor_bytes_with(&bytes, PAD)) {
            Ok(s) => s,
            // 非 UTF-8：格式异常，原样返回，绝不把用户数据改坏
            Err(_) => value.to_string(),
        },
        // 非 hex（例如悬浮球侧的 base64 密文）：原样返回
        None => value.to_string(),
    }
}

/// 是否已加密（供启动迁移判断；正式前缀 `enc.`，兼容母本的 `enc:`）
pub fn is_encrypted(value: &str) -> bool {
    value.starts_with(ENC_PREFIX) || value.starts_with(ENC_PREFIX_LEGACY)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前端 `src/lib/secret.ts` 用同一 PAD / 同一算法算出的密文。
    /// 这条断言就是「Rust 侧与前端对称」的证据 —— 任何一边改了盐或算法都会红。
    const TS_CIPHERTEXT: &str = "enc.1003580d101c0f17535b1c5901010a594c43425b40405458430203";
    const SAMPLE_KEY: &str = "sk-chunxiao-test-0123456789";

    #[test]
    fn matches_frontend_secret_ts_byte_for_byte() {
        assert_eq!(encrypt(SAMPLE_KEY), TS_CIPHERTEXT);
        assert_eq!(decrypt(TS_CIPHERTEXT), SAMPLE_KEY);
    }

    #[test]
    fn roundtrip_prefix_and_legacy_prefix() {
        let plain = "sk-chunxiao-test-0123456789";
        let enc = encrypt(plain);
        assert!(enc.starts_with("enc."), "应带 enc. 前缀：{enc}");
        assert!(!enc.contains("sk-chunxiao"), "密文不应包含明文片段");
        assert_eq!(decrypt(&enc), plain);
        // 幂等：重复加密不变
        assert_eq!(encrypt(&enc), enc);
        // 空串与历史明文原样返回
        assert_eq!(encrypt(""), "");
        assert_eq!(decrypt("sk-plain-legacy"), "sk-plain-legacy");

        // 母本的 `enc:` 前缀同样能解，且不会被当成明文重复加密
        let legacy = format!("enc:{}", &enc["enc.".len()..]);
        assert_eq!(decrypt(&legacy), plain);
        assert!(is_encrypted(&legacy));
        assert_eq!(encrypt(&legacy), legacy);

        // 非 hex 内容原样返回，不返回乱码
        assert_eq!(decrypt("enc.zzzz"), "enc.zzzz");
    }
}
