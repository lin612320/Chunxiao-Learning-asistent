// 学习材料文本提取（docx / pptx / xlsx / txt / md / csv）
//
// 目的：把学生导入的课程材料（课件 / 讲义 / 电子书）离线转成纯文本，落库切块后供检索与问答使用。
// 本文件为纯文档解析，无任何业务耦合：入口 `pub fn extract_office_text(path: &Path) -> Result<Extract, String>`。
// 设计取舍：
//   1) 不引入 zip crate —— 只依赖 flate2，自己解析 ZIP 中央目录（见本文件「最小 ZIP 读取」段）。
//      很多 .docx 的本地头因流式写入（bit 3 置位）大小为 0，因此**一律以中央目录的大小为准**。
//   2) 不实现 PDF 解析、不做 OCR —— pdf 与图片返回带 note 的空结果，由支持文件/视觉输入的模型处理。
//   3) 不支持的扩展名返回 kind = "unknown" 的结果而不是 Err，前端可直接展示 note。
//   4) 单个文档文本上限 MAX_CHARS 字符，超出按字符边界截断（不会切坏 UTF-8）。

use std::io::Read;
use std::path::Path;

use calamine::{Data, Reader, Xlsx};

/// 单个文档提取文本的字符上限（超出截断并置 truncated = true）
const MAX_CHARS: usize = 200_000;

// ---------------------------------------------------------------------------
// 公开数据结构
// ---------------------------------------------------------------------------

/// 提取结果
pub struct Extract {
    /// "docx" | "pptx" | "xlsx" | "txt" | "md" | "csv" | "pdf" | "image" | "unknown"
    pub kind: String,
    /// 提取出的纯文本（已做空白规整）
    pub text: String,
    /// 段落/幻灯片/工作表行 等块数
    pub blocks: usize,
    /// 是否因超长被截断
    pub truncated: bool,
    /// 给用户的提示（如"PDF 需视觉模型解析"）
    pub note: Option<String>,
}

/// 按扩展名分派；不支持/需模型处理的类型返回带 note 的结果而不是 Err
pub fn extract_office_text(path: &Path) -> Result<Extract, String> {
    if !path.exists() {
        return Err("文件不存在".into());
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let (kind, raw, blocks, note): (&str, String, usize, Option<String>) = match ext.as_str() {
        "docx" => {
            let (t, n) = extract_docx(path)?;
            ("docx", t, n, None)
        }
        "pptx" => {
            let (t, n) = extract_pptx(path)?;
            ("pptx", t, n, None)
        }
        "xlsx" | "xlsm" | "xls" => {
            let (t, n) = extract_xlsx(path)?;
            ("xlsx", t, n, None)
        }
        "txt" | "md" | "csv" | "markdown" | "log" => {
            let t = read_text_file(path)?;
            let n = t.lines().filter(|l| !l.trim().is_empty()).count();
            let k = if ext == "md" || ext == "markdown" { "md" } else { ext.as_str() };
            (k, t, n, None)
        }
        "pdf" => (
            "pdf",
            String::new(),
            0,
            Some("PDF 需由支持文件/视觉输入的模型解析（未配置模型时请先转成文本或图片）".to_string()),
        ),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" => (
            "image",
            String::new(),
            0,
            Some("图片需由支持视觉输入的模型解析".to_string()),
        ),
        other => (
            "unknown",
            String::new(),
            0,
            Some(format!(
                "暂不支持 .{other} 格式的文本提取（支持 docx / pptx / xlsx / txt / md / csv；pdf 与图片请用支持视觉输入的模型）"
            )),
        ),
    };

    let text = normalize_ws(&raw);
    let (text, truncated) = truncate_chars(text, MAX_CHARS);
    Ok(Extract {
        kind: kind.to_string(),
        text,
        blocks,
        truncated,
        note,
    })
}

// ---------------------------------------------------------------------------
// 文本规整
// ---------------------------------------------------------------------------

/// 空白规整：行尾空白去掉；连续 3 个以上换行压成 2 个；不动行内空格
fn normalize_ws(s: &str) -> String {
    let unified = s.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(unified.len());
    let mut prev_blank = false;
    for line in unified.split('\n') {
        let line = line.trim_end();
        if line.is_empty() {
            // 只有「上一行非空」时才保留一个空行，因此任意长的连续空行都压成 1 个空行（= 2 个换行）
            if !prev_blank && !out.is_empty() {
                out.push('\n');
            }
            prev_blank = true;
            continue;
        }
        prev_blank = false;
        out.push_str(line);
        out.push('\n');
    }
    out.trim_matches('\n').to_string()
}

