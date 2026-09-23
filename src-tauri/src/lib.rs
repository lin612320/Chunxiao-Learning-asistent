// 春晓学习助手 —— Rust 后端入口 + Tauri 命令桥接
//
// 本文件只做「命令层」：参数校验、错误中文化、调用 db / ball / office / keycrypt。
// 命令清单以 `docs/01-M0骨架契约.md` §三 为准。
//
// 命名口径（与前端钉死）：
//   · 命令**参数**：Rust 侧 snake_case 形参，Tauri v2 自动映射前端 camelCase
//     （前端传 `courseId` / `sessionId` / `file` / `dir`）。
//   · 命令**返回的行字段**：一律 snake_case，与表列名逐字一致（created_at / file_name …），
//     不做任何 serde 重命名。
// 注意：**必填参数不要写成 Option** —— 名字写错时会静默变成 None，导致写入的数据悄悄丢字段。

mod ball;
mod db;
mod docx;
mod keycrypt;
mod office;

use std::fs;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use db::DbState;

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

#[tauri::command]
fn ping() -> String {
    "pong".into()
}

/// 取数据库连接；锁被毒化时给用户可读的提示（而不是 panic）。
/// 命令里必须先把 guard 绑到局部变量，再 `&c` 传下去：
/// 直接写 `db::xxx(&conn_of(&conn)?)` 时 `?` 与解引用强转配合不上（E0308）。
fn conn_of<'a>(state: &'a State<'_, DbState>) -> Result<MutexGuard<'a, Connection>, String> {
    state
        .0
        .lock()
        .map_err(|_| "数据库状态异常（上一次写入可能中断），请重启春晓后重试。".to_string())
}

// ---------------------------------------------------------------------------
// 设置（BYOK：base_url / api_key / model、主题、桌宠偏好）
// ---------------------------------------------------------------------------

/// 需要加密落盘的设置键（API Key 类）。BYOK 下用户的 Key 只存本机。
const SECRET_KEYS: [&str; 1] = ["ai.api_key"];

fn is_secret_key(key: &str) -> bool {
    SECRET_KEYS.contains(&key) || key.ends_with(".api_key")
}

/// 读取设置：密钥类**解密后返回明文**（前端桌面路径不预加密、不自行解密）
#[tauri::command]
fn settings_get(conn: State<'_, DbState>, key: String) -> Result<Option<String>, String> {
    let c = conn_of(&conn)?;
    let raw = db::get_setting(&c, &key)?;
    Ok(raw.map(|v| {
        if is_secret_key(&key) {
            keycrypt::decrypt(&v)
        } else {
            v
        }
    }))
}

/// 写入设置：密钥类由 **Rust 侧加密**后落盘；其余键原样明文存取
#[tauri::command]
fn settings_set(conn: State<'_, DbState>, key: String, value: String) -> Result<(), String> {
    let c = conn_of(&conn)?;
    let stored = if is_secret_key(&key) {
        keycrypt::encrypt(&value)
    } else {
        value
    };
    db::set_setting(&c, &key, &stored)
}

/// 启动迁移：把历史明文 API Key 加密落盘（幂等）
fn migrate_secret_keys(conn: &Connection) {
    let Ok(rows) = db::settings_all(conn) else {
        return;
    };
    let mut changed = 0usize;
    for (key, value) in rows {
        if is_secret_key(&key) && !keycrypt::is_encrypted(&value) && !value.is_empty() {
            if db::set_setting(conn, &key, &keycrypt::encrypt(&value)).is_ok() {
                changed += 1;
            }
        }
    }
    if changed > 0 {
        println!("[keycrypt] 已将 {changed} 个明文 API Key 迁移为混淆存储");
    }
}

// ---------------------------------------------------------------------------
// 课程
// ---------------------------------------------------------------------------

#[tauri::command]
fn courses_list(conn: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let c = conn_of(&conn)?;
    db::courses_list(&c)
}

#[tauri::command]
fn course_create(
    conn: State<'_, DbState>,
    name: String,
    term: Option<String>,
    teacher: Option<String>,
    intro: Option<String>,
) -> Result<i64, String> {
    let c = conn_of(&conn)?;
    db::course_create(&c, &name, term.as_deref(), teacher.as_deref(), intro.as_deref())
}

#[tauri::command]
fn course_update(
    conn: State<'_, DbState>,
    id: i64,
    name: Option<String>,
    term: Option<String>,
    teacher: Option<String>,
    intro: Option<String>,
) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::course_update(
        &c,
        id,
        name.as_deref(),
        term.as_deref(),
        teacher.as_deref(),
        intro.as_deref(),
    )
}

#[tauri::command]
fn course_archive(conn: State<'_, DbState>, id: i64, archived: bool) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::course_archive(&c, id, archived)
}

#[tauri::command]
fn course_delete(conn: State<'_, DbState>, id: i64) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::course_delete(&c, id)
}

// ---------------------------------------------------------------------------
// 先验知识（每条必须带来源：ai | textbook | web | user | <材料名>）
// ---------------------------------------------------------------------------

