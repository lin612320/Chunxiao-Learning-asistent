// 春晓学习助手 —— 最小 docx 生成器（零第三方依赖，整份移植自母本，仅口径改写）
//
// 目的：让课堂笔记可以导出为「可双击打开」的 .docx，无需联网、无需 Python。
// 实现：手写 WordprocessingML（OOXML）+ STORE（不压缩）方式的 ZIP 打包。
// Word / WPS / LibreOffice 均能打开；本文只支持 Markdown 的一个常用子集：
//   # ~ #### 标题、- / * / 1. 列表、> 引用、``` 代码块、**加粗**、`行内代码`。
// 其余文本按普通段落输出；遇到不认识的 Markdown 结构不会报错（按段落落盘）。

use std::io::Write;
use std::path::Path;

// ---------------------------------------------------------------------------
// OOXML 组装
// ---------------------------------------------------------------------------

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// 行内解析：`code` 与 **bold**（最小子集）
fn inline_runs(text: &str) -> String {
    // 先处理行内代码（`...`），再处理加粗（**...**）
    let code_parts: Vec<&str> = text.split('`').collect();
    let mut xml = String::new();
    for (i, part) in code_parts.iter().enumerate() {
        if i % 2 == 1 {
            // 代码片段
            xml.push_str(&format!(
                "<w:r><w:rPr><w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\"/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>",
                xml_escape(part)
            ));
            continue;
        }
        // 加粗分段
        let bold_parts: Vec<&str> = part.split("**").collect();
        for (j, bp) in bold_parts.iter().enumerate() {
            if bp.is_empty() {
                continue;
            }
            if j % 2 == 1 {
                xml.push_str(&format!(
                    "<w:r><w:rPr><w:b/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>",
                    xml_escape(bp)
                ));
            } else {
                xml.push_str(&format!(
                    "<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>",
                    xml_escape(bp)
                ));
            }
        }
    }
    xml
}

fn para(runs_xml: &str, indent: bool) -> String {
    let ind = if indent { "<w:ind w:left=\"567\"/>" } else { "" };
    format!("<w:p><w:pPr>{ind}</w:pPr>{runs_xml}</w:p>")
}

fn heading(text: &str, level: usize) -> String {
    // 直接用字号加粗模拟标题，避免依赖 styles.xml
    let sz = match level {
        1 => 36,
        2 => 32,
        3 => 28,
        _ => 24,
    };
    format!(
        "<w:p><w:pPr><w:spacing w:before=\"240\" w:after=\"120\"/></w:pPr>\
         <w:r><w:rPr><w:b/><w:sz w:val=\"{sz}\"/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
        xml_escape(text)
    )
}

fn code_block(lines: &[String]) -> String {
    let mut out = String::new();
    for line in lines {
        out.push_str(&format!(
            "<w:p><w:pPr><w:ind w:left=\"283\"/></w:pPr>\
             <w:r><w:rPr><w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\"/></w:rPr>\
             <w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
            xml_escape(line)
        ));
    }
    out
}

fn quote(text: &str) -> String {
    format!(
        "<w:p><w:pPr><w:ind w:left=\"567\"/><w:shd w:fill=\"F2F2F2\"/></w:pPr>{}</w:p>",
        inline_runs(text)
    )
}

/// 单元格段落（表头加粗；正文沿用行内格式）
fn cell_para(text: &str, bold: bool) -> String {
    let runs = if bold {
        format!(
            "<w:r><w:rPr><w:b/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>",
            xml_escape(text)
        )
    } else {
        inline_runs(text)
    };
    format!("<w:p><w:pPr><w:spacing w:after=\"0\"/></w:pPr>{runs}</w:p>")
}

/// 一行 Markdown 表格 → 单元格文本
fn parse_table_row(line: &str) -> Vec<String> {
    line.trim()
        .trim_start_matches('|')
        .trim_end_matches('|')
        .split('|')
        .map(|c| c.trim().to_string())
        .collect()
}

/// 是否为 Markdown 表格分隔行（| --- | :--: |）
fn is_table_sep(line: &str) -> bool {
    let t = line.trim();
    if !t.starts_with('|') {
        return false;
    }
    let cells = parse_table_row(t);
    !cells.is_empty()
        && cells.iter().all(|c| {
            let body = c.trim().trim_matches(':');
            !body.is_empty() && body.chars().all(|ch| ch == '-')
        })
}