/// 按字符（而非字节）截断，保证不会切坏 UTF-8
fn truncate_chars(s: String, max: usize) -> (String, bool) {
    if s.chars().count() <= max {
        return (s, false);
    }
    let end = s
        .char_indices()
        .nth(max)
        .map(|(i, _)| i)
        .unwrap_or(s.len());
    let mut out = s;
    out.truncate(end); // end 落在字符边界上
    (out, true)
}

// ---------------------------------------------------------------------------
// 最小 ZIP 读取（只依赖 flate2）
// ---------------------------------------------------------------------------

/// 中央目录中的一个条目
#[derive(Debug)]
struct ZipEntry {
    name: String,
    method: u16,
    comp_size: u32,
    uncomp_size: u32,
    local_off: u32,
}

fn rd_u16(b: &[u8], p: usize) -> Result<u16, String> {
    if p + 2 > b.len() {
        return Err("ZIP 结构不完整（读取 u16 越界）".into());
    }
    Ok(u16::from_le_bytes([b[p], b[p + 1]]))
}

fn rd_u32(b: &[u8], p: usize) -> Result<u32, String> {
    if p + 4 > b.len() {
        return Err("ZIP 结构不完整（读取 u32 越界）".into());
    }
    Ok(u32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]))
}

/// 解析 ZIP：从 EOCD 反向定位中央目录，逐个读出条目元信息
fn read_zip_entries(buf: &[u8]) -> Result<Vec<ZipEntry>, String> {
    // 1) 从文件尾向前找 EOCD（0x06054b50）。注释最长 65535，扫描范围放宽到 66_000。
    let scan = buf.len().min(66_000);
    let mut eocd: Option<usize> = None;
    let mut i = buf.len().saturating_sub(4);
    let lower = buf.len().saturating_sub(scan);
    loop {
        if rd_u32(buf, i).map(|v| v == 0x0605_4b50).unwrap_or(false) {
            eocd = Some(i);
            break;
        }
        if i <= lower {
            break;
        }
        i -= 1;
    }
    let eocd = eocd.ok_or_else(|| "不是有效的 ZIP/OOXML 文件（未找到 EOCD 结束记录）".to_string())?;

    let total = rd_u16(buf, eocd + 10)? as usize;
    let cd_size = rd_u32(buf, eocd + 12)?;
    let cd_off = rd_u32(buf, eocd + 16)?;

    // 2) ZIP64 明确报错（不静默截断）
    if cd_off == 0xFFFF_FFFF || cd_size == 0xFFFF_FFFF || total == 0xFFFF {
        return Err("暂不支持 ZIP64 格式的文档（请另存为普通 .docx/.pptx/.xlsx）".into());
    }
    let cd_off = cd_off as usize;
    if cd_off >= buf.len() {
        return Err("ZIP 中央目录偏移越界（文件可能已损坏）".into());
    }

    // 3) 遍历中央目录
    let mut out: Vec<ZipEntry> = Vec::with_capacity(total);
    let mut p = cd_off;
    for _ in 0..total {
        if rd_u32(buf, p).ok() != Some(0x0201_4b50) {
            return Err("ZIP 中央目录条目签名异常（文件可能已损坏）".into());
        }
        let method = rd_u16(buf, p + 10)?;
        let comp_size = rd_u32(buf, p + 20)?;
        let uncomp_size = rd_u32(buf, p + 24)?;
        let name_len = rd_u16(buf, p + 28)? as usize;
        let extra_len = rd_u16(buf, p + 30)? as usize;
        let comment_len = rd_u16(buf, p + 32)? as usize;
        let local_off = rd_u32(buf, p + 42)?;
        let name_start = p + 46;
        if name_start + name_len > buf.len() {
            return Err("ZIP 中央目录文件名越界".into());
        }
        let name = String::from_utf8_lossy(&buf[name_start..name_start + name_len]).to_string();
        out.push(ZipEntry {
            name,
            method,
            comp_size,
            uncomp_size,
            local_off,
        });
        p = name_start + name_len + extra_len + comment_len;
    }
    Ok(out)
}