#[tauri::command]
fn prior_list(conn: State<'_, DbState>, course_id: i64) -> Result<Vec<Value>, String> {
    let c = conn_of(&conn)?;
    db::prior_list(&c, course_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn prior_add(
    conn: State<'_, DbState>,
    course_id: i64,
    parent_id: Option<i64>,
    topic: String,
    summary: Option<String>,
    detail: Option<String>,
    source: String,
    source_ref: Option<String>,
    confidence: Option<f64>,
) -> Result<i64, String> {
    let c = conn_of(&conn)?;
    db::prior_add(
        &c,
        course_id,
        parent_id,
        &topic,
        summary.as_deref(),
        detail.as_deref(),
        &source,
        source_ref.as_deref(),
        confidence,
    )
}

/// **批量写入先验知识树**（顶层项 + 子项，1 次 IPC；父子解析在 Rust 侧完成）。
/// `items` 元素沿用前端 `PriorDraft` 的 **snake_case** 字段
/// （`{topic, summary?, detail?, parent_topic?}`，契约 §2.3 显式登记的口径例外）。
/// 整批一个事务：任一项非法 → 全部回滚，不留半截知识树。
#[tauri::command]
fn prior_add_tree(
    conn: State<'_, DbState>,
    course_id: i64,
    items: Vec<Value>,
    source: String,
    source_ref: Option<String>,
    confidence: Option<f64>,
) -> Result<Vec<i64>, String> {
    let c = conn_of(&conn)?;
    db::prior_add_tree(
        &c,
        course_id,
        &items,
        &source,
        source_ref.as_deref(),
        confidence,
    )
}

#[tauri::command]
fn prior_update(
    conn: State<'_, DbState>,
    id: i64,
    topic: Option<String>,
    summary: Option<String>,
    detail: Option<String>,
) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::prior_update(
        &c,
        id,
        topic.as_deref(),
        summary.as_deref(),
        detail.as_deref(),
    )
}

#[tauri::command]
fn prior_verify(conn: State<'_, DbState>, id: i64, verified: bool) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::prior_verify(&c, id, verified)
}

#[tauri::command]
fn prior_delete(conn: State<'_, DbState>, id: i64) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::prior_delete(&c, id)
}

// ---------------------------------------------------------------------------
// 材料（课件 / 讲义 / 电子书）
// ---------------------------------------------------------------------------

#[tauri::command]
fn materials_list(conn: State<'_, DbState>, course_id: i64) -> Result<Vec<Value>, String> {
    let c = conn_of(&conn)?;
    db::materials_list(&c, course_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn material_add(
    conn: State<'_, DbState>,
    course_id: i64,
    file_name: String,
    file_path: String,
    kind: String,
    size_bytes: Option<i64>,
    extracted_by: String,
    text: String,
    blocks: Option<i64>,
    truncated: Option<bool>,
    note: Option<String>,
) -> Result<i64, String> {
    let c = conn_of(&conn)?;
    db::material_add(
        &c,
        course_id,
        &file_name,
        &file_path,
        &kind,
        size_bytes,
        &extracted_by,
        &text,
        blocks,
        truncated,
        note.as_deref(),
    )
}

#[tauri::command]
fn material_delete(conn: State<'_, DbState>, id: i64) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::material_delete(&c, id)
}

/// 某课程全部材料正文（按材料 + 块序拼接），供前端喂给模型。
/// 没有材料时返回**空字符串**（不是 null）。
#[tauri::command]
fn material_text_all(conn: State<'_, DbState>, course_id: i64) -> Result<String, String> {
    let c = conn_of(&conn)?;
    db::material_text_all(&c, course_id)
}

/// 提取材料的文本（离线、本机完成）。
/// 分派规则：
///   · txt / md / csv / docx / pptx / xlsx 等 → `office::extract_office_text`
///   · pdf 与图片 → **返回 Ok 且带 note**（不是 Err）：
///     `{kind:"pdf"|"image", text:"", blocks:0, truncated:false,
///       note:"需配置支持视觉/文件输入的模型，将在 M2 支持"}`
///     本机解析不了就如实说，不假装支持、不返回编造的文本。
#[tauri::command]
fn extract_material(path: String) -> Result<Value, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("文件不存在，请重新选择。".into());
    }
    if !p.is_file() {
        return Err("这不是一个文件。".into());
    }
    Ok(extract_to_value(office::extract_office_text(p)?))
}

/// `extract_material` 与 `extract_material_b64` **共用**的返回形状，
/// 保证「有真实路径」与「只有字节」两条入口逐字段一致（契约 §2.2）。
fn extract_to_value(e: office::Extract) -> Value {
    // pdf / 图片：本机没有解析能力，统一换成诚实口径的提示（office.rs 的原始 note 更技术化）
    let note = match e.kind.as_str() {
        "pdf" | "image" => Some("需配置支持视觉/文件输入的模型，将在 M2 支持".to_string()),
        _ => e.note,
    };
    json!({
        "kind": e.kind,
        "text": e.text,
        "blocks": e.blocks,
        "truncated": e.truncated,
        "note": note,
    })
}

/// 单个材料导入的字节上限（契约 §2.2：20 MB）
const MAX_IMPORT_BYTES: usize = 20 * 1024 * 1024;

/// base64 文本长度上限：4/3 膨胀 + 末尾填充。
/// 先按文本长度挡一刀，避免为一个超大输入先分配解码缓冲。
const MAX_B64_CHARS: usize = MAX_IMPORT_BYTES / 3 * 4 + 8;

fn too_big_msg(bytes: usize) -> String {
    format!(
        "文件过大（约 {:.1} MB），单个材料上限 20 MB，请拆分或压缩后再导入。",
        bytes as f64 / (1024.0 * 1024.0)
    )
}

/// 去掉前端 `FileReader.readAsDataURL()` 带上的 `data:...;base64,` 前缀（容忍即可，不强制）
fn strip_data_url(s: &str) -> &str {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("data:") {
        if let Some(i) = rest.find("base64,") {
            return &rest[i + "base64,".len()..];
        }
    }
    t
}

/// 从**字节**导入材料：前端 `<input type="file">` 只拿得到字节、拿不到绝对路径。
/// 流程：base64 解码（容忍 data: 前缀）→ 大小上限 20 MB → 写临时文件（**保留原扩展名**，
/// 因为 `office::extract_office_text` 按扩展名分派）→ 提取 → **无论成功失败都删除临时文件**。
/// 返回形状与 `extract_material` 完全一致。
#[tauri::command]
fn extract_material_b64(file_name: String, data_b64: String) -> Result<Value, String> {
    use base64::Engine as _;

    let payload = strip_data_url(&data_b64);
    // 去掉换行等空白：base64 引擎只认字母表，带换行的输入不该被拒
    let cleaned: String = payload
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    if cleaned.is_empty() {
        return Err("文件内容为空，请重新选择。".into());
    }
    if cleaned.len() > MAX_B64_CHARS {
        return Err(too_big_msg(cleaned.len() / 4 * 3));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(cleaned.as_bytes())
        .map_err(|e| format!("文件内容不是有效的 base64 编码：{e}"))?;
    if bytes.is_empty() {
        return Err("文件内容为空，请重新选择。".into());
    }
    if bytes.len() > MAX_IMPORT_BYTES {
        return Err(too_big_msg(bytes.len()));
    }

    // 只取文件名部分并清掉 Windows 非法字符：**不让前端传来的名字变成路径**
    let raw_name = file_name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let safe: String = raw_name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let safe = safe.trim_matches(['.', ' ']).to_string();
    if safe.is_empty() {
        return Err("文件名不能为空。".into());
    }

    // 临时文件放在系统临时目录，名字带进程号 + 纳秒时间戳避免并发互撞，**保留原扩展名**
    let ext = std::path::Path::new(&safe)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut tmp_name = format!("chunxiao-import-{}-{nanos}", std::process::id());
    if let Some(e) = ext.as_deref() {
        tmp_name.push('.');
        tmp_name.push_str(e);
    }
    let tmp = std::env::temp_dir().join(tmp_name);

    fs::write(&tmp, &bytes).map_err(|e| format!("写入临时文件失败：{e}"))?;
    let extracted = office::extract_office_text(&tmp);
    let _ = fs::remove_file(&tmp); // 成功失败都清理，不留垃圾
    Ok(extract_to_value(extracted?))
}

/// 在已导入材料的切块里按关键词召回，**按相关度降序**返回。
/// `courseId` 省略 / null = **全库检索**（悬浮球没有课程上下文）；无命中返回 `[]`。
/// 检索策略见 `db::material_search`（FTS5 优先 + LIKE 兜底）。
#[tauri::command]
fn material_search(
    conn: State<'_, DbState>,
    course_id: Option<i64>,
    query: String,
    limit: Option<i64>,
) -> Result<Value, String> {
    let c = conn_of(&conn)?;
    let rows = db::material_search(&c, course_id, &query, limit)?;
    Ok(Value::Array(rows))
}

// ---------------------------------------------------------------------------
// 会话（多会话，持久化到 SQLite，重启不丢）
// ---------------------------------------------------------------------------

/// 会话列表；`course_id` 不传 = 全部会话。无结果时返回 `[]`。
#[tauri::command]
fn chat_sessions_list(
    conn: State<'_, DbState>,
    course_id: Option<i64>,
) -> Result<Vec<Value>, String> {
    let c = conn_of(&conn)?;
    db::chat_sessions_list(&c, course_id)
}

#[tauri::command]
fn chat_session_create(
    conn: State<'_, DbState>,
    course_id: Option<i64>,
    title: String,
) -> Result<i64, String> {
    let c = conn_of(&conn)?;
    db::chat_session_create(&c, course_id, &title)
}

#[tauri::command]
fn chat_session_rename(conn: State<'_, DbState>, id: i64, title: String) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::chat_session_rename(&c, id, &title)
}

#[tauri::command]
fn chat_session_delete(conn: State<'_, DbState>, id: i64) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::chat_session_delete(&c, id)
}

/// 读取会话消息；会话为空时返回 `[]`
#[tauri::command]
fn chat_history_load(conn: State<'_, DbState>, session_id: i64) -> Result<Vec<Value>, String> {
    let c = conn_of(&conn)?;
    db::chat_history_load(&c, session_id)
}

#[tauri::command]
fn chat_history_save(
    conn: State<'_, DbState>,
    session_id: i64,
    messages: Vec<db::ChatMsg>,
) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::chat_history_save(&c, session_id, &messages)
}

#[tauri::command]
fn chat_session_summary_set(
    conn: State<'_, DbState>,
    session_id: i64,
    summary: String,
) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::chat_session_summary_set(&c, session_id, &summary)
}