/// Markdown 表格 → WordprocessingML 表格（内联边框，不依赖 styles.xml）
fn table(rows: &[Vec<String>]) -> String {
    if rows.is_empty() {
        return String::new();
    }
    const BORDER: &str = "<w:tblBorders>\
        <w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
        <w:left w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
        <w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
        <w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
        <w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
        <w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>\
        </w:tblBorders>";
    let mut xml = format!(
        "<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/>{BORDER}</w:tblPr>"
    );
    for (i, row) in rows.iter().enumerate() {
        let header = i == 0;
        xml.push_str("<w:tr>");
        for cell in row {
            let shd = if header {
                "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F2F2F2\"/>"
            } else {
                ""
            };
            xml.push_str(&format!(
                "<w:tc><w:tcPr><w:tcW w:w=\"0\" w:type=\"auto\"/>{shd}</w:tcPr>{}</w:tc>",
                cell_para(cell, header)
            ));
        }
        xml.push_str("</w:tr>");
    }
    xml.push_str("</w:tbl>");
    // 表格后补一个空段，避免与紧随其后的段落贴合
    xml.push_str("<w:p/>");
    xml
}

/// Markdown（子集）→ WordprocessingML body 内部 XML
pub fn markdown_to_body(markdown: &str) -> String {
    let mut body = String::new();
    let mut code_buf: Vec<String> = Vec::new();
    let mut in_code = false;
    let lines: Vec<&str> = markdown.lines().collect();
    let mut i = 0usize;

    while i < lines.len() {
        let line = lines[i].trim_end();
        let t = line.trim();
        if t.starts_with("```") {
            if in_code {
                body.push_str(&code_block(&code_buf));
                code_buf.clear();
                in_code = false;
            } else {
                in_code = true;
            }
            i += 1;
            continue;
        }
        if in_code {
            code_buf.push(line.to_string());
            i += 1;
            continue;
        }
        if t.is_empty() {
            i += 1;
            continue;
        }
        // 表格：当前行以 | 开头，且下一行是分隔行
        if t.starts_with('|') && i + 1 < lines.len() && is_table_sep(lines[i + 1]) {
            let mut rows: Vec<Vec<String>> = vec![parse_table_row(t)];
            i += 2; // 跳过表头与分隔行
            while i < lines.len() && lines[i].trim().starts_with('|') {
                rows.push(parse_table_row(lines[i].trim()));
                i += 1;
            }
            body.push_str(&table(&rows));
            continue;
        }
        if let Some(rest) = t.strip_prefix("#### ") {
            body.push_str(&heading(rest, 4));
        } else if let Some(rest) = t.strip_prefix("### ") {
            body.push_str(&heading(rest, 3));
        } else if let Some(rest) = t.strip_prefix("## ") {
            body.push_str(&heading(rest, 2));
        } else if let Some(rest) = t.strip_prefix("# ") {
            body.push_str(&heading(rest, 1));
        } else if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
            body.push_str(&para(&inline_runs(rest), true));
        } else if t.starts_with("> ") {
            body.push_str(&quote(&t[2..]));
        } else if t.len() > 2
            && t.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
            && t.contains(". ")
        {
            let dot = t.find(". ").unwrap_or(2);
            body.push_str(&para(&inline_runs(&t[dot + 2..]), true));
        } else {
            body.push_str(&para(&inline_runs(t), false));
        }
        i += 1;
    }
    if in_code && !code_buf.is_empty() {
        body.push_str(&code_block(&code_buf));
    }
    body
}

fn document_xml(title: &str, markdown: &str) -> String {
    let title_para = format!(
        "<w:p><w:pPr><w:jc w:val=\"center\"/><w:spacing w:after=\"240\"/></w:pPr>\
         <w:r><w:rPr><w:b/><w:sz w:val=\"44\"/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
        xml_escape(title)
    );
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
         <w:body>{title_para}{}<w:sectPr>\
         <w:pgSz w:w=\"11906\" w:h=\"16838\"/>\
         <w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\"/>\
         </w:sectPr></w:body></w:document>",
        markdown_to_body(markdown)
    )
}

// ---------------------------------------------------------------------------
// 最小 ZIP（STORE，无压缩）打包
// ---------------------------------------------------------------------------

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

fn dos_datetime() -> (u16, u16) {
    // 不依赖时间 crate：返回固定合法时间（1980-01-01 00:00:00）保证可解压
    (0x0021, 0)
}

struct ZipEntry {
    name: &'static str,
    data: Vec<u8>,
}