/// 按中央目录记录读出某条目的原始内容
///
/// 注意：**不使用本地头里的大小**。很多 OOXML 的本地头因流式写入（通用标志位 bit 3）
/// 而把压缩/未压缩大小写成 0，只有中央目录的大小是可信的。
fn read_zip_entry(buf: &[u8], e: &ZipEntry) -> Result<Vec<u8>, String> {
    let off = e.local_off as usize;
    if rd_u32(buf, off).ok() != Some(0x0403_4b50) {
        return Err(format!("ZIP 本地头签名异常：{}", e.name));
    }
    let name_len = rd_u16(buf, off + 26)? as usize;
    let extra_len = rd_u16(buf, off + 28)? as usize;
    let data_start = off + 30 + name_len + extra_len;
    let data_end = data_start
        .checked_add(e.comp_size as usize)
        .ok_or_else(|| format!("ZIP 条目长度溢出：{}", e.name))?;
    if data_end > buf.len() {
        return Err(format!("ZIP 条目数据越界（文件可能已损坏）：{}", e.name));
    }
    let raw = &buf[data_start..data_end];
    match e.method {
        0 => Ok(raw.to_vec()), // store：直接切片
        8 => {
            // deflate：用 flate2 解压；按未压缩大小预留容量，避免恶意/损坏文件无限膨胀
            let mut d = flate2::read::DeflateDecoder::new(raw);
            let mut out = Vec::with_capacity(e.uncomp_size as usize);
            d.read_to_end(&mut out)
                .map_err(|err| format!("解压 ZIP 条目失败：{}（{err}）", e.name))?;
            if out.len() != e.uncomp_size as usize {
                return Err(format!(
                    "解压后长度与中央目录不一致：{}（{} != {}）",
                    e.name,
                    out.len(),
                    e.uncomp_size
                ));
            }
            Ok(out)
        }
        m => Err(format!("不支持的 ZIP 压缩方法 {m}：{}", e.name)),
    }
}

/// 读取整个 ZIP 包（返回原始字节，供按需解压）
fn read_zip_file(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("读取文件失败：{e}"))
}

/// 在包内按名字找条目（名字匹配忽略大小写，兼容少数工具的大小写差异）
fn zip_entry<'a>(entries: &'a [ZipEntry], name: &str) -> Option<&'a ZipEntry> {
    entries
        .iter()
        .find(|e| e.name.eq_ignore_ascii_case(name))
}

// ---------------------------------------------------------------------------
// docx
// ---------------------------------------------------------------------------

fn extract_docx(path: &Path) -> Result<(String, usize), String> {
    let buf = read_zip_file(path)?;
    let entries = read_zip_entries(&buf)?;
    let e = zip_entry(&entries, "word/document.xml")
        .ok_or_else(|| "docx 中缺少 word/document.xml（不是有效的 Word 文档？）".to_string())?;
    let xml = String::from_utf8_lossy(&read_zip_entry(&buf, e)?).to_string();
    Ok(extract_docx_xml(&xml))
}

/// 从 WordprocessingML 提取纯文本：
/// `</w:p>` → 换行；`</w:tc>` → 制表符；`<w:tab/>` → 制表符；`<w:br/>` → 换行；
/// 其余标签剥掉；`&amp; &lt; &gt; &quot; &apos;` 反转义。
fn extract_docx_xml(xml: &str) -> (String, usize) {
    let mut out = String::with_capacity(xml.len() / 4);
    let b = xml.as_bytes();
    let mut i = 0usize;
    let mut blocks = 0usize;

    while i < b.len() {
        if b[i] == b'<' {
            let end = match xml[i..].find('>') {
                Some(k) => i + k,
                None => {
                    // 残缺标签：剩余内容按纯文本处理
                    push_text(&mut out, &xml[i..]);
                    break;
                }
            };
            let tag = &xml[i..=end];
            let lower = tag.to_ascii_lowercase();
            if lower.starts_with("</w:p") {
                // 段落结束（</w:p> 或 </w:pPr> 不算，见下）
                if is_para_end(&lower) {
                    out.push('\n');
                    blocks += 1;
                }
            } else if lower.starts_with("</w:tc") {
                // 单元格结束：段落换行是"段尾"而非"另起一段"，先吞掉再补制表符，
                // 否则单元格间会残留换行（"标题A\n\t标题B"），表格可读性差
                if out.ends_with('\n') {
                    out.pop();
                }
                out.push('\t');
            } else if lower.starts_with("</w:tr") {
                // 行结束 → 换行分隔下一行
                out.push('\n');
            } else if lower.starts_with("</w:tbl") {
                // 表格结束 → 换行与后续正文分隔
                if !out.ends_with('\n') {
                    out.push('\n');
                }
            } else if lower.starts_with("<w:tab") || lower.starts_with("<w:ptab") {
                out.push('\t');
            } else if lower.starts_with("<w:br") || lower.starts_with("<w:cr") {
                out.push('\n');
            } else if lower.starts_with("<w:noBreakHyphen") {
                out.push('-');
            } else if lower.starts_with("<w:softHyphen") {
                out.push('\u{00AD}');
            }
            i = end + 1;
            continue;
        }
        let next = xml[i..].find('<').map(|k| i + k).unwrap_or(b.len());
        push_text(&mut out, &xml[i..next]);
        i = next;
    }
    (out, blocks)
}