/// 修改会话归属课程（`courseId` 不传 = 写 `NULL`，即**不限定课程**）。
/// **不动 `updated_at`**（它表示"最后消息时间"，改归属不是消息事件）；幂等。
#[tauri::command]
fn chat_session_set_course(
    conn: State<'_, DbState>,
    id: i64,
    course_id: Option<i64>,
) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::chat_session_set_course(&c, id, course_id)
}

/// 一次取回某课程的问答素材（1 次 IPC；`since`/`limit` 都可省略）。
/// 无会话时 `session_count: 0` 且 `messages: []`（不返回 null）。
#[tauri::command]
fn chat_course_messages(
    conn: State<'_, DbState>,
    course_id: i64,
    since: Option<String>,
    limit: Option<i64>,
) -> Result<Value, String> {
    let c = conn_of(&conn)?;
    db::chat_course_messages(&c, course_id, since.as_deref(), limit)
}

// ---------------------------------------------------------------------------
// 笔记（M3）
// ---------------------------------------------------------------------------

/// 笔记列表（`course_id` 不传 = 全部课程）。行里只带 `content_len` 字符数，**不带全文**。
#[tauri::command]
fn notes_list(conn: State<'_, DbState>, course_id: Option<i64>) -> Result<Vec<Value>, String> {
    let c = conn_of(&conn)?;
    db::notes_list(&c, course_id)
}