fn zip_store(entries: &[ZipEntry]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut offsets: Vec<u32> = Vec::new();
    let (dtime, ddate) = dos_datetime();

    for e in entries {
        offsets.push(out.len() as u32);
        // local file header
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes()); // PK\x03\x04
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&0u16.to_le_bytes()); // method: store
        out.extend_from_slice(&dtime.to_le_bytes());
        out.extend_from_slice(&ddate.to_le_bytes());
        let crc = crc32(&e.data);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(e.name.as_bytes());
        out.extend_from_slice(&e.data);
    }

    let cd_start = out.len() as u32;
    for (i, e) in entries.iter().enumerate() {
        // central directory header
        out.extend_from_slice(&0x0201_4b50u32.to_le_bytes()); // PK\x01\x02
        out.extend_from_slice(&20u16.to_le_bytes()); // version made by
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // method
        out.extend_from_slice(&dtime.to_le_bytes());
        out.extend_from_slice(&ddate.to_le_bytes());
        let crc = crc32(&e.data);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra
        out.extend_from_slice(&0u16.to_le_bytes()); // comment
        out.extend_from_slice(&0u16.to_le_bytes()); // disk start
        out.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        out.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        out.extend_from_slice(&offsets[i].to_le_bytes());
        out.extend_from_slice(e.name.as_bytes());
    }
    let cd_size = out.len() as u32 - cd_start;
    let count = entries.len() as u16;
    // end of central directory
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // disk
    out.extend_from_slice(&0u16.to_le_bytes()); // cd disk
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_start.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment len

    out
}

fn docx_bytes(title: &str, markdown: &str) -> Vec<u8> {
    let content_types = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
        "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
        "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
        "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>",
        "</Types>"
    );
    let root_rels = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>",
        "</Relationships>"
    );
    let doc_rels = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>"
    );
    let entries = vec![
        ZipEntry { name: "[Content_Types].xml", data: content_types.as_bytes().to_vec() },
        ZipEntry { name: "_rels/.rels", data: root_rels.as_bytes().to_vec() },
        ZipEntry { name: "word/document.xml", data: document_xml(title, markdown).into_bytes() },
        ZipEntry {
            name: "word/_rels/document.xml.rels",
            data: doc_rels.as_bytes().to_vec(),
        },
    ];
    zip_store(&entries)
}

/// 文件名净化：去掉 Windows 非法字符
fn sanitize_filename(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0' => ' ',
            _ => c,
        })
        .collect();
    out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.is_empty() {
        out = "文书".to_string();
    }
    if out.chars().count() > 60 {
        out = out.chars().take(60).collect();
    }
    out
}

/// 把 Markdown 导出为 .docx 文件；返回写入的文件路径
pub fn export_docx(dir: &Path, title: &str, markdown: &str) -> Result<std::path::PathBuf, String> {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let file_name = format!("{}_{}.docx", sanitize_filename(title), stamp);
    let path = dir.join(file_name);
    let bytes = docx_bytes(title, markdown);
    let mut f = std::fs::File::create(&path).map_err(|e| format!("创建 docx 失败：{e}"))?;
    f.write_all(&bytes).map_err(|e| format!("写入 docx 失败：{e}"))?;
    f.flush().map_err(|e| format!("写入 docx 失败：{e}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_table_renders_word_table() {
        let md = "## 证据目录\n\n| 序号 | 证据名称 | 证明对象 |\n| --- | --- | --- |\n| 1 | 合同 | 合同成立 |\n| 2 | 提单 | 交付 |\n";
        let body = markdown_to_body(md);
        assert!(body.contains("<w:tbl>"), "应生成表格：{body}");
        assert_eq!(body.matches("<w:tr>").count(), 3, "表头 + 2 数据行");
        assert!(body.contains("证据名称"), "表头文字应在：{body}");
        assert!(body.contains("提单"), "数据应在：{body}");
        // 表头行加粗
        let head_xml = &body[body.find("<w:tr>").unwrap()..body.find("</w:tbl>").unwrap()];
        assert!(head_xml.contains("<w:b/>"), "表头应加粗：{head_xml}");
    }

    #[test]
    fn docx_bytes_is_a_zip_with_document_xml() {
        let bytes = docx_bytes("测试", "# 标题\n\n正文段落\n");
        // 本地文件头签名 PK\x03\x04
        assert_eq!(&bytes[0..4], &[0x50, 0x4B, 0x03, 0x04]);
        let as_text = String::from_utf8_lossy(&bytes);
        assert!(as_text.contains("word/document.xml"), "应包含 document.xml 条目名");
    }
}