/// 判断 `</w:p...>` 是不是段落结束标签（排除 `</w:pPr>` / `</w:pStyle>` 等）
fn is_para_end(lower_tag: &str) -> bool {
    let rest = &lower_tag[5..]; // 跳过 "</w:p"
    match rest.chars().next() {
        Some('>') => true,     // </w:p>
        Some(' ') => true,     // </w:p >
        _ => false,            // </w:pPr> 等
    }
}

/// 把一段纯文本追加到输出：解码实体，并把 XML 里的制表/换行字符规整掉
fn push_text(out: &mut String, s: &str) {
    if s.is_empty() {
        return;
    }
    let mut i = 0usize;
    let bytes = s.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'&' {
            if let Some(semi) = s[i..].find(';') {
                if semi <= 10 {
                    let ent = &s[i + 1..i + semi];
                    match ent {
                        "amp" => out.push('&'),
                        "lt" => out.push('<'),
                        "gt" => out.push('>'),
                        "quot" => out.push('"'),
                        "apos" => out.push('\''),
                        "nbsp" => out.push(' '),
                        _ => {
                            if let Some(rest) = ent.strip_prefix('#') {
                                let code = if let Some(hex) = rest.strip_prefix(['x', 'X']) {
                                    u32::from_str_radix(hex, 16).ok()
                                } else {
                                    rest.parse::<u32>().ok()
                                };
                                match code.and_then(char::from_u32) {
                                    Some(c) => out.push(c),
                                    None => out.push_str(&s[i..i + semi + 1]),
                                }
                            } else {
                                // 未知实体：原样保留
                                out.push_str(&s[i..i + semi + 1]);
                            }
                        }
                    }
                    i += semi + 1;
                    continue;
                }
            }
        }
        // 普通字符（含 UTF-8 多字节）
        let ch = s[i..].chars().next().unwrap_or('&');
        out.push(ch);
        i += ch.len_utf8();
    }
}

// ---------------------------------------------------------------------------
// pptx
// ---------------------------------------------------------------------------

fn extract_pptx(path: &Path) -> Result<(String, usize), String> {
    let buf = read_zip_file(path)?;
    let entries = read_zip_entries(&buf)?;

    // 收集 ppt/slides/slideN.xml，并按 N 升序（避免 slide10 排到 slide2 前面）
    let mut slides: Vec<(u32, usize)> = Vec::new();
    for (idx, e) in entries.iter().enumerate() {
        let n = e.name.to_ascii_lowercase();
        if !n.starts_with("ppt/slides/slide") || !n.ends_with(".xml") {
            continue;
        }
        let num: String = n["ppt/slides/slide".len()..n.len() - 4]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if let Ok(k) = num.parse::<u32>() {
            slides.push((k, idx));
        }
    }
    if slides.is_empty() {
        return Err("pptx 中未找到任何幻灯片（ppt/slides/slideN.xml）".into());
    }
    slides.sort_by_key(|(k, _)| *k);

    let mut out = String::new();
    let mut blocks = 0usize;
    for (page, idx) in slides {
        let xml = String::from_utf8_lossy(&read_zip_entry(&buf, &entries[idx])?).to_string();
        let texts = extract_a_text(&xml);
        out.push_str(&format!("【第 {page} 页】\n"));
        for t in &texts {
            out.push_str(t);
            out.push('\n');
        }
        out.push('\n');
        blocks += 1;
    }
    Ok((out, blocks))
}

/// 取 `<a:t>...</a:t>` 的文本内容（顺序即 XML 出现顺序）
fn extract_a_text(xml: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<a:t") {
        let after = &rest[start..];
        let open_end = match after.find('>') {
            Some(k) => k,
            None => break,
        };
        // <a:t/> 自闭合：无文本
        if after[..open_end].ends_with('/') {
            rest = &after[open_end + 1..];
            continue;
        }
        let body = &after[open_end + 1..];
        let close = match body.find("</a:t>") {
            Some(k) => k,
            None => break,
        };
        let mut s = String::new();
        push_text(&mut s, &body[..close]);
        out.push(s);
        rest = &body[close + "</a:t>".len()..];
    }
    out
}

// ---------------------------------------------------------------------------
// xlsx（复用已有依赖 calamine）
// ---------------------------------------------------------------------------