/// 笔记详情（含 Markdown 全文 `content_md`）
#[tauri::command]
fn note_get(conn: State<'_, DbState>, id: i64) -> Result<Value, String> {
    let c = conn_of(&conn)?;
    db::note_get(&c, id)
}

/// 新建笔记：`source` 只接受 `ai_session` / `user`（非法值给可读中文错误，不静默入库）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn note_save(
    conn: State<'_, DbState>,
    course_id: i64,
    session_id: Option<i64>,
    title: String,
    content_md: String,
    date: Option<String>,
    source: String,
) -> Result<i64, String> {
    let c = conn_of(&conn)?;
    db::note_save(
        &c,
        course_id,
        session_id,
        &title,
        &content_md,
        date.as_deref(),
        &source,
    )
}

/// 局部更新标题 / 正文（不改来源与导出记录）
#[tauri::command]
fn note_update(
    conn: State<'_, DbState>,
    id: i64,
    title: Option<String>,
    content_md: Option<String>,
) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::note_update(&c, id, title.as_deref(), content_md.as_deref())
}

/// 删除笔记（其批注一并清除）
#[tauri::command]
fn note_delete(conn: State<'_, DbState>, id: i64) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::note_delete(&c, id)
}

/// 导出 .docx 的实现体（命令层只做 State 解包，便于单测直接调用）。
/// 流程：取标题 + Markdown 正文 → `docx::export_docx` → **把绝对路径写回 `notes.exported`** → 返回该路径。
fn export_note_docx(conn: &Connection, id: i64, dir: &str) -> Result<String, String> {
    let dir = dir.trim();
    if dir.is_empty() {
        return Err("请先选择导出目录。".into());
    }
    let (title, content_md) = db::note_export_source(conn, id)?;
    fs::create_dir_all(dir).map_err(|e| format!("创建导出目录失败：{e}"))?;
    let path = docx::export_docx(std::path::Path::new(dir), &title, &content_md)?;
    let abs = path.to_string_lossy().into_owned();
    db::note_exported_set(conn, id, &abs)?;
    Ok(abs)
}

/// 把笔记导出为 .docx（本机生成，不联网、不新增依赖），返回产出文件的绝对路径。
#[tauri::command]
fn note_export_docx(conn: State<'_, DbState>, id: i64, dir: String) -> Result<String, String> {
    let c = conn_of(&conn)?;
    export_note_docx(&c, id, &dir)
}

// ---------------------------------------------------------------------------
// 批注与高亮（M3）
// 锚点三件套：`blockIndex`（块序号）+ `startOff`/`endOff`（块内字符偏移）+ `quote`（原文片段）。
// ---------------------------------------------------------------------------

/// 某对象的批注列表（`targetKind` 目前用 `note`；字段进出都带 `block_index`）
#[tauri::command]
fn annotations_list(
    conn: State<'_, DbState>,
    target_kind: String,
    target_id: i64,
) -> Result<Vec<Value>, String> {
    let c = conn_of(&conn)?;
    db::annotations_list(&c, &target_kind, target_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn annotation_add(
    conn: State<'_, DbState>,
    target_kind: String,
    target_id: i64,
    block_index: i64,
    quote: String,
    start_off: i64,
    end_off: i64,
    color: Option<String>,
    comment: Option<String>,
) -> Result<i64, String> {
    let c = conn_of(&conn)?;
    db::annotation_add(
        &c,
        &target_kind,
        target_id,
        block_index,
        &quote,
        start_off,
        end_off,
        color.as_deref(),
        comment.as_deref(),
    )
}

/// 改颜色 / 备注（锚点不在这里改：挪位置等于重新划一次）
#[tauri::command]
fn annotation_update(
    conn: State<'_, DbState>,
    id: i64,
    color: Option<String>,
    comment: Option<String>,
) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::annotation_update(&c, id, color.as_deref(), comment.as_deref())
}

#[tauri::command]
fn annotation_delete(conn: State<'_, DbState>, id: i64) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::annotation_delete(&c, id)
}

// ---------------------------------------------------------------------------
// 番茄钟（M3）—— 本层只负责计时与记录，**不改动任何模型**
// ---------------------------------------------------------------------------

/// 开始一段专注/休息；`kind` 只接受 `focus` / `break`（非法值给可读中文错误）。
#[tauri::command]
fn focus_start(
    conn: State<'_, DbState>,
    course_id: Option<i64>,
    kind: String,
    plan_min: i64,
) -> Result<i64, String> {
    let c = conn_of(&conn)?;
    db::focus_start(&c, course_id, &kind, plan_min)
}

#[tauri::command]
fn focus_finish(
    conn: State<'_, DbState>,
    id: i64,
    actual_min: i64,
    completed: bool,
) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::focus_finish(&c, id, actual_min, completed)
}