fn extract_xlsx(path: &Path) -> Result<(String, usize), String> {
    let mut workbook: Xlsx<_> =
        calamine::open_workbook(path).map_err(|e| format!("打开 Excel 失败：{e}"))?;
    let names = workbook.sheet_names();
    if names.is_empty() {
        return Err("Excel 中没有工作表".into());
    }

    let cell_str = |d: &Data| -> String {
        match d {
            Data::Empty => String::new(),
            Data::String(s) => s.clone(),
            Data::Float(f) => {
                // 整数显示为整数，避免 1 变成 1.0
                if f.fract() == 0.0 && f.abs() < 1e15 {
                    format!("{}", *f as i64)
                } else {
                    f.to_string()
                }
            }
            Data::Int(i) => i.to_string(),
            Data::Bool(b) => b.to_string(),
            Data::DateTimeIso(s) => s.clone(),
            Data::DurationIso(s) => s.clone(),
            Data::DateTime(d) => d.to_string(),
            Data::Error(e) => format!("#ERR:{e:?}"),
        }
    };

    let mut out = String::new();
    let mut blocks = 0usize;
    for name in names {
        out.push_str(&format!("【工作表：{name}】\n"));
        let range = match workbook.worksheet_range(&name) {
            Ok(r) => r,
            Err(e) => {
                out.push_str(&format!("（读取失败：{e}）\n\n"));
                continue;
            }
        };
        for row in range.rows() {
            let cells: Vec<String> = row.iter().map(&cell_str).collect();
            if cells.iter().all(|c| c.trim().is_empty()) {
                continue; // 跳过全空行
            }
            // 去掉行尾的空单元格，让输出更紧凑
            let last = cells
                .iter()
                .rposition(|c| !c.trim().is_empty())
                .map(|i| i + 1)
                .unwrap_or(0);
            out.push_str(&cells[..last].join(" | "));
            out.push('\n');
            blocks += 1;
        }
        out.push('\n');
    }
    Ok((out, blocks))
}

// ---------------------------------------------------------------------------
// 纯文本文件
// ---------------------------------------------------------------------------