/// 专注记录列表（按 `started_at` 倒序；`limit` 默认 20、上限 200）
#[tauri::command]
fn focus_list(conn: State<'_, DbState>, limit: Option<i64>) -> Result<Vec<Value>, String> {
    let c = conn_of(&conn)?;
    db::focus_list(&c, limit)
}

/// 专注统计（`days` 默认 7）：按**本地日期**分桶，见 `db::focus_stats` 的口径注释。
#[tauri::command]
fn focus_stats(conn: State<'_, DbState>, days: Option<i64>) -> Result<Value, String> {
    let c = conn_of(&conn)?;
    db::focus_stats(&c, days)
}

/// 发一条系统通知（阶段结束时用）。
/// 失败处理：**打日志 + 返回可读中文错误**（不静默吞掉）—— 通知没发出去是用户应当知道的事实，
/// 前端可据此如实提示"系统通知未发出，请检查系统通知设置"。
#[tauri::command]
fn focus_notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    let title = title.trim();
    let body = body.trim();
    if title.is_empty() {
        return Err("通知标题不能为空。".into());
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| {
            eprintln!("[focus] 系统通知发送失败：{e}");
            format!("系统通知发送失败（可能被系统或本应用的通知权限拦下）：{e}")
        })
}

// ---------------------------------------------------------------------------
// M4：知识点 / 题库 / 练习作答 / 学习画像（契约 docs/10-M4契约.md §二，命令名逐字对应）
// ---------------------------------------------------------------------------
//
// 口径红线（同 §一，命令层也照此把关）：
//   · 掌握度是**统计量**，不是"模型学会了"；本机只做统计加权与提示词调整，不训练、不上传。
//   · `attempts < db::MIN_EVIDENCE`（3）的知识点只进 `not_enough`，不给数字、不进弱项榜。
//   · 题目/答案必须可人工校正（`question_update` 含 `flawed` 标记）。

/// 某课程的知识点列表（公共轴：题库与画像都挂在它上面）
#[tauri::command]
fn knowledge_points_list(conn: State<'_, DbState>, course_id: i64) -> Result<Vec<Value>, String> {
    let c = conn_of(&conn)?;
    db::knowledge_points_list(&c, course_id)
}

/// 新建知识点；同名同课程已存在则返回既有 id（不重复插）
#[tauri::command]
fn knowledge_point_save(
    conn: State<'_, DbState>,
    course_id: i64,
    name: String,
    prior_id: Option<i64>,
    parent_id: Option<i64>,
) -> Result<i64, String> {
    let c = conn_of(&conn)?;
    db::knowledge_point_save(&c, course_id, &name, prior_id, parent_id)
}

/// 从该课程的**先验知识树**派生知识点（幂等），返回 `{ created, total }`
#[tauri::command]
fn knowledge_points_sync_from_prior(
    conn: State<'_, DbState>,
    course_id: i64,
) -> Result<Value, String> {
    let c = conn_of(&conn)?;
    db::knowledge_points_sync_from_prior(&c, course_id)
}

/// 题库列表（含 `attempts` / `last_correct`）；`courseId` / `kpId` 不传 = 不过滤
#[tauri::command]
fn questions_list(
    conn: State<'_, DbState>,
    course_id: Option<i64>,
    kp_id: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<Value>, String> {
    let c = conn_of(&conn)?;
    db::questions_list(&c, course_id, kp_id, limit)
}

/// 题目详情（全字段）
#[tauri::command]
fn question_get(conn: State<'_, DbState>, id: i64) -> Result<Value, String> {
    let c = conn_of(&conn)?;
    db::question_get(&c, id)
}

/// 新建题目；`qtype` 与 `options`（须为合法 JSON 数组）由 db 层校验，非法给可读中文错误
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn question_save(
    conn: State<'_, DbState>,
    course_id: i64,
    kp_id: Option<i64>,
    qtype: String,
    stem: String,
    options: Option<Value>,
    answer: String,
    explain: Option<String>,
    difficulty: Option<i64>,
    source: String,
    source_ref: Option<String>,
) -> Result<i64, String> {
    let c = conn_of(&conn)?;
    db::question_save(
        &c,
        course_id,
        kp_id,
        &qtype,
        &stem,
        options.as_ref(),
        &answer,
        explain.as_deref(),
        difficulty,
        &source,
        source_ref.as_deref(),
    )
}

/// **批量入库**：一次事务写完，避免前端 N 次 IPC（M3 的 T20 教训）；任一项不合法则整体回滚
#[tauri::command]
fn questions_save_batch(
    conn: State<'_, DbState>,
    course_id: i64,
    items: Vec<db::NewQuestion>,
) -> Result<Vec<i64>, String> {
    let c = conn_of(&conn)?;
    db::questions_save_batch(&c, course_id, &items)
}

/// 人工校正题目（题干 / 选项 / 答案 / 解析 / 难度 / 标记"题目有问题"）；不传的字段不改动
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn question_update(
    conn: State<'_, DbState>,
    id: i64,
    stem: Option<String>,
    options: Option<Value>,
    answer: Option<String>,
    explain: Option<String>,
    difficulty: Option<i64>,
    flawed: Option<bool>,
) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::question_update(
        &c,
        id,
        stem.as_deref(),
        options.as_ref(),
        answer.as_deref(),
        explain.as_deref(),
        difficulty,
        flawed,
    )
}

/// 删除题目（连同它的作答记录）
#[tauri::command]
fn question_delete(conn: State<'_, DbState>, id: i64) -> Result<(), String> {
    let c = conn_of(&conn)?;
    db::question_delete(&c, id)
}