fn read_text_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败：{e}"))?;
    // UTF-8 解码失败时用 lossy（不因个别坏字节整篇失败）
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // ---------------- 测试用最小 ZIP 构造器 ----------------

    fn crc32(data: &[u8]) -> u32 {
        let mut table = [0u32; 256];
        for i in 0..256u32 {
            let mut c = i;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            table[i as usize] = c;
        }
        let mut crc = 0xFFFF_FFFFu32;
        for &b in data {
            crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
        }
        crc ^ 0xFFFF_FFFF
    }

    fn deflate(data: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    /// 构造一个最小合法 ZIP（本地头 + 中央目录 + EOCD）。
    /// `method`: 0 = store，8 = deflate。返回 (zip 字节, 中央目录偏移)。
    fn build_zip(name: &str, raw: &[u8], method: u16) -> Vec<u8> {
        let comp: Vec<u8> = if method == 8 { deflate(raw) } else { raw.to_vec() };
        let crc = crc32(raw);
        let mut out: Vec<u8> = Vec::new();

        // 本地头
        let local_off = 0u32;
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // time
        out.extend_from_slice(&0x0021u16.to_le_bytes()); // date 1980-01-01
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(comp.len() as u32).to_le_bytes());
        out.extend_from_slice(&(raw.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&comp);

        // 中央目录
        let cd_off = out.len() as u32;
        out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version made by
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0x0021u16.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(comp.len() as u32).to_le_bytes());
        out.extend_from_slice(&(raw.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra
        out.extend_from_slice(&0u16.to_le_bytes()); // comment
        out.extend_from_slice(&0u16.to_le_bytes()); // disk
        out.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        out.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        out.extend_from_slice(&local_off.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        let cd_size = out.len() as u32 - cd_off;

        // EOCD
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_off.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    fn tmp_path(tag: &str, ext: &str) -> std::path::PathBuf {
        // 用进程 id + 纳秒时间戳，避免并行测试互相覆盖
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "legal-office-{}-{}-{}.{}",
            std::process::id(),
            tag,
            nanos,
            ext
        ))
    }

    // ---------------- ① ZIP：store 与 deflate ----------------

    #[test]
    fn zip_reads_store_and_deflate_entries() {
        let payload = "<w:p><w:r><w:t>中文 store 测试</w:t></w:r></w:p>";
        let raw = payload.as_bytes();

        for (method, tag) in [(0u16, "store"), (8u16, "deflate")] {
            let zip = build_zip("word/document.xml", raw, method);
            let entries = read_zip_entries(&zip).expect("应能解析中央目录");
            assert_eq!(entries.len(), 1, "{tag}: 条目数");
            let e = &entries[0];
            assert_eq!(e.name, "word/document.xml");
            assert_eq!(e.method, method);
            assert_eq!(e.uncomp_size as usize, raw.len(), "{tag}: 未压缩大小");
            if method == 0 {
                assert_eq!(e.comp_size as usize, raw.len(), "store: 压缩大小应等于原文长度");
            } else {
                assert!(e.comp_size > 0, "deflate: 压缩大小应大于 0");
            }
            let data = read_zip_entry(&zip, e).expect("应能读出条目");
            assert_eq!(data, raw, "{tag}: 内容应与原文一致");
            assert_eq!(String::from_utf8_lossy(&data), payload);
        }
    }

    #[test]
    fn zip_rejects_unknown_method_and_missing_eocd() {
        let zip = build_zip("a.txt", b"hello", 0);
        let mut entries = read_zip_entries(&zip).unwrap();
        entries[0].method = 12; // bzip2：不支持
        let err = read_zip_entry(&zip, &entries[0]).unwrap_err();
        assert!(err.contains("不支持的 ZIP 压缩方法"), "错误信息：{err}");

        let bad = vec![0u8; 64];
        let err = read_zip_entries(&bad).unwrap_err();
        assert!(err.contains("EOCD"), "错误信息：{err}");
    }

    #[test]
    fn zip_uses_central_directory_size_not_local_header() {
        // 模拟流式写入：把本地头的压缩/未压缩大小与 CRC 写成 0（bit 3 置位），
        // 只有中央目录里有真实大小 —— 读取必须以中央目录为准。
        let raw = b"<w:p><w:r><w:t>streaming</w:t></w:r></w:p>";
        let mut zip = build_zip("word/document.xml", raw, 0);
        // 本地头：flags(offset 6) 置 bit3；crc(14)/comp(18)/uncomp(22) 归零
        zip[6] = 0x08;
        zip[7] = 0x00;
        for i in 14..26 {
            zip[i] = 0;
        }
        let entries = read_zip_entries(&zip).unwrap();
        let data = read_zip_entry(&zip, &entries[0]).expect("应以中央目录大小读取");
        assert_eq!(data, raw);
    }

    // ---------------- ② XML 标签剥离与段落切分 ----------------

    #[test]
    fn docx_xml_paragraph_cell_tab_and_entities() {
        let xml = concat!(
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            r#"<w:document xmlns:w="x"><w:body>"#,
            r#"<w:p><w:r><w:t>第一段</w:t></w:r></w:p>"#,
            r#"<w:p><w:r><w:t>甲</w:t></w:r></w:p>"#,
            r#"<w:p><w:r><w:t>乙</w:t></w:r><w:r><w:tab/><w:t>丙</w:t></w:r></w:p>"#,
            r#"<w:tbl><w:tr><w:tc><w:p><w:r><w:t>标题A</w:t></w:r></w:p></w:tc>"#,
            r#"<w:tc><w:p><w:r><w:t>标题B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#,
            r#"<w:p><w:r><w:t>换行前</w:t></w:r><w:br/><w:r><w:t>换行后</w:t></w:r></w:p>"#,
            r#"<w:p><w:r><w:t>实体 &amp; &lt;x&gt; &quot;引号&quot; &apos;单&apos;</w:t></w:r></w:p>"#,
            r#"</w:body></w:document>"#,
        );
        let (text, blocks) = extract_docx_xml(xml);

        // 标签全部剥掉（注意正文里允许出现由 &lt;x&gt; 还原出来的 <x>）
        assert!(!text.contains("<w:"), "仍残留标签：{text}");
        assert!(!text.contains("</"), "仍残留闭合标签：{text}");
        assert!(!text.contains("&amp;"), "实体未反转义：{text}");
        // 段落切分
        assert!(text.starts_with("第一段\n"), "文本：{text:?}");
        // <w:tab/> → 制表符
        assert!(text.contains("乙\t丙"), "文本：{text:?}");
        // </w:tc> → 制表符
        assert!(text.contains("标题A\t标题B"), "文本：{text:?}");
        // <w:br/> → 换行
        assert!(text.contains("换行前\n换行后"), "文本：{text:?}");
        // 实体反转义
        assert!(text.contains("实体 & <x> \"引号\" '单'"), "文本：{text:?}");
        // 块数 = 段落数（含表格单元格内的段落）
        assert_eq!(blocks, 7, "段落数：{blocks}\n{text}");

        // 规整后：连续空行压成最多 2 个换行，行尾无空白
        let norm = normalize_ws(&text);
        assert!(!norm.contains("\n\n\n"), "空行未压缩：{norm:?}");
        for line in norm.split('\n') {
            assert_eq!(line, line.trim_end(), "行尾空白未去掉：{line:?}");
        }
    }

    #[test]
    fn pptx_slide_order_and_text() {
        // 构造一个含 slide2 / slide10 的最小 pptx（页码须按数字升序）
        let slide = |s: &str| format!(r#"<p:sld><p:cSld><p:spTree><a:t>{s}</a:t></p:spTree></p:cSld></p:sld>"#);
        let s2 = slide("第二页内容");
        let s10 = slide("第十页内容");
        // 手工拼一个多条目 ZIP
        let mut body: Vec<u8> = Vec::new();
        let mut cd: Vec<u8> = Vec::new();
        let mut offsets: Vec<u32> = Vec::new();
        let names = ["ppt/slides/slide10.xml", "ppt/slides/slide2.xml"];
        let datas = [s10.as_bytes(), s2.as_bytes()];
        for i in 0..2 {
            offsets.push(body.len() as u32);
            let crc = crc32(datas[i]);
            body.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            body.extend_from_slice(&20u16.to_le_bytes());
            body.extend_from_slice(&0u16.to_le_bytes());
            body.extend_from_slice(&0u16.to_le_bytes());
            body.extend_from_slice(&0u16.to_le_bytes());
            body.extend_from_slice(&0x0021u16.to_le_bytes());
            body.extend_from_slice(&crc.to_le_bytes());
            body.extend_from_slice(&(datas[i].len() as u32).to_le_bytes());
            body.extend_from_slice(&(datas[i].len() as u32).to_le_bytes());
            body.extend_from_slice(&(names[i].len() as u16).to_le_bytes());
            body.extend_from_slice(&0u16.to_le_bytes());
            body.extend_from_slice(names[i].as_bytes());
            body.extend_from_slice(datas[i]);
        }
        let cd_off = body.len() as u32;
        for i in 0..2 {
            let crc = crc32(datas[i]);
            cd.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            cd.extend_from_slice(&20u16.to_le_bytes());
            cd.extend_from_slice(&20u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0x0021u16.to_le_bytes());
            cd.extend_from_slice(&crc.to_le_bytes());
            cd.extend_from_slice(&(datas[i].len() as u32).to_le_bytes());
            cd.extend_from_slice(&(datas[i].len() as u32).to_le_bytes());
            cd.extend_from_slice(&(names[i].len() as u16).to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u32.to_le_bytes());
            cd.extend_from_slice(&offsets[i].to_le_bytes());
            cd.extend_from_slice(names[i].as_bytes());
        }
        let cd_size = cd.len() as u32;
        body.extend_from_slice(&cd);
        body.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        body.extend_from_slice(&0u16.to_le_bytes());
        body.extend_from_slice(&0u16.to_le_bytes());
        body.extend_from_slice(&2u16.to_le_bytes());
        body.extend_from_slice(&2u16.to_le_bytes());
        body.extend_from_slice(&cd_size.to_le_bytes());
        body.extend_from_slice(&cd_off.to_le_bytes());
        body.extend_from_slice(&0u16.to_le_bytes());

        let p = tmp_path("slides", "pptx");
        std::fs::write(&p, &body).unwrap();
        let r = extract_office_text(&p).unwrap();
        let _ = std::fs::remove_file(&p);

        assert_eq!(r.kind, "pptx");
        assert_eq!(r.blocks, 2, "幻灯片数：{}", r.blocks);
        let i2 = r.text.find("【第 2 页】").expect("缺少第 2 页标记");
        let i10 = r.text.find("【第 10 页】").expect("缺少第 10 页标记");
        assert!(i2 < i10, "页码未按数字升序：\n{}", r.text);
        assert!(r.text.contains("第二页内容") && r.text.contains("第十页内容"));
    }

    // ---------------- ③ 截断落在 UTF-8 边界上 ----------------

    #[test]
    fn truncate_keeps_utf8_boundary() {
        // 构造远超上限的中文文本（每字符 3 字节）
        let big = "中".repeat(MAX_CHARS + 500);
        let (t, cut) = truncate_chars(big, MAX_CHARS);
        assert!(cut, "应被截断");
        assert_eq!(t.chars().count(), MAX_CHARS);
        assert_eq!(t.len(), MAX_CHARS * 3);
        // 关键：截断结果仍是合法 UTF-8，且能正常再拼接
        let rebuilt = format!("{t}尾巴");
        assert!(rebuilt.ends_with("中尾巴"));

        // 混合多字节 + ASCII，同样不能切坏
        let mixed = "a中🎉".repeat(MAX_CHARS);
        let (t2, cut2) = truncate_chars(mixed, 1000);
        assert!(cut2);
        assert_eq!(t2.chars().count(), 1000);
        assert!(std::str::from_utf8(t2.as_bytes()).is_ok());

        // 未超限时不动
        let (t3, cut3) = truncate_chars("短文本".to_string(), MAX_CHARS);
        assert_eq!(t3, "短文本");
        assert!(!cut3);
    }

    #[test]
    fn dispatch_pdf_image_and_unknown() {
        let pdf = tmp_path("a", "pdf");
        std::fs::write(&pdf, b"%PDF-1.7 fake").unwrap();
        let r = extract_office_text(&pdf).unwrap();
        let _ = std::fs::remove_file(&pdf);
        assert_eq!(r.kind, "pdf");
        assert!(r.text.is_empty());
        assert!(r.note.unwrap().contains("PDF"));

        let png = tmp_path("b", "png");
        std::fs::write(&png, b"\x89PNG").unwrap();
        let r = extract_office_text(&png).unwrap();
        let _ = std::fs::remove_file(&png);
        assert_eq!(r.kind, "image");
        assert!(r.note.unwrap().contains("视觉"));

        let zipx = tmp_path("c", "7z");
        std::fs::write(&zipx, b"x").unwrap();
        let r = extract_office_text(&zipx).unwrap();
        let _ = std::fs::remove_file(&zipx);
        assert_eq!(r.kind, "unknown");
        assert!(r.note.unwrap().contains("不支持"));

        assert!(extract_office_text(std::path::Path::new("no-such-file.docx")).is_err());
    }

    #[test]
    fn txt_reads_with_lossy_utf8() {
        let p = tmp_path("t", "txt");
        let mut bytes = "中文正常".as_bytes().to_vec();
        bytes.push(0xFF); // 非法字节
        bytes.extend_from_slice("\n第二行   \n\n\n\n第三行".as_bytes());
        std::fs::write(&p, &bytes).unwrap();
        let r = extract_office_text(&p).unwrap();
        let _ = std::fs::remove_file(&p);
        assert_eq!(r.kind, "txt");
        assert!(r.text.contains("中文正常"), "文本：{:?}", r.text);
        assert!(r.text.contains("第三行"));
        assert!(!r.text.contains("\n\n\n"), "空行未压缩：{:?}", r.text);
    }

    // ---------------- ④ 真实文档冒烟（docs/ 下若有样例则跑） ----------------

    fn docs_dir() -> std::path::PathBuf {
        // CARGO_MANIFEST_DIR = .../feature-悬浮球外观/src-tauri → 上一级是仓库根
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("docs"))
            .unwrap_or_else(|| std::path::PathBuf::from("docs"))
    }

    #[test]
    fn smoke_real_docx_and_md() {
        let dir = docs_dir();
        let docx = dir.join("项目计划书.docx");
        if !docx.exists() {
            eprintln!("[smoke] 跳过：未找到 {}", docx.display());
            return;
        }
        let r = extract_office_text(&docx).unwrap();
        assert_eq!(r.kind, "docx");
        assert!(r.blocks > 0, "段落数为 0");
        assert!(!r.text.is_empty(), "提取为空");
        // 中文正常（含 CJK 字符），且没有乱码替换字符
        assert!(
            r.text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
            "未提取到中文：{:?}",
            &r.text.chars().take(200).collect::<String>()
        );
        assert!(!r.text.contains('\u{FFFD}'), "出现乱码替换字符");
        println!(
            "[smoke] 项目计划书.docx kind={} blocks={} chars={} truncated={}\n前 200 字符：\n{}",
            r.kind,
            r.blocks,
            r.text.chars().count(),
            r.truncated,
            r.text.chars().take(200).collect::<String>()
        );

        let md = dir.join("功能演示报告.md");
        if md.exists() {
            let r2 = extract_office_text(&md).unwrap();
            assert_eq!(r2.kind, "md");
            assert!(r2.text.contains("功能") || r2.text.chars().count() > 100);
            println!(
                "[smoke] 功能演示报告.md chars={}\n前 200 字符：\n{}",
                r2.text.chars().count(),
                r2.text.chars().take(200).collect::<String>()
            );
        }
    }
}