/// 选题（统计加权：未作答优先 → 知识点掌握度升序 → 同分按 id）；`count` 默认 5、上限 50
#[tauri::command]
fn practice_pick(
    conn: State<'_, DbState>,
    course_id: i64,
    kp_id: Option<i64>,
    count: Option<i64>,
) -> Result<Vec<Value>, String> {
    let c = conn_of(&conn)?;
    db::practice_pick(&c, course_id, kp_id, count)
}

/// 记录一次作答；`confidence` 越界（1–5）/ `durationMs` 为负 → 可读中文错误
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn attempt_record(
    conn: State<'_, DbState>,
    question_id: i64,
    user_answer: Option<String>,
    correct: Option<bool>,
    self_eval: Option<i64>,
    duration_ms: Option<i64>,
    confidence: Option<i64>,
) -> Result<i64, String> {
    let c = conn_of(&conn)?;
    db::attempt_record(
        &c,
        question_id,
        user_answer.as_deref(),
        correct,
        self_eval,
        duration_ms,
        confidence,
    )
}

/// 作答记录列表（**错题本数据源**）；`onlyWrong` = 明确判错或自评未掌握
#[tauri::command]
fn attempts_list(
    conn: State<'_, DbState>,
    course_id: Option<i64>,
    kp_id: Option<i64>,
    only_wrong: Option<bool>,
    limit: Option<i64>,
) -> Result<Vec<Value>, String> {
    let c = conn_of(&conn)?;
    db::attempts_list(&c, course_id, kp_id, only_wrong, limit)
}

/// 按知识点聚合的统计（每项含 `accuracy` 与 `mastery`、`evidence`）
#[tauri::command]
fn question_stats(conn: State<'_, DbState>, course_id: i64) -> Result<Value, String> {
    let c = conn_of(&conn)?;
    db::question_stats(&c, course_id)
}

/// 画像条目列表（本机）
#[tauri::command]
fn profile_traits_list(
    conn: State<'_, DbState>,
    course_id: Option<i64>,
) -> Result<Vec<Value>, String> {
    let c = conn_of(&conn)?;
    db::profile_traits_list(&c, course_id)
}

/// 写入画像条目（自述缺漏 / 偏好 / 风格）。
/// 形参用 `r#trait`：Tauri 的宏会 `unraw()` 后再转 camelCase，
/// 因此前端传的就是契约里的 `trait`（不是 `traitName`）。`mastery` 由 db 层拒收（只读口径）。
#[tauri::command]
fn profile_trait_set(
    conn: State<'_, DbState>,
    kp_id: Option<i64>,
    r#trait: String,
    value: Option<f64>,
    evidence: Option<i64>,
) -> Result<i64, String> {
    let c = conn_of(&conn)?;
    db::profile_trait_set(&c, kp_id, &r#trait, value, evidence)
}

/// 学习画像总览：`mastery` / `weak_points` / `not_enough` / `declared_gaps` /
/// `preferences` / `min_evidence`（全为本机查询）
#[tauri::command]
fn profile_overview(conn: State<'_, DbState>, course_id: i64) -> Result<Value, String> {
    let c = conn_of(&conn)?;
    db::profile_overview(&c, course_id)
}

// ---------------------------------------------------------------------------
// 文件：用系统默认程序打开 / 在资源管理器中定位
// ---------------------------------------------------------------------------

/// 允许交给系统打开的扩展名白名单（不在此列的扩展名一律拒绝，避免变成任意程序启动器）
const OK_EXT: [&str; 14] = [
    "docx", "doc", "md", "txt", "xlsx", "xls", "pdf", "html", "htm", "csv", "png", "jpg", "jpeg",
    "webp",
];

fn ext_of(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default()
}

/// 用系统默认程序打开文件（白名单扩展名；零依赖：调用 Windows 文件关联）
#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("文件不存在，可能已被移动或删除。".into());
    }
    if !p.is_file() {
        return Err("这不是一个文件。".into());
    }
    let ext = ext_of(&path);
    if !OK_EXT.contains(&ext.as_str()) {
        return Err(format!("出于安全考虑，春晓不支持打开 .{ext} 类型的文件。"));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("打开文件失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (p, ext);
        Err("当前平台暂不支持，请在文件管理器中手动打开。".into())
    }
}

/// 在资源管理器中定位文件（零依赖：explorer /select）
#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("路径不存在，可能已被移动或删除。".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{path}"))
            .spawn()
            .map_err(|e| format!("打开所在目录失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = p;
        Err("当前平台暂不支持，请在文件管理器中手动定位。".into())
    }
}

// ---------------------------------------------------------------------------
// 备份 / 还原
// ---------------------------------------------------------------------------

/// 手动备份：把本地数据库复制到指定目录，文件名 `chunxiao-<时间戳>.db`
#[tauri::command]
fn backup_now(app: AppHandle, dir: String) -> Result<String, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let src = data_dir.join(db::DB_FILE);
    if !src.exists() {
        return Err("本地数据库不存在（可能还没初始化过）。".into());
    }
    // 先把 WAL 落盘，保证复制出来的 .db 是完整的
    let state = app.state::<DbState>();
    if let Ok(c) = state.0.lock() {
        let _ = c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
    }

    fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败：{e}"))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let dst = std::path::Path::new(&dir).join(format!("chunxiao-{stamp}.db"));
    fs::copy(&src, &dst).map_err(|e| format!("备份失败：{e}"))?;
    Ok(dst.to_string_lossy().into_owned())
}

/// 还原：用备份文件替换本地数据库。
/// 还原前先把当前库另存一份；替换过程中任何一步失败都回退到原库，
/// 不会把用户留在「空库」状态。连接就地更换，不需要重启。
#[tauri::command]
fn restore(app: AppHandle, file: String) -> Result<String, String> {
    let src = std::path::PathBuf::from(&file);
    if !src.exists() {
        return Err("备份文件不存在，请重新选择。".into());
    }
    if !src.is_file() {
        return Err("请选择一个 .db 备份文件。".into());
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = data_dir.join(db::DB_FILE);
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");

    // ① 先把备份文件拷到数据目录的临时文件：连这一步都失败时，库还完全没被动过
    fs::create_dir_all(&data_dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let tmp = data_dir.join(format!("{}.restore-{stamp}.tmp", db::DB_FILE));
    fs::copy(&src, &tmp).map_err(|e| format!("读取备份文件失败：{e}"))?;

    let state = app.state::<DbState>();
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "数据库状态异常（上一次写入可能中断），请重启春晓后重试。".to_string())?;

    // ② 还原前先把当前库另存一份备份
    let _ = guard.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
    let keep = data_dir.join(format!("chunxiao-before-restore-{stamp}.db"));
    let kept = fs::copy(&db_path, &keep).is_ok();

    // ③ 关掉当前连接（换成内存库占位后释放句柄），清掉 WAL 残留，再用备份替换库文件
    let placeholder =
        Connection::open_in_memory().map_err(|e| format!("重建数据库连接失败：{e}"))?;
    let old = std::mem::replace(&mut *guard, placeholder);
    drop(old);
    for suffix in ["-wal", "-shm"] {
        let _ = fs::remove_file(format!("{}{suffix}", db_path.display()));
    }
    if let Err(e) = fs::rename(&tmp, &db_path) {
        // 替换失败：原库文件还在，把连接重新打开，尽量恢复可用状态
        let _ = fs::remove_file(&tmp);
        if let Ok(conn) = db::open_and_migrate(&data_dir) {
            *guard = conn;
        }
        return Err(format!("还原失败（已保留原数据库）：{e}"));
    }

    // ④ 重新打开 + 迁移；失败则回退到刚才另存的备份，避免停在空库
    match db::open_and_migrate(&data_dir) {
        Ok(conn) => {
            *guard = conn;
        }
        Err(e) => {
            let _ = fs::remove_file(&db_path);
            let rolled_back = kept && fs::copy(&keep, &db_path).is_ok();
            if let Ok(conn) = db::open_and_migrate(&data_dir) {
                *guard = conn;
            }
            return Err(if rolled_back {
                format!("还原失败（已回退到原数据库）：{e}")
            } else {
                format!("还原失败，且原数据库回退未成功：{e}")
            });
        }
    }
    drop(guard);

    Ok(if kept {
        format!("还原成功。原数据库已另存为 {}", keep.to_string_lossy())
    } else {
        "还原成功（原数据库另存失败，建议检查磁盘权限）".to_string()
    })
}

// ---------------------------------------------------------------------------
// 后台提醒：轮询待办，到期的发系统通知（每 30 秒一次）
// M0 没有待办写入命令，这里先把链路打通（M1 的番茄钟 / 作业提醒直接复用）
// ---------------------------------------------------------------------------

fn check_todo_notifications(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;

    let state = app.state::<DbState>();
    let Ok(conn) = state.0.lock() else {
        return;
    };
    let Ok(rows) = db::todos_due(&conn) else {
        return;
    };
    let now = chrono::Local::now();

    // 只挑「未完成 + 已开弹窗 + 有到期时间 + 该到期时间还没提醒过」的待办
    let mut pending: Vec<(i64, String, String)> = Vec::new();
    for (id, title, due_at, remind_minutes) in rows {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&due_at) {
            let due_local: chrono::DateTime<chrono::Local> = dt.with_timezone(&chrono::Local);
            // 到期时刻 - 提前提醒分钟数 <= 当前时间 => 触发提醒
            if due_local <= now + chrono::Duration::minutes(remind_minutes.max(0)) {
                pending.push((id, title, due_at));
            }
        }
    }

    for (id, title, due_at) in pending {
        // 记录已提醒的到期时间，避免同一到期时间重复提醒
        let _ = db::todo_mark_notified(&conn, id, &due_at);
        let _ = app
            .notification()
            .builder()
            .title("春晓 · 待办提醒")
            .body(format!("「{title}」已到期或即将到期，别忘了处理。"))
            .show();
    }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 数据目录：%APPDATA%\com.chunxiao.study\，库文件 chunxiao.db（WAL）
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let conn = db::init(&dir)?;
            // 历史明文 API Key → 混淆存储（幂等迁移）
            migrate_secret_keys(&conn);
            app.manage(DbState(Mutex::new(conn)));

            // floating-ball → 春晓 桥接轮询（读 %APPDATA%\chunxiao-ball\from-ball.json）
            // M0 **不自动拉起**悬浮球：由用户在设置页点按钮触发，避免调试期反复弹窗。
            ball::start_bridge_poller(app.handle().clone());

            // 后台线程：每 30 秒轮询一次待办，到期的发系统通知
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(30));
                check_todo_notifications(&handle);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 通用
            ping,
            // 设置（BYOK）
            settings_get,
            settings_set,
            // 课程
            courses_list,
            course_create,
            course_update,
            course_archive,
            course_delete,
            // 先验知识
            prior_list,
            prior_add,
            prior_update,
            prior_verify,
            prior_delete,
            // R1：批量写入先验知识树（顶层 + 子项，1 次 IPC、整批一个事务）
            prior_add_tree,
            // 材料
            materials_list,
            material_add,
            material_delete,
            material_text_all,
            extract_material,
            // M1：字节导入 + 带出处检索
            extract_material_b64,
            material_search,
            // 会话
            chat_sessions_list,
            chat_session_create,
            chat_session_rename,
            chat_session_delete,
            chat_history_load,
            chat_history_save,
            chat_session_summary_set,
            // R1：会话课程归属 + 一次取全本课问答素材（提炼先验知识 / 笔记收集复用）
            chat_session_set_course,
            chat_course_messages,
            // M3：笔记（含 .docx 导出）
            notes_list,
            note_get,
            note_save,
            note_update,
            note_delete,
            note_export_docx,
            // M3：批注与高亮（锚点 = block_index + 块内偏移 + quote）
            annotations_list,
            annotation_add,
            annotation_update,
            annotation_delete,
            // M3：番茄钟（只计时与记录，不改动模型）
            focus_start,
            focus_finish,
            focus_list,
            focus_stats,
            focus_notify,
            // M4：知识点（题库与画像的公共轴）
            knowledge_points_list,
            knowledge_point_save,
            knowledge_points_sync_from_prior,
            // M4：题库（AI 生成需预览确认后才批量入库；题目可人工校正）
            questions_list,
            question_get,
            question_save,
            questions_save_batch,
            question_update,
            question_delete,
            // M4：练习与作答（统计加权选题；作答记录是画像的唯一原始信号）
            practice_pick,
            attempt_record,
            attempts_list,
            // M4：统计与画像（本机；不是强化学习，模型权重不会因此改变）
            question_stats,
            profile_traits_list,
            profile_trait_set,
            profile_overview,
            // 悬浮球（Electron，外部应用）
            ball::ball_start_cmd,
            ball::ball_show,
            ball::ball_hide,
            ball::ball_prefill,
            ball::ball_quit,
            // 文件打开 / 定位
            open_file,
            reveal_in_folder,
            // 备份 / 还原
            backup_now,
            restore,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// 当前临时目录里 `chunxiao-import-*` 的个数（验证临时文件不残留）
    fn import_tmp_count() -> usize {
        std::fs::read_dir(std::env::temp_dir())
            .map(|it| {
                it.filter_map(Result::ok)
                    .filter(|e| {
                        e.file_name()
                            .to_string_lossy()
                            .starts_with("chunxiao-import-")
                    })
                    .count()
            })
            .unwrap_or(0)
    }

    /// `extract_material_b64`：base64 解码 + 与 `extract_material` **同形**。
    /// 顺带覆盖 `data:` 前缀容忍、pdf 的诚实 note、20 MB 上限、临时文件清理。
    #[test]
    fn extract_material_b64_decodes_and_matches_extract_material_shape() {
        let body = "# 第一章 极限\n\n极限的定义。\n\n# 第二章 导数\n\n导数的定义。\n";
        let path = std::env::temp_dir().join(format!(
            "chunxiao-b64-test-{}.txt",
            std::process::id()
        ));
        std::fs::write(&path, body).unwrap();

        let by_path = extract_material(path.to_string_lossy().into_owned()).unwrap();
        let before = import_tmp_count();

        // ① 原始 base64：返回形状必须与路径导入**完全相同**
        let payload = b64(body.as_bytes());
        let by_b64 = extract_material_b64("讲义.txt".into(), payload.clone()).unwrap();
        assert_eq!(by_b64, by_path, "字节导入与路径导入的返回形状必须一致");

        // ② 容忍 data:...;base64, 前缀（前端 FileReader.readAsDataURL 的产物）
        let with_prefix =
            extract_material_b64("讲义.txt".into(), format!("data:text/plain;base64,{payload}"))
                .unwrap();
        assert_eq!(with_prefix, by_path);

        // ③ 内容真的解出来了（不是空壳）
        assert_eq!(by_b64["kind"], "txt");
        assert!(by_b64["text"].as_str().unwrap().contains("极限的定义"));
        assert_eq!(by_b64["truncated"], false);
        assert!(by_b64["note"].is_null(), "txt 不该带 note：{}", by_b64["note"]);

        // ④ pdf：与 extract_material 一致地「返回 Ok + 诚实 note」，不假装支持
        let pdf = extract_material_b64("扫描件.pdf".into(), b64(b"%PDF-1.7 fake")).unwrap();
        assert_eq!(pdf["kind"], "pdf");
        assert_eq!(pdf["text"], "");
        assert!(pdf["note"].as_str().unwrap().contains("M2"));

        // ⑤ 超过 20 MB 上限：给可读中文错误，不做无谓解码
        let huge = "A".repeat(MAX_B64_CHARS + 4);
        let err = extract_material_b64("大文件.txt".into(), huge).unwrap_err();
        assert!(err.contains("20 MB"), "错误信息应说明上限：{err}");

        // ⑥ 非法 base64 / 空内容
        assert!(extract_material_b64("坏.txt".into(), "!!!不是 base64!!!".into()).is_err());
        assert!(extract_material_b64("空.txt".into(), "   ".into()).is_err());

        // ⑦ 临时文件不残留（成功与失败路径都要清理）
        let _ = std::fs::remove_file(&path);
        assert_eq!(import_tmp_count(), before, "导入用的临时文件必须清理干净");
    }
}
