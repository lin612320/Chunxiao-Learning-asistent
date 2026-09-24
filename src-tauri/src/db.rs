// 春晓学习助手 —— 本地 SQLite 数据层
//
// 表结构照抄 `docs/00-可行性评估.md` §6.3 的 DDL 草案（字段名与类型不改）；
// 迁移风格照搬母本 db.rs：`CREATE TABLE IF NOT EXISTS` 幂等建表 + `ensure_column` 幂等补列。
// M0 一次把全部表建齐（含 M1–M5 才会用到的笔记 / 题库 / 画像 / 番茄钟），避免后续迁移。
//
// 两条产品口径在本层落地：
//   1) 「不编造内容」：空库只播种**一门示例课程**并写明是示例；绝不播种假知识点 / 假题目。
//   2) 「可溯源」：course_prior.source 为 NOT NULL（ai | textbook | web | user | <材料名>），
//      questions.source_ref / chat_messages.refs 保留引用，供前端展示出处。

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

/// 全局数据库连接（SQLite 本地库）。
/// 作为 Tauri 的 managed state 注入，命令里用 `State<'_, DbState>` 取用。
pub struct DbState(pub Mutex<Connection>);

/// 数据库文件名（契约：`chunxiao.db`）
pub const DB_FILE: &str = "chunxiao.db";

/// 材料切块：目标长度与单块上限（字符）。docs/00 §6.4 建议 500–800 字一块。
const CHUNK_TARGET: usize = 600;
const CHUNK_MAX: usize = 800;

// ---------------------------------------------------------------------------
// 打开 / 迁移
// ---------------------------------------------------------------------------

/// 初始化数据库：建目录 → 开库 → 设 PRAGMA → 迁移建表 → 播种示例课程。
pub fn init(app_data_dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let db_path = app_data_dir.join(DB_FILE);
    let conn = Connection::open(&db_path).map_err(|e| format!("打开数据库失败：{e}"))?;
    prepare(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

/// 打开已有库文件并补齐 PRAGMA + 迁移（备份还原后复用）。
pub fn open_and_migrate(app_data_dir: &Path) -> Result<Connection, String> {
    let db_path = app_data_dir.join(DB_FILE);
    let conn = Connection::open(&db_path).map_err(|e| format!("打开数据库失败：{e}"))?;
    prepare(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

/// 连接级 PRAGMA（契约要求：WAL + 外键开启）
fn prepare(conn: &Connection) -> Result<(), String> {
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("设置 WAL 失败：{e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("启用外键失败：{e}"))?;
    Ok(())
}

/// 若表缺列则补列（幂等兼容迁移）
fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<(), String> {
    let has: bool = {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(friendly)?;
        let cols = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(friendly)?;
        let mut found = false;
        for c in cols {
            if c.map_err(friendly)? == column {
                found = true;
                break;
            }
        }
        found
    };
    if !has {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
            [],
        )
        .map_err(friendly)?;
    }
    Ok(())
}

/// 表结构迁移（全部表一次建齐，可重复执行）
fn migrate(conn: &Connection) -> Result<(), String> {
    // ⑯ 键值设置（ai.base_url / ai.api_key(加密) / ai.model / theme / pet.* …）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        )",
        [],
    )
    .map_err(friendly)?;

    // ① 课程
    conn.execute(
        "CREATE TABLE IF NOT EXISTS courses (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            term        TEXT,
            teacher     TEXT,
            intro       TEXT,
            cover       TEXT,
            archived    INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL
        )",
        [],
    )
    .map_err(friendly)?;

    // ② 先验知识（课程知识骨架）—— 每条必须带来源，这是 §7.3 的落地
    conn.execute(
        "CREATE TABLE IF NOT EXISTS course_prior (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
            parent_id   INTEGER,
            topic       TEXT NOT NULL,
            summary     TEXT,
            detail      TEXT,
            source      TEXT NOT NULL,
            source_ref  TEXT,
            confidence  REAL,
            verified    INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL
        )",
        [],
    )
    .map_err(friendly)?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_prior_course ON course_prior(course_id, parent_id)",
        [],
    )
    .map_err(friendly)?;

    // ③ 材料（课件 / 电子书 / 讲义）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS materials (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            course_id    INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
            file_name    TEXT NOT NULL,
            file_path    TEXT NOT NULL,
            kind         TEXT,
            size_bytes   INTEGER,
            extracted_by TEXT,
            text_len     INTEGER,
            truncated    INTEGER NOT NULL DEFAULT 0,
            note         TEXT,
            created_at   TEXT NOT NULL
        )",
        [],
    )
    .map_err(friendly)?;

    // ④ 材料切块（检索单元）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS material_chunks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
            course_id   INTEGER NOT NULL,
            seq         INTEGER NOT NULL,
            page        INTEGER,
            heading     TEXT,
            content     TEXT NOT NULL,
            tokens      INTEGER
        )",
        [],
    )
    .map_err(friendly)?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_chunk_material ON material_chunks(material_id, seq)",
        [],
    )
    .map_err(friendly)?;

    // ⑤ 全文检索（FTS5 外部内容表 + 三个同步触发器）
    ensure_chunks_fts(conn);

    // ⑥ 对话
    conn.execute(
        "CREATE TABLE IF NOT EXISTS chat_sessions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            course_id  INTEGER,
            title      TEXT NOT NULL,
            summary    TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT
        )",
        [],
    )
    .map_err(friendly)?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS chat_messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            role        TEXT NOT NULL,
            content     TEXT NOT NULL,
            refs        TEXT,
            source_kind TEXT,
            created_at  TEXT NOT NULL
        )",
        [],
    )
    .map_err(friendly)?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_chat_msg_session ON chat_messages(session_id, id)",
        [],
    )
    .map_err(friendly)?;

    // ⑦ 笔记
    conn.execute(
        "CREATE TABLE IF NOT EXISTS notes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            course_id  INTEGER NOT NULL,
            session_id INTEGER,
            title      TEXT NOT NULL,
            content_md TEXT NOT NULL,
            date       TEXT,
            exported   TEXT,
            created_at TEXT NOT NULL
        )",
        [],
    )
    .map_err(friendly)?;

    // ⑧ 高亮与批注（锚点：段落 id + 字符偏移）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS annotations (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            target_kind TEXT NOT NULL,
            target_id   INTEGER NOT NULL,
            quote       TEXT,
            start_off   INTEGER,
            end_off     INTEGER,
            color       TEXT,
            comment     TEXT,
            created_at  TEXT NOT NULL
        )",
        [],
    )
    .map_err(friendly)?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_anno_target ON annotations(target_kind, target_id)",
        [],
    )
    .map_err(friendly)?;

    // ⑨ 知识点（题库与画像的公共轴）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS knowledge_points (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            course_id INTEGER NOT NULL,
            prior_id  INTEGER,
            name      TEXT NOT NULL,
            parent_id INTEGER
        )",
        [],
    )
    .map_err(friendly)?;

    // ⑩ 题库
    conn.execute(
        "CREATE TABLE IF NOT EXISTS questions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            course_id  INTEGER NOT NULL,
            kp_id      INTEGER REFERENCES knowledge_points(id),
            qtype      TEXT NOT NULL,
            stem       TEXT NOT NULL,
            options    TEXT,
            answer     TEXT NOT NULL,
            explain    TEXT,
            difficulty INTEGER,
            source     TEXT NOT NULL,
            source_ref TEXT,
            flawed     INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )",
        [],
    )
    .map_err(friendly)?;

    // ⑪ 作答记录（画像与「迭代」的原始信号）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS attempts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
            user_answer TEXT,
            correct     INTEGER,
            self_eval   INTEGER,
            duration_ms INTEGER,
            confidence  INTEGER,
            created_at  TEXT NOT NULL
        )",
        [],
    )
    .map_err(friendly)?;

    // ⑫ 用户画像（**本机**，不外传）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS profile_traits (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            kp_id      INTEGER REFERENCES knowledge_points(id),
            trait      TEXT NOT NULL,
            value      REAL,
            evidence   INTEGER,
            updated_at TEXT NOT NULL
        )",
        [],
    )
    .map_err(friendly)?;

    // ⑬ 桌宠状态（单行）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS pet_state (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            name        TEXT,
            skin        TEXT,
            affinity    INTEGER NOT NULL DEFAULT 0,
            treats      INTEGER NOT NULL DEFAULT 0,
            pets        INTEGER NOT NULL DEFAULT 0,
            feeds       INTEGER NOT NULL DEFAULT 0,
            turns       INTEGER NOT NULL DEFAULT 0,
            last_pet_at TEXT,
            display     TEXT,
            updated_at  TEXT
        )",
        [],
    )
    .map_err(friendly)?;

    // ⑭ 专注记录（番茄钟）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS focus_sessions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            course_id  INTEGER,
            kind       TEXT NOT NULL,
            plan_min   INTEGER NOT NULL,
            actual_min INTEGER,
            completed  INTEGER NOT NULL DEFAULT 0,
            started_at TEXT NOT NULL,
            ended_at   TEXT
        )",
        [],
    )
    .map_err(friendly)?;

    // ⑮ 待办 / DDL（照搬母本 todos，含 last_notified_due 防重复提醒）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS todos (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            title             TEXT NOT NULL,
            note              TEXT,
            due_at            TEXT,
            remind_minutes    INTEGER NOT NULL DEFAULT 0,
            desktop_popup     INTEGER NOT NULL DEFAULT 1,
            done              INTEGER NOT NULL DEFAULT 0,
            last_notified_due TEXT,
            created_at        TEXT NOT NULL
        )",
        [],
    )
    .map_err(friendly)?;

    // ⑰ 记忆向量（embedding 存本机，供记忆召回）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS mem_vectors (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            kind        TEXT NOT NULL DEFAULT 'task',
            ref_id      INTEGER,
            title       TEXT,
            content     TEXT,
            vector_json TEXT,
            created_at  TEXT NOT NULL
        )",
        [],
    )
    .map_err(friendly)?;

    // —— 幂等补列（旧库升级用；新库上这些列已存在，全部是 no-op）——
    // 照搬母本做法：新增字段一律走 ensure_column，不做破坏性迁移。
    ensure_column(conn, "courses", "cover", "TEXT")?;
    ensure_column(conn, "courses", "archived", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(conn, "chat_sessions", "course_id", "INTEGER")?;
    ensure_column(conn, "chat_sessions", "summary", "TEXT")?;
    ensure_column(conn, "chat_sessions", "updated_at", "TEXT")?;
    ensure_column(conn, "chat_messages", "refs", "TEXT")?;
    ensure_column(conn, "chat_messages", "source_kind", "TEXT")?;
    // `chat_messages.images`（R4）：本轮提问携带的图片，JSON 数组、元素是完整 dataURL。
    //   刻意允许 NULL —— 旧消息没有这个值，前端必须能区分"没有图"与"图数组为空"。
    //   单条消息的图片总量在写入侧有硬上限（见 CHAT_IMAGES_MAX_BYTES），避免单条消息撑爆库。
    ensure_column(conn, "chat_messages", "images", "TEXT")?;
    ensure_column(conn, "materials", "note", "TEXT")?;
    ensure_column(conn, "materials", "truncated", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(conn, "course_prior", "verified", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(conn, "course_prior", "confidence", "REAL")?;
    ensure_column(conn, "todos", "last_notified_due", "TEXT")?;

    // —— M3 新增两列（同样只走 ensure_column，**不改上面的 CREATE TABLE**，旧库平滑升级）——
    // `annotations.block_index`：批注锚点的**块序号**（原表只有全文字符偏移，Markdown 重排后会静默错位）。
    //   刻意允许 NULL —— 旧批注没有这个值，"没有块序号"必须能与"块序号是 0"区分开。
    ensure_column(conn, "annotations", "block_index", "INTEGER")?;
    // `notes.source`：内容来源（`ai_session` = AI 依据对话整理，必须标「待核对」；`user` = 用户自己写的）。
    //   旧库补列时给默认值 `'user'`：老数据本来就无法证明是 AI 整理的，**不能反过来假装**。
    ensure_column(conn, "notes", "source", "TEXT DEFAULT 'user'")?;

    // 空库播种：仅一门示例课程
    seed_example_course_if_empty(conn)?;

    Ok(())
}

/// ⑯ 建立 chunks_fts（FTS5 外部内容表）+ chunks_ai / chunks_ad / chunks_au 同步触发器。
/// 任何一步失败都只打日志、不影响主流程（材料检索可回退 LIKE）。
/// `tokenize='trigram'` 对中文友好（母本在 15 万条法库上的结论，docs/00 §6.4）。
fn ensure_chunks_fts(conn: &Connection) -> bool {
    if let Err(e) = conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            content, heading,
            content='material_chunks', content_rowid='id', tokenize='trigram'
        )",
        [],
    ) {
        eprintln!("[fts] 创建 chunks_fts 失败（材料检索将回退 LIKE）：{e}");
        return false;
    }
    let _ = conn.execute(
        "CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON material_chunks BEGIN
            INSERT INTO chunks_fts(rowid, content, heading)
            VALUES (new.id, new.content, new.heading);
         END",
        [],
    );
    let _ = conn.execute(
        "CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON material_chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, content, heading)
            VALUES ('delete', old.id, old.content, old.heading);
         END",
        [],
    );
    let _ = conn.execute(
        "CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON material_chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, content, heading)
            VALUES ('delete', old.id, old.content, old.heading);
            INSERT INTO chunks_fts(rowid, content, heading)
            VALUES (new.id, new.content, new.heading);
         END",
        [],
    );
    true
}

/// 空库时播种一门**示例课程**（不是真实课程数据）。
/// 刻意不播种知识点 / 题目：这个项目有明确的「不编造内容」口径。
fn seed_example_course_if_empty(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM courses", [], |r| r.get(0))
        .map_err(friendly)?;
    if count > 0 {
        return Ok(());
    }
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO courses(name, term, teacher, intro, archived, created_at)
         VALUES (?1, NULL, NULL, ?2, 0, ?3)",
        rusqlite::params![
            "示例课程 · 可删除",
            "这是一门示例课程，只为让你首次打开春晓时能看到界面长什么样。\
             它不是你的真实课程数据，你可以直接改名、编辑，或者删掉它再新建自己的课程。\
             （春晓不会为你编造知识点或题目，先验知识与题目都由你导入的材料或你自己确认后才有内容。）",
            now
        ],
    )
    .map_err(friendly)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 设置（settings）：key / value 键值对
// ---------------------------------------------------------------------------

/// 读取一条设置（返回原样存储值，密钥类由命令层解密）
pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare("SELECT value FROM settings WHERE key = ?1")
        .map_err(friendly)?;
    let mut rows = stmt.query([key]).map_err(friendly)?;
    let row = rows.next().map_err(friendly)?;
    Ok(row.map(|r| r.get::<_, String>(0).unwrap_or_default()))
}

/// 列出全部设置（启动时用于明文密钥迁移）
pub fn settings_all(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(friendly)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(friendly)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

/// 写入一条设置（upsert）
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )
    .map(|_| ())
    .map_err(friendly)
}

// ---------------------------------------------------------------------------
// 课程（courses）
// ---------------------------------------------------------------------------

/// 课程列表：含先验知识 / 材料 / 会话条数（未归档在前，新建在前）
pub fn courses_list(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.name, c.term, c.teacher, c.intro, c.cover, c.archived, c.created_at,
                    (SELECT COUNT(*) FROM course_prior p WHERE p.course_id = c.id),
                    (SELECT COUNT(*) FROM materials m WHERE m.course_id = c.id),
                    (SELECT COUNT(*) FROM chat_sessions s WHERE s.course_id = c.id)
             FROM courses c
             ORDER BY c.archived ASC, c.created_at DESC, c.id DESC",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "name": r.get::<_, String>(1)?,
                "term": r.get::<_, Option<String>>(2)?,
                "teacher": r.get::<_, Option<String>>(3)?,
                "intro": r.get::<_, Option<String>>(4)?,
                "cover": r.get::<_, Option<String>>(5)?,
                // archived / verified / truncated 一律返回 SQLite 原值 0|1
                // （前端 TS 类型即 `archived: number; // 0 | 1`，按真值判断同样成立）
                "archived": r.get::<_, i64>(6)?,
                "created_at": r.get::<_, String>(7)?,
                "prior_count": r.get::<_, i64>(8)?,
                "material_count": r.get::<_, i64>(9)?,
                "session_count": r.get::<_, i64>(10)?,
            }))
        })
        .map_err(friendly)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

/// 新建课程，返回新 id
pub fn course_create(
    conn: &Connection,
    name: &str,
    term: Option<&str>,
    teacher: Option<&str>,
    intro: Option<&str>,
) -> Result<i64, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("课程名称不能为空。".into());
    }
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO courses(name, term, teacher, intro, archived, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)",
        rusqlite::params![name, term, teacher, intro, now],
    )
    .map_err(friendly)?;
    Ok(conn.last_insert_rowid())
}

/// 局部更新课程（只改动传入的字段；都为空则不改）
pub fn course_update(
    conn: &Connection,
    id: i64,
    name: Option<&str>,
    term: Option<&str>,
    teacher: Option<&str>,
    intro: Option<&str>,
) -> Result<(), String> {
    if let Some(v) = name {
        let v = v.trim();
        if v.is_empty() {
            return Err("课程名称不能为空。".into());
        }
        let n = conn
            .execute("UPDATE courses SET name = ?1 WHERE id = ?2", rusqlite::params![v, id])
            .map_err(friendly)?;
        ensure_affected(n, "课程", id)?;
    }
    if let Some(v) = term {
        let n = conn
            .execute("UPDATE courses SET term = ?1 WHERE id = ?2", rusqlite::params![v, id])
            .map_err(friendly)?;
        ensure_affected(n, "课程", id)?;
    }
    if let Some(v) = teacher {
        let n = conn
            .execute(
                "UPDATE courses SET teacher = ?1 WHERE id = ?2",
                rusqlite::params![v, id],
            )
            .map_err(friendly)?;
        ensure_affected(n, "课程", id)?;
    }
    if let Some(v) = intro {
        let n = conn
            .execute("UPDATE courses SET intro = ?1 WHERE id = ?2", rusqlite::params![v, id])
            .map_err(friendly)?;
        ensure_affected(n, "课程", id)?;
    }
    Ok(())
}

/// 归档 / 取消归档
pub fn course_archive(conn: &Connection, id: i64, archived: bool) -> Result<(), String> {
    let n = conn
        .execute(
            "UPDATE courses SET archived = ?1 WHERE id = ?2",
            rusqlite::params![flag(archived), id],
        )
        .map_err(friendly)?;
    ensure_affected(n, "课程", id)
}

/// 删除课程：先验知识 / 材料 / 材料切块随外键级联删除；
/// 会话不被删掉（对话是用户资产），只解除课程归属，避免留下悬空 course_id。
pub fn course_delete(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE chat_sessions SET course_id = NULL WHERE course_id = ?1",
        [id],
    )
    .map_err(friendly)?;
    let n = conn
        .execute("DELETE FROM courses WHERE id = ?1", [id])
        .map_err(friendly)?;
    ensure_affected(n, "课程", id)
}

// ---------------------------------------------------------------------------
// 先验知识（course_prior）
// ---------------------------------------------------------------------------

/// 某课程的全部先验知识（扁平返回，前端按 parent_id 组树）
pub fn prior_list(conn: &Connection, course_id: i64) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, course_id, parent_id, topic, summary, detail, source, source_ref,
                    confidence, verified, created_at
             FROM course_prior WHERE course_id = ?1
             ORDER BY COALESCE(parent_id, 0), id",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map([course_id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "course_id": r.get::<_, i64>(1)?,
                "parent_id": r.get::<_, Option<i64>>(2)?,
                "topic": r.get::<_, String>(3)?,
                "summary": r.get::<_, Option<String>>(4)?,
                "detail": r.get::<_, Option<String>>(5)?,
                "source": r.get::<_, String>(6)?,
                "source_ref": r.get::<_, Option<String>>(7)?,
                "confidence": r.get::<_, Option<f64>>(8)?,
                "verified": r.get::<_, i64>(9)?,
                "created_at": r.get::<_, String>(10)?,
            }))
        })
        .map_err(friendly)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

/// 新增一条先验知识（`source` 必填 —— 没有来源的知识点不允许入库）
#[allow(clippy::too_many_arguments)]
pub fn prior_add(
    conn: &Connection,
    course_id: i64,
    parent_id: Option<i64>,
    topic: &str,
    summary: Option<&str>,
    detail: Option<&str>,
    source: &str,
    source_ref: Option<&str>,
    confidence: Option<f64>,
) -> Result<i64, String> {
    let topic = topic.trim();
    if topic.is_empty() {
        return Err("知识点名称不能为空。".into());
    }
    let source = source.trim();
    if source.is_empty() {
        return Err("来源不能为空：每条先验知识都要标出处（如「教材 P32」「AI 生成」）。".into());
    }
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO course_prior(course_id, parent_id, topic, summary, detail, source,
                                  source_ref, confidence, verified, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)",
        rusqlite::params![
            course_id,
            parent_id,
            topic,
            summary,
            detail,
            source,
            source_ref,
            confidence,
            now
        ],
    )
    .map_err(friendly)?;
    Ok(conn.last_insert_rowid())
}

/// 先验知识 `topic` 的**字符数**上限（契约 §2.3：非空且 ≤200 字）
const PRIOR_TOPIC_MAX_CHARS: usize = 200;

/// 批量写入一棵先验知识树时，单项的**已解析草稿**
/// （字段名与前端 `PriorDraft` 逐字一致，见 `prior_add_tree` 的文档）。
struct PriorTreeDraft {
    topic: String,
    summary: Option<String>,
    detail: Option<String>,
    /// 为空 = 顶层项（落库 `parent_id = NULL`）
    parent_topic: Option<String>,
}

/// **批量写入一棵先验知识树**（顶层项 + 子项），1 次 IPC 完成父子映射
/// （与 M4 `questions_save_batch` 同一教训：避免前端 N 次 IPC —— M3 的 T20）。
///
/// `items` 元素字段用 **snake_case** 且与前端 `PriorDraft` 逐字一致：
/// `{topic, summary?, detail?, parent_topic?}`。
/// 这是契约 §2.3 **显式登记**的口径例外：`docs/01` §四.1 的 camelCase 只针对
/// **顶层命令参数**；嵌套载荷跟随"草稿结构"，让前端**零字段转换**。
///
/// 父子解析在 Rust 侧完成（不靠前端先建父再传 id）：先插 `parent_topic` 为空的
/// 顶层项并记下 `topic → id`，再插子项并按 `parent_topic` **逐字**映射到本批
/// 某个顶层项的 id；同批出现同名顶层 `topic` 时映射到**第一个**。
///
/// **整批同一事务**：任一项非法（`topic` 空 / 超 200 字、父知识点不在本批、
/// `source` 为空）→ **全部回滚**，并在错误里指出是第几项，绝不留半截知识树。
/// `source` 必填且非空（沿用 `prior_add` 红线）；`verified` 硬编码 `0`
/// （只有用户核对过才算数）。返回的 id 与 `items` **顺序一一对应**。
pub fn prior_add_tree(
    conn: &Connection,
    course_id: i64,
    items: &[Value],
    source: &str,
    source_ref: Option<&str>,
    confidence: Option<f64>,
) -> Result<Vec<i64>, String> {
    let source = source.trim();
    if source.is_empty() {
        return Err("来源不能为空：每条先验知识都要标出处（如「教材 P32」「AI 生成」）。".into());
    }
    if items.is_empty() {
        return Ok(Vec::new());
    }

    // ① 先整批解析成草稿并校验形状（**不碰库**）：字段名沿用前端 PriorDraft
    let mut drafts: Vec<PriorTreeDraft> = Vec::with_capacity(items.len());
    for (idx, item) in items.iter().enumerate() {
        let no = idx + 1;
        let obj = item.as_object().ok_or_else(|| {
            format!("第 {no} 项格式不正确：应为 {{topic, summary?, detail?, parent_topic?}} 对象。")
        })?;
        let topic = obj
            .get("topic")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if topic.is_empty() {
            return Err(format!("第 {no} 项：知识点名称不能为空。"));
        }
        let topic_len = topic.chars().count();
        if topic_len > PRIOR_TOPIC_MAX_CHARS {
            return Err(format!(
                "第 {no} 项：知识点名称过长（{topic_len} 字），最多 {PRIOR_TOPIC_MAX_CHARS} 字。"
            ));
        }
        // 空串 / null / 缺字段一律当"没有摘要/细节"，不落一堆空字符串
        let text = |key: &str| {
            obj.get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let parent_topic = text("parent_topic");
        drafts.push(PriorTreeDraft {
            topic: topic.to_string(),
            summary: text("summary"),
            detail: text("detail"),
            parent_topic,
        });
    }

    // ② 再校验父子引用：子项的 parent_topic 必须**逐字**命中本批某个**顶层** topic。
    //    父知识点必须在**本批**里（不接受"先查库找同名"——那会把不同批次串起来，
    //    也让"整批回滚"失去意义）。
    let top_topics: Vec<&str> = drafts
        .iter()
        .filter(|d| d.parent_topic.is_none())
        .map(|d| d.topic.as_str())
        .collect();
    for d in &drafts {
        if let Some(p) = d.parent_topic.as_deref() {
            if !top_topics.iter().any(|t| *t == p) {
                return Err(format!("父知识点「{p}」不在本批中"));
            }
        }
    }

    // ③ 落库：整批一个事务，两步插入（顶层 → 子项），任何一步出错都整体回滚
    let now = chrono::Local::now().to_rfc3339();
    let tx = conn.unchecked_transaction().map_err(friendly)?;

    // 单项插入（嵌套 fn：不捕获事务，避免与 `tx.commit()` 抢借用）
    #[allow(clippy::too_many_arguments)]
    fn insert_one(
        tx: &rusqlite::Transaction<'_>,
        course_id: i64,
        parent_id: Option<i64>,
        d: &PriorTreeDraft,
        source: &str,
        source_ref: Option<&str>,
        confidence: Option<f64>,
        now: &str,
    ) -> Result<i64, String> {
        tx.execute(
            "INSERT INTO course_prior(course_id, parent_id, topic, summary, detail, source,
                                      source_ref, confidence, verified, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)",
            rusqlite::params![
                course_id,
                parent_id,
                d.topic,
                d.summary,
                d.detail,
                source,
                source_ref,
                confidence,
                now
            ],
        )
        .map_err(friendly)?;
        Ok(tx.last_insert_rowid())
    }

    let mut ids: Vec<i64> = vec![0; drafts.len()];
    let mut top_id: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();
    for (idx, d) in drafts.iter().enumerate() {
        if d.parent_topic.is_some() {
            continue;
        }
        let id = insert_one(&tx, course_id, None, d, source, source_ref, confidence, &now)?;
        ids[idx] = id;
        top_id.entry(d.topic.as_str()).or_insert(id); // 同名顶层 topic 取第一个
    }
    for (idx, d) in drafts.iter().enumerate() {
        let Some(parent_topic) = d.parent_topic.as_deref() else {
            continue;
        };
        // ② 已校验过；这里只做防御（真走到说明上面的校验被改坏了，同样整体回滚）
        let parent_id = *top_id
            .get(parent_topic)
            .ok_or_else(|| format!("父知识点「{parent_topic}」不在本批中"))?;
        ids[idx] =
            insert_one(&tx, course_id, Some(parent_id), d, source, source_ref, confidence, &now)?;
    }
    tx.commit().map_err(friendly)?;
    Ok(ids)
}

/// 局部更新（topic / summary / detail）
pub fn prior_update(
    conn: &Connection,
    id: i64,
    topic: Option<&str>,
    summary: Option<&str>,
    detail: Option<&str>,
) -> Result<(), String> {
    if let Some(v) = topic {
        let v = v.trim();
        if v.is_empty() {
            return Err("知识点名称不能为空。".into());
        }
        let n = conn
            .execute(
                "UPDATE course_prior SET topic = ?1 WHERE id = ?2",
                rusqlite::params![v, id],
            )
            .map_err(friendly)?;
        ensure_affected(n, "先验知识", id)?;
    }
    if let Some(v) = summary {
        let n = conn
            .execute(
                "UPDATE course_prior SET summary = ?1 WHERE id = ?2",
                rusqlite::params![v, id],
            )
            .map_err(friendly)?;
        ensure_affected(n, "先验知识", id)?;
    }
    if let Some(v) = detail {
        let n = conn
            .execute(
                "UPDATE course_prior SET detail = ?1 WHERE id = ?2",
                rusqlite::params![v, id],
            )
            .map_err(friendly)?;
        ensure_affected(n, "先验知识", id)?;
    }
    Ok(())
}

/// 标记「用户已核对」（verified 只由用户确认，不由系统自证）
pub fn prior_verify(conn: &Connection, id: i64, verified: bool) -> Result<(), String> {
    let n = conn
        .execute(
            "UPDATE course_prior SET verified = ?1 WHERE id = ?2",
            rusqlite::params![flag(verified), id],
        )
        .map_err(friendly)?;
    ensure_affected(n, "先验知识", id)
}

/// 删除一条先验知识（连同其子节点，避免留下孤儿挂在树上）
pub fn prior_delete(conn: &Connection, id: i64) -> Result<(), String> {
    let n = conn
        .execute(
            "WITH RECURSIVE sub(id) AS (
                 SELECT id FROM course_prior WHERE id = ?1
                 UNION ALL
                 SELECT p.id FROM course_prior p JOIN sub ON p.parent_id = sub.id
             )
             DELETE FROM course_prior WHERE id IN (SELECT id FROM sub)",
            [id],
        )
        .map_err(friendly)?;
    ensure_affected(n, "先验知识", id)
}

// ---------------------------------------------------------------------------
// 材料（materials + material_chunks）
// ---------------------------------------------------------------------------

/// 某课程的材料列表（不含正文；正文在切块表里）
pub fn materials_list(conn: &Connection, course_id: i64) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.course_id, m.file_name, m.file_path, m.kind, m.size_bytes,
                    m.extracted_by, m.text_len, m.truncated, m.note, m.created_at,
                    (SELECT COUNT(*) FROM material_chunks c WHERE c.material_id = m.id)
             FROM materials m WHERE m.course_id = ?1
             ORDER BY m.id DESC",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map([course_id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "course_id": r.get::<_, i64>(1)?,
                "file_name": r.get::<_, String>(2)?,
                "file_path": r.get::<_, String>(3)?,
                "kind": r.get::<_, Option<String>>(4)?,
                "size_bytes": r.get::<_, Option<i64>>(5)?,
                "extracted_by": r.get::<_, Option<String>>(6)?,
                "text_len": r.get::<_, Option<i64>>(7)?,
                "truncated": r.get::<_, i64>(8)?,
                "note": r.get::<_, Option<String>>(9)?,
                "created_at": r.get::<_, String>(10)?,
                "chunk_count": r.get::<_, i64>(11)?,
            }))
        })
        .map_err(friendly)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

/// 新增材料：写 materials 行 + 把 `text` 切块写入 material_chunks（FTS 触发器自动同步）。
/// 返回新材料 id。文本为空也允许入库（例如 pdf / 图片暂时提不出文本），
/// 此时 note 负责向用户说明原因。
#[allow(clippy::too_many_arguments)]
pub fn material_add(
    conn: &Connection,
    course_id: i64,
    file_name: &str,
    file_path: &str,
    kind: &str,
    size_bytes: Option<i64>,
    extracted_by: &str,
    text: &str,
    blocks: Option<i64>,
    truncated: Option<bool>,
    note: Option<&str>,
) -> Result<i64, String> {
    let file_name = file_name.trim();
    if file_name.is_empty() {
        return Err("材料文件名不能为空。".into());
    }
    let text_len = text.chars().count() as i64;
    if text.trim().is_empty() && blocks.unwrap_or(0) > 0 {
        // 解析器声称有内容却拿不到文本：记录以便排查，但不阻断入库
        eprintln!("[materials] 「{file_name}」解析出 {blocks:?} 块但文本为空，未写入切块");
    }

    let now = chrono::Local::now().to_rfc3339();
    let tx = conn.unchecked_transaction().map_err(friendly)?;
    tx.execute(
        "INSERT INTO materials(course_id, file_name, file_path, kind, size_bytes, extracted_by,
                               text_len, truncated, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            course_id,
            file_name,
            file_path,
            kind,
            size_bytes,
            extracted_by,
            text_len,
            flag(truncated.unwrap_or(false)),
            note,
            now
        ],
    )
    .map_err(friendly)?;
    let material_id = tx.last_insert_rowid();

    for (seq, (heading, content)) in chunk_text(text).into_iter().enumerate() {
        tx.execute(
            "INSERT INTO material_chunks(material_id, course_id, seq, page, heading, content, tokens)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5, NULL)",
            rusqlite::params![material_id, course_id, seq as i64, heading, content],
        )
        .map_err(friendly)?;
    }
    tx.commit().map_err(friendly)?;
    Ok(material_id)
}

/// 删除材料（切块随外键级联 + FTS 触发器同步删除）
pub fn material_delete(conn: &Connection, id: i64) -> Result<(), String> {
    let n = conn
        .execute("DELETE FROM materials WHERE id = ?1", [id])
        .map_err(friendly)?;
    ensure_affected(n, "材料", id)
}

/// 某课程全部材料正文（按材料 + 块序拼接，带材料标题，供喂给模型时溯源）
pub fn material_text_all(conn: &Connection, course_id: i64) -> Result<String, String> {
    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.file_name, m.note, m.extracted_by, c.content
             FROM materials m
             JOIN material_chunks c ON c.material_id = m.id
             WHERE m.course_id = ?1
             ORDER BY m.id, c.seq",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map([course_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(friendly)?;

    let mut out = String::new();
    let mut current = 0i64;
    for row in rows {
        let (mid, file_name, note, extracted_by, content) = row.map_err(friendly)?;
        if mid != current {
            current = mid;
            out.push_str(&format!(
                "\n【材料：{file_name}（{}）】\n",
                extracted_by.as_deref().unwrap_or("未标注提取方式")
            ));
            if let Some(n) = note {
                out.push_str(&format!("（{n}）\n"));
            }
        }
        out.push_str(&content);
        out.push('\n');
    }
    Ok(out.trim_start_matches('\n').to_string())
}

/// 把整篇文本切成检索块：按行累积，达到目标长度即结算；
/// 遇到 Markdown 标题行则换块并记住标题（拿不到标题就是 None —— 不编造标题）。
/// 返回 (标题路径, 块内容)。
pub fn chunk_text(text: &str) -> Vec<(Option<String>, String)> {
    let mut out: Vec<(Option<String>, String)> = Vec::new();
    let mut heading: Option<String> = None;
    let mut buf = String::new();

    for raw in text.lines() {
        let line = raw.trim_end();
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix('#') {
            let title = rest.trim_start_matches('#').trim();
            if !title.is_empty() {
                flush_chunk(&mut out, &mut buf, &heading);
                heading = Some(title.to_string());
                continue;
            }
        }
        if trimmed.is_empty() {
            // 段落分隔：够长就结算，否则保留一个换行让块内可读
            if buf.chars().count() >= CHUNK_TARGET {
                flush_chunk(&mut out, &mut buf, &heading);
            } else if !buf.is_empty() {
                buf.push('\n');
            }
            continue;
        }
        buf.push_str(line);
        buf.push('\n');
        if buf.chars().count() >= CHUNK_TARGET {
            flush_chunk(&mut out, &mut buf, &heading);
        }
    }
    flush_chunk(&mut out, &mut buf, &heading);
    out
}

fn flush_chunk(out: &mut Vec<(Option<String>, String)>, buf: &mut String, heading: &Option<String>) {
    let content = buf.trim().to_string();
    buf.clear();
    if content.is_empty() {
        return;
    }
    // 单块仍超上限（例如整篇没有换行的长文）：按字符边界硬切
    let mut rest = content;
    while rest.chars().count() > CHUNK_MAX {
        let head: String = rest.chars().take(CHUNK_MAX).collect();
        rest = rest.chars().skip(CHUNK_MAX).collect();
        out.push((heading.clone(), head));
    }
    if !rest.is_empty() {
        out.push((heading.clone(), rest));
    }
}

// ---------------------------------------------------------------------------
// 材料检索（M1）：FTS5 优先 + LIKE 兜底
// ---------------------------------------------------------------------------

/// 检索默认条数 / 上限（契约 §2.1：默认 8，上限 50）
const SEARCH_LIMIT_DEFAULT: i64 = 8;
const SEARCH_LIMIT_MAX: i64 = 50;

/// 片段裁切窗口：以命中关键词为中心**各取 100 字**（约 200 字）
const SNIPPET_HALF: usize = 100;

/// 一次查询最多使用的词数（契约 §4.1，防止超长查询把 SQL 撑爆）
const SEARCH_TERMS_MAX: usize = 8;

/// 词的最小字符数（1 字词没有检索价值，只会引入噪声）
const SEARCH_TERM_MIN_CHARS: usize = 2;

/// FTS5 路径的词最小字符数（trigram 分词器对 < 3 字无法命中，只能交给 LIKE）
const SEARCH_FTS_MIN_CHARS: usize = 3;

/// 查询分词的**分隔符集合**：与 `ball.rs::pick_keyword` 逐字保持一致
/// （中英文标点 + 各类空白），否则球推来的选段与对话页手输的查询会走不同的词。
fn is_term_sep(c: char) -> bool {
    matches!(
        c,
        '，' | '。'
            | '；'
            | '：'
            | '！'
            | '？'
            | '、'
            | ','
            | '.'
            | ';'
            | ':'
            | '!'
            | '?'
            | '\n'
            | '\r'
            | '\t'
            | ' '
            | '（'
            | '）'
            | '('
            | ')'
            | '《'
            | '》'
            | '“'
            | '”'
            | '"'
            | '\''
    )
}

/// 把一条查询切成**用于 OR 召回**的词列表（契约 §4.1）。
///
/// - 按 `is_term_sep`（空白 + 中英文标点）切分；
/// - 去首尾空白、去空、**去重（大小写不敏感，保留首次出现的写法）**；
/// - 只保留**字符数 ≥ 2** 的词（按**字符**而非字节，中文才不会被误杀）；
/// - **最多前 8 个**。
///
/// 返回的列表既用于 FTS（再筛 ≥3 字）也用于 LIKE（全部词），并原样作为 `terms` 回传前端做高亮。
fn split_terms(query: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for seg in query.split(is_term_sep) {
        let t = seg.trim();
        if t.chars().count() < SEARCH_TERM_MIN_CHARS {
            continue;
        }
        // 大小写不敏感去重（用 to_lowercase 而不是 eq_ignore_ascii_case：
        // 非 ASCII 字母同样要能折叠，中文本身不受影响）
        let lower = t.to_lowercase();
        if out.iter().any(|e| e.to_lowercase() == lower) {
            continue;
        }
        out.push(t.to_string());
        if out.len() >= SEARCH_TERMS_MAX {
            break;
        }
    }
    out
}

/// 在已导入材料的切块里按**多关键词 OR 召回**，**按相关度降序**返回。
///
/// 三条策略（M2 契约 §4.1，建立在 M1 §2.1 之上）：
///   1. **FTS5 优先**：`chunks_fts`（trigram 分词）用 BM25 打分；**只用 ≥3 字的词**，
///      拼成 `"w1" OR "w2"`。`course_id` 为 `Some` 时按 `material_chunks.course_id` 过滤。
///   2. **必须保留 LIKE 兜底**：trigram 分词器对 **< 3 字**的词无法命中（中文两字词极常见）；
///      且 FTS 语句异常 / 索引不可用时**不得报错**，静默回退 `LIKE '%w%'`（对 content 与
///      heading）—— 兜底走**全部词**（含 2 字词），score 给固定值 0。
///   3. **FTS 命中 0 → LIKE 兜底**（M1 行为不变）。
///
/// **单关键词查询的行为与 M1 完全一致**（回归项）：FTS 命中就返回、score 降序、2 字词走 LIKE。
/// 空查询（切不出任何 ≥2 字的词）直接返回 `[]`，**不返回全量**。
pub fn material_search(
    conn: &Connection,
    course_id: Option<i64>,
    query: &str,
    limit: Option<i64>,
) -> Result<Vec<Value>, String> {
    let terms = split_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    // 契约：limit 默认 8、上限 50；小于 1 按 1
    let limit = limit.unwrap_or(SEARCH_LIMIT_DEFAULT).clamp(1, SEARCH_LIMIT_MAX);

    // ① FTS5 优先（只在有 ≥3 字词时才值得试）。任何异常（MATCH 语法 / 索引缺失 /
    //    FTS5 不可用）都静默吞掉并回退，绝不把错误抛给调用方
    //    —— 检索是「有则更好，没有也不能炸」的旁路能力。
    let mut rows = if terms.iter().any(|t| t.chars().count() >= SEARCH_FTS_MIN_CHARS) {
        match search_fts(conn, course_id, &terms, limit) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[search] FTS 检索不可用，回退 LIKE：{e}");
                Vec::new()
            }
        }
    } else {
        // 全是 2 字词：trigram 必然命不中，直接走兜底（省一次必然失败的查询）
        Vec::new()
    };
    // ② 补齐：**只要 FTS 没占满 limit，就用 LIKE 补齐它覆盖不到的块**。
    //
    //    ⚠ 不能只在「FTS 0 命中」时才走 LIKE：多词查询里词长常常不一，
    //    而中文 2 字词极常见（极限 / 导数 / 矩阵 / 概率 …），trigram 的 FTS
    //    只会拿 ≥3 字的词去查 —— 于是「只命中 2 字词」的块会被静默丢掉。
    //    这是**召回漏洞**（用户明明有相关材料却检不到），不是可选优化。
    //
    //    合并顺序：FTS 命中按相关度在前，LIKE 补上的块按 material_id/seq 追加在后；
    //    按 chunk_id 去重，最后截断到 limit。
    if rows.len() < limit as usize {
        let mut seen: std::collections::HashSet<i64> = rows
            .iter()
            .filter_map(|r| r.get("chunk_id").and_then(|v| v.as_i64()))
            .collect();
        for r in search_like(conn, course_id, &terms, limit)? {
            if rows.len() >= limit as usize {
                break;
            }
            // 已由 FTS 返回过的块不重复追加（seen.insert 返回 false 表示已存在）
            match r.get("chunk_id").and_then(|v| v.as_i64()) {
                Some(id) if !seen.insert(id) => continue,
                _ => {}
            }
            rows.push(r);
        }
    }
    Ok(rows)
}

/// FTS5 路径：`MATCH` + BM25 排序。
///
/// **必须给每个词套双引号**：词里可能带 `-` `*` `"` `(` 等 FTS5 语法字符，
/// 裸拼进 `MATCH` 会直接语法错误（契约 §4.1；引号内的 `"` 按 FTS5 规则双写成 `""`）。
/// 词表里 < 3 字的词由调用方过滤后仍在本函数内再筛一遍（防御性），全被筛掉时返回空。
///
/// **score 方向归一化**：SQLite 的 `bm25()` 是「数值越小越相关」（返回负数，越相关越负），
/// 而契约要求调用方看到的是「越大越相关」，故在这里**取负号** `score = -bm25(...)`；
/// 排序相应用 `bm25() ASC`（等价于 score 降序），避免调用方误读方向。
fn search_fts(
    conn: &Connection,
    course_id: Option<i64>,
    terms: &[String],
    limit: i64,
) -> Result<Vec<Value>, String> {
    let match_expr = terms
        .iter()
        .filter(|t| t.chars().count() >= SEARCH_FTS_MIN_CHARS)
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ");
    if match_expr.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.material_id, m.file_name, m.kind, c.seq, c.page, c.heading, c.content,
                    bm25(chunks_fts) AS bm
             FROM chunks_fts
             JOIN material_chunks c ON c.id = chunks_fts.rowid
             JOIN materials m ON m.id = c.material_id
             WHERE chunks_fts MATCH ?1
               AND (?2 IS NULL OR c.course_id = ?2)
             ORDER BY bm ASC
             LIMIT ?3",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map(rusqlite::params![match_expr, course_id, limit], |r| {
            let bm: f64 = r.get::<_, f64>(8)?;
            build_hit(r, terms, -bm)
        })
        .map_err(friendly)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

/// LIKE 路径（兜底）：对**全部词**（含 2 字词）OR 连接，每个词同时匹配 `content` 与 `heading`，
/// `score` 固定 0，按 `material_id, seq` 稳定排序（与 FTS 的「相关度」不同，这里只保证可预期）。
///
/// 占位符按词数动态生成（?1..?n），`escape_like` 保证 `%` `_` `\` 按**字面**匹配。
fn search_like(
    conn: &Connection,
    course_id: Option<i64>,
    terms: &[String],
    limit: i64,
) -> Result<Vec<Value>, String> {
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let n = terms.len();
    let mut sql = String::from(
        "SELECT c.id, c.material_id, m.file_name, m.kind, c.seq, c.page, c.heading, c.content
         FROM material_chunks c
         JOIN materials m ON m.id = c.material_id
         WHERE (",
    );
    for i in 1..=n {
        if i > 1 {
            sql.push_str(" OR ");
        }
        sql.push_str(&format!(
            "(c.content LIKE ?{i} ESCAPE '\\' OR IFNULL(c.heading, '') LIKE ?{i} ESCAPE '\\')"
        ));
    }
    sql.push_str(&format!(
        ") AND (?{} IS NULL OR c.course_id = ?{}) ORDER BY c.material_id, c.seq LIMIT ?{}",
        n + 1,
        n + 1,
        n + 2
    ));

    let mut args: Vec<rusqlite::types::Value> = terms
        .iter()
        .map(|t| rusqlite::types::Value::Text(format!("%{}%", escape_like(t))))
        .collect();
    args.push(match course_id {
        Some(cid) => rusqlite::types::Value::Integer(cid),
        None => rusqlite::types::Value::Null,
    });
    args.push(rusqlite::types::Value::Integer(limit));

    let mut stmt = conn.prepare(&sql).map_err(friendly)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), |r| {
            build_hit(r, terms, 0.0)
        })
        .map_err(friendly)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

/// 把一行原料拼成契约 §2.1 的返回行（字段名**一律 snake_case**，与列名逐字一致）。
/// M2 只**新增** `terms`（本次实际使用的词列表，前端拿它做命中高亮），
/// 其余 9 个字段名与类型一字不动。
fn build_hit(r: &rusqlite::Row<'_>, terms: &[String], score: f64) -> rusqlite::Result<Value> {
    let content: String = r.get::<_, String>(7)?;
    Ok(json!({
        "chunk_id": r.get::<_, i64>(0)?,
        "material_id": r.get::<_, i64>(1)?,
        "material": r.get::<_, String>(2)?,
        "kind": r.get::<_, Option<String>>(3)?,
        "seq": r.get::<_, i64>(4)?,
        "page": r.get::<_, Option<i64>>(5)?,
        "heading": r.get::<_, Option<String>>(6)?,
        "snippet": snippet_around(&content, terms),
        "score": score,
        "terms": terms,
    }))
}

/// LIKE 通配符转义：查询里的 `%` `_` `\` 按**字面**匹配，不当成通配符。
/// （否则搜 `100%` 会命中任何以 `100` 开头的内容，属于悄悄错结果。）
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for ch in s.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// 片段裁切：在**任一关键词最早出现处**为中心**各取 ±100 字**；一个词都没命中就取前 200 字。
/// 全程按**字符**定位、再换算回字节边界，因此绝不会切断 UTF-8（做法同 office.rs 的 truncate_chars）。
/// 刻意不用 SQLite 的 `snippet()`：它的省略号/标记口径不可控，自己裁更稳。
/// 大小写不敏感地在 `hay` 里找 `needle` **最早的字符下标**（找不到返回 `None`）。
///
/// 为什么不能直接用 `str::find`：FTS5 的匹配是**大小写不敏感**的，
/// 若这里用大小写敏感的 `find`，查询 `CNN` 命中 `cnn` 时会定位失败，
/// snippet 退化成"前 200 字"窗口 —— 用户看到的片段里根本没有命中词，高亮也无从下手。
///
/// 只做 ASCII 大小写折叠（`char::eq_ignore_ascii_case`）：中文不受影响，
/// 也避免 `to_lowercase()` 改变字符数导致下标错位。
fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let hay_chars: Vec<char> = hay.chars().collect();
    let needle_chars: Vec<char> = needle.chars().collect();
    let n = needle_chars.len();
    if hay_chars.len() < n {
        return None;
    }
    for i in 0..=(hay_chars.len() - n) {
        if hay_chars[i..i + n]
            .iter()
            .zip(needle_chars.iter())
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
        {
            return Some(i);
        }
    }
    None
}

fn snippet_around(content: &str, terms: &[String]) -> String {
    let total = content.chars().count();
    // 找出「最早出现」的那个词（按字符下标比较；都没出现就是 None）
    let mut earliest: Option<(usize, usize)> = None; // (字符下标, 词长)
    for t in terms {
        if t.is_empty() {
            continue;
        }
        if let Some(i) = find_ci(content, t) {
            // find_ci 直接返回**字符**下标，无需再做字节→字符换算
            let len = t.chars().count();
            if earliest.map_or(true, |(ei, _)| i < ei) {
                earliest = Some((i, len));
            }
        }
    }
    let (start, end) = match earliest {
        Some((i, len)) => (
            i.saturating_sub(SNIPPET_HALF),
            (i + len + SNIPPET_HALF).min(total),
        ),
        None => (0, total.min(SNIPPET_HALF * 2)),
    };
    let sb = char_byte_index(content, start);
    let eb = char_byte_index(content, end);
    let mut out = String::with_capacity(eb - sb + 6);
    if start > 0 {
        out.push('…');
    }
    out.push_str(&content[sb..eb]);
    if end < total {
        out.push('…');
    }
    out
}

/// 第 nth 个字符的字节下标；越界时返回字符串长度。
/// 保证切片端点落在**字符边界**上（否则 `&s[..]` 会 panic）。
fn char_byte_index(s: &str, nth: usize) -> usize {
    s.char_indices().nth(nth).map(|(i, _)| i).unwrap_or(s.len())
}

// ---------------------------------------------------------------------------
// 会话（chat_sessions + chat_messages）
// ---------------------------------------------------------------------------

/// 一条 AI 对话消息（与前端 ChatMsg 对应）。
/// `refs` / `source_kind` 用 Value 接收：前端可能传字符串，也可能传引用数组，
/// 都能落库，不会因为形状不一致把整段对话存坏。
/// `images`（R4）：本轮提问携带的图片，**dataURL 字符串数组**（`data:image/jpeg;base64,…`）。
#[derive(Debug, serde::Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
    #[serde(default, alias = "sourceKind")]
    pub source_kind: Option<Value>,
    #[serde(default)]
    pub refs: Option<Value>,
    #[serde(default)]
    pub images: Option<Value>,
}

/// 单条消息里图片（JSON 序列化后）的硬上限，**6 MB**。
///
/// 为什么必须有：图片是 dataURL（base64 比原图大约 1/3），一张未压缩的手机截图动辄 2–4 MB，
/// 若不在写入侧兜住，单条消息就能把本机数据库撑到不可用。前端另有一道更严的提示（>3 MB 直接
/// 拒绝并让用户重截），这里的硬上限是**最后一道防线**：只保证库不被写坏，不管体验。
const CHAT_IMAGES_MAX_BYTES: usize = 6 * 1024 * 1024;

/// 把前端传来的 `images` 规范化成**待落库的 JSON 文本**（无图 / 非法形状 → `None`）。
///
/// 接受的形状：`["data:image/png;base64,…", …]`（字符串数组）。
/// 非字符串元素、非数组一律按"没有图片"处理 —— 宁可少存图，也不因为一个坏元素
/// 让整段对话保存失败（对话落库是主链路，不能图片格式问题连坐）。
fn images_text(v: &Option<Value>) -> Result<Option<String>, String> {
    let Some(v) = v else { return Ok(None) };
    let Value::Array(items) = v else { return Ok(None) };
    let list: Vec<&str> = items
        .iter()
        .filter_map(|it| match it {
            Value::String(s) if !s.trim().is_empty() => Some(s.as_str()),
            _ => None,
        })
        .collect();
    if list.is_empty() {
        return Ok(None);
    }
    let text = serde_json::to_string(&list).map_err(|e| format!("图片序列化失败：{e}"))?;
    if text.len() > CHAT_IMAGES_MAX_BYTES {
        return Err(format!(
            "这条消息的图片太大了（{:.1} MB，上限 {:.0} MB）：请重新截小一点，或先压缩再粘贴。",
            text.len() as f64 / 1024.0 / 1024.0,
            CHAT_IMAGES_MAX_BYTES as f64 / 1024.0 / 1024.0
        ));
    }
    Ok(Some(text))
}

/// 库里存的 images JSON 文本 → **解析后的数组**（给前端直接用；解析失败按"没有图片"）。
///
/// 与 `refs` 的取舍不同：`refs` 原样回传字符串由前端解析，而 images 直接回数组 ——
/// 前端要用它渲染 `<img src>`，回数组可以少一处解析、也少一处解析失败的可能。
fn images_value(stored: Option<String>) -> Value {
    match stored {
        Some(s) if !s.trim().is_empty() => serde_json::from_str::<Value>(&s).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// Value → 存库文本（字符串原样，null → NULL，其它形状序列化为 JSON 文本）
fn json_text(v: &Option<Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    }
}

/// 会话列表（含消息数）。`course_id` 为空则返回全部会话。
pub fn chat_sessions_list(conn: &Connection, course_id: Option<i64>) -> Result<Vec<Value>, String> {
    fn row_to_json(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "course_id": r.get::<_, Option<i64>>(1)?,
            "title": r.get::<_, String>(2)?,
            "summary": r.get::<_, Option<String>>(3)?,
            "created_at": r.get::<_, String>(4)?,
            "updated_at": r.get::<_, Option<String>>(5)?,
            "message_count": r.get::<_, i64>(6)?,
        }))
    }

    let filter = if course_id.is_some() {
        " WHERE s.course_id = ?1"
    } else {
        ""
    };
    let sql = format!(
        "SELECT s.id, s.course_id, s.title, s.summary, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id)
         FROM chat_sessions s{filter}
         ORDER BY COALESCE(s.updated_at, s.created_at) DESC, s.id DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(friendly)?;
    let rows = match course_id {
        Some(cid) => stmt.query_map([cid], row_to_json).map_err(friendly)?,
        None => stmt.query_map([], row_to_json).map_err(friendly)?,
    };
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

/// 新建会话，返回 id
pub fn chat_session_create(
    conn: &Connection,
    course_id: Option<i64>,
    title: &str,
) -> Result<i64, String> {
    let title = title.trim();
    let title = if title.is_empty() { "新对话" } else { title };
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO chat_sessions(course_id, title, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)",
        rusqlite::params![course_id, title, now],
    )
    .map_err(friendly)?;
    Ok(conn.last_insert_rowid())
}

/// 修改会话归属课程（`course_id = None` → 写 `NULL`，即**不限定课程**）。
///
/// **不动 `updated_at`**：该字段语义是"最后消息时间"（`chat_sessions_list` 按它倒序
/// 排序，见本文件同名函数）；改归属**不是消息事件**，跟着刷新会让会话凭空跳到
/// 列表最前面、还会让笔记按日期收集的素材顺序错乱。
///
/// 幂等：重复设同一值无额外副作用（UPDATE 影响 0 行也算成功）。
/// 校验：会话必须存在；`course_id` 非空时课程必须存在。
pub fn chat_session_set_course(
    conn: &Connection,
    id: i64,
    course_id: Option<i64>,
) -> Result<(), String> {
    // 先查会话存在性：否则 UPDATE 影响 0 行时无法区分"会话不存在"与"设成原值"（幂等）
    let session_exists = conn
        .query_row("SELECT 1 FROM chat_sessions WHERE id = ?1", [id], |_| {
            Ok(())
        })
        .optional()
        .map_err(friendly)?
        .is_some();
    if !session_exists {
        return Err(format!("会话不存在（id={id}）"));
    }
    if let Some(cid) = course_id {
        let course_exists = conn
            .query_row("SELECT 1 FROM courses WHERE id = ?1", [cid], |_| Ok(()))
            .optional()
            .map_err(friendly)?
            .is_some();
        if !course_exists {
            return Err(format!("课程不存在（id={cid}），请先在「课程」页创建。"));
        }
    }
    conn.execute(
        "UPDATE chat_sessions SET course_id = ?1 WHERE id = ?2",
        rusqlite::params![course_id, id],
    )
    .map_err(friendly)?;
    Ok(())
}

/// 重命名会话
pub fn chat_session_rename(conn: &Connection, id: i64, title: &str) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("会话标题不能为空。".into());
    }
    let now = chrono::Local::now().to_rfc3339();
    let n = conn
        .execute(
            "UPDATE chat_sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![title, now, id],
        )
        .map_err(friendly)?;
    ensure_affected(n, "会话", id)
}

/// 删除会话（其消息随外键级联；这里再显式删一次，兼容外键被关闭的老库）
pub fn chat_session_delete(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM chat_messages WHERE session_id = ?1", [id])
        .map_err(friendly)?;
    let n = conn
        .execute("DELETE FROM chat_sessions WHERE id = ?1", [id])
        .map_err(friendly)?;
    ensure_affected(n, "会话", id)
}

/// 读取会话全部消息（按写入顺序）
pub fn chat_history_load(conn: &Connection, session_id: i64) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT role, content, refs, source_kind, created_at, images
             FROM chat_messages WHERE session_id = ?1 ORDER BY id",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map([session_id], |r| {
            Ok(json!({
                "role": r.get::<_, String>(0)?,
                "content": r.get::<_, String>(1)?,
                "refs": r.get::<_, Option<String>>(2)?,
                "source_kind": r.get::<_, Option<String>>(3)?,
                "created_at": r.get::<_, String>(4)?,
                // R4：图片直接回**数组**（None/旧库为 NULL → null），前端拿去渲染 <img src>
                "images": images_value(r.get::<_, Option<String>>(5)?),
            }))
        })
        .map_err(friendly)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

/// 该课程问答素材的**返回条数**默认值与上限（契约 §2.2：默认 2000、上限 5000）
const CHAT_COURSE_MSG_LIMIT_DEFAULT: i64 = 2000;
const CHAT_COURSE_MSG_LIMIT_MAX: i64 = 5000;

/// 一次取回**该课程**的问答素材（供「从本课对话提炼先验知识」与笔记收集复用）。
///
/// 存在的理由是**减少 IPC**：提炼先验知识只要 1 次调用即可拿全
/// （顺手关掉 M3 留下的 T20「收集当天消息是 1+N 次 IPC」）。
///
/// 口径（契约 §2.2，逐条落地）：
///   · **只返回** `role != 'system'` 且 `content` 非空（trim 后非空）的消息；
///   · 排序 `ORDER BY m.created_at, m.id` **升序**（同一次保存的消息 `created_at` 相同，
///     靠 `id` 定序，与 `chat_history_load` 的写入顺序一致）；
///   · `since`（`YYYY-MM-DD`，**含当日**）按 `substr(created_at,1,10) >= since` 过滤，
///     空串/纯空白当"没传"；
///   · `limit` **默认 2000、上限 5000**（小于 1 按 1），且**取最近的**：先按
///     `created_at DESC, id DESC` 截断、再翻正序 —— 否则长会话会把最新内容截掉；
///   · `message_count` = 本次**实际返回**的条数，`available_count` = 满足 `since`
///     条件的**总**条数（未截断前的），`truncated = message_count < available_count`；
///   · `session_count` = 该课程会话总数（**含无消息的**）；`session_count_with_messages`
///     与 `available_count` **同口径**（都按 `since` 过滤后的可选消息统计），
///     因此 `available_count == 0` 时它必然也为 0，两个数字不会互相打架；
///   · 无会话 → `session_count: 0`、`messages: []`（**不返回 null**）。
pub fn chat_course_messages(
    conn: &Connection,
    course_id: i64,
    since: Option<&str>,
    limit: Option<i64>,
) -> Result<Value, String> {
    let limit = limit
        .unwrap_or(CHAT_COURSE_MSG_LIMIT_DEFAULT)
        .clamp(1, CHAT_COURSE_MSG_LIMIT_MAX);
    // 空串 / 纯空白当"没传"（避免 `substr(...) >= ''` 恒真这种"看着过滤了其实没过滤"）
    let since = since.map(str::trim).filter(|s| !s.is_empty());

    // 可选消息的公共条件：非 system 且内容非空（空白串不算内容，否则提炼提示词里
    // 会出现一堆空条目）。三处计数与取数必须**共用同一条件**，否则数字对不上。
    const PICKABLE: &str = "m.role <> 'system' AND TRIM(m.content) <> '' \
                            AND (?2 IS NULL OR substr(m.created_at, 1, 10) >= ?2)";

    let session_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM chat_sessions WHERE course_id = ?1",
            [course_id],
            |r| r.get(0),
        )
        .map_err(friendly)?;

    let available_count: i64 = conn
        .query_row(
            &format!(
                "SELECT COUNT(*)
                 FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
                 WHERE s.course_id = ?1 AND {PICKABLE}"
            ),
            rusqlite::params![course_id, since],
            |r| r.get(0),
        )
        .map_err(friendly)?;

    let session_count_with_messages: i64 = conn
        .query_row(
            &format!(
                "SELECT COUNT(DISTINCT m.session_id)
                 FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
                 WHERE s.course_id = ?1 AND {PICKABLE}"
            ),
            rusqlite::params![course_id, since],
            |r| r.get(0),
        )
        .map_err(friendly)?;

    // 先倒序取最近的 `limit` 条，再翻成正序（契约 §2.2）
    let mut messages: Vec<Value> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT m.session_id, s.title, m.role, m.content, m.created_at
                 FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
                 WHERE s.course_id = ?1 AND {PICKABLE}
                 ORDER BY m.created_at DESC, m.id DESC
                 LIMIT ?3"
            ))
            .map_err(friendly)?;
        let rows = stmt
            .query_map(rusqlite::params![course_id, since, limit], |r| {
                Ok(json!({
                    "session_id": r.get::<_, i64>(0)?,
                    "session_title": r.get::<_, String>(1)?,
                    "role": r.get::<_, String>(2)?,
                    "content": r.get::<_, String>(3)?,
                    "created_at": r.get::<_, String>(4)?,
                }))
            })
            .map_err(friendly)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(friendly)?
    };
    messages.reverse();

    let message_count = messages.len() as i64;
    Ok(json!({
        "session_count": session_count,
        "session_count_with_messages": session_count_with_messages,
        "message_count": message_count,
        "available_count": available_count,
        "truncated": message_count < available_count,
        "messages": messages,
    }))
}

/// 整体保存会话（先清空再写入，保证与前端状态一致），并刷新 updated_at
pub fn chat_history_save(
    conn: &Connection,
    session_id: i64,
    messages: &[ChatMsg],
) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM chat_sessions WHERE id = ?1",
            [session_id],
            |_| Ok(()),
        )
        .is_ok();
    if !exists {
        return Err(format!(
            "会话不存在（id={session_id}），可能已被删除；请新建对话后重试。"
        ));
    }

    let now = chrono::Local::now().to_rfc3339();
    // 图片先整体校验（超限直接整条拒绝，给出可读中文错误），再进事务 ——
    // 不要在事务里才发现某条超限，那样前半截已经写进去了。
    let images_cols: Vec<Option<String>> = messages
        .iter()
        .map(|m| images_text(&m.images))
        .collect::<Result<Vec<_>, _>>()?;

    let tx = conn.unchecked_transaction().map_err(friendly)?;
    tx.execute("DELETE FROM chat_messages WHERE session_id = ?1", [session_id])
        .map_err(friendly)?;
    for (m, images) in messages.iter().zip(images_cols.iter()) {
        tx.execute(
            "INSERT INTO chat_messages(session_id, role, content, refs, source_kind, created_at, images)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                session_id,
                m.role,
                m.content,
                json_text(&m.refs),
                json_text(&m.source_kind),
                now,
                images
            ],
        )
        .map_err(friendly)?;
    }
    tx.execute(
        "UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, session_id],
    )
    .map_err(friendly)?;
    tx.commit().map_err(friendly)
}

/// 悬浮球问答落库（R4；关闭 `docs/11` §六 登记的缺口 G4）。
///
/// **为什么放在 Rust 而不是前端挂 `onBallPush`**：球面板是**独立 Electron 应用**，
/// 它的问答不该依赖"主程序里正好有某个页面打开着"。这里由桥接轮询线程直接写库，
/// 再把结果 emit 给前端做刷新 —— 关掉主程序界面也不会丢问答（比原计划的方案更稳）。
///
/// 口径：
///   · `course_id` 指定时，用该课程**最近更新**的会话；没有就新建一个（标题「悬浮球问答」）；
///   · `course_id` 指向的课程**不存在**时，退化为「不限定课程」并打日志 ——
///     不因为一个失效的课程 id 把这次问答整条丢掉（用户的问题已经问完了，答案就在手里）；
///   · 写入 `user`（问题 + 图片）与 `assistant`（回答）两条，`source_kind` 固定 `ball_ask` 以便溯源。
///
/// 返回落库所用的 `session_id`（供调用方 emit 给前端定位会话）。
pub fn ball_append_qa(
    conn: &Connection,
    course_id: Option<i64>,
    question: &str,
    answer: &str,
    images: &[String],
) -> Result<i64, String> {
    // 课程不存在 → 退化为「不限定课程」（见上：不能丢问答）
    let course_id = match course_id {
        Some(cid) => {
            let ok: bool = conn
                .query_row("SELECT 1 FROM courses WHERE id = ?1", [cid], |_| Ok(()))
                .is_ok();
            if ok {
                Some(cid)
            } else {
                eprintln!("[ball] 课程 id={cid} 不存在，本次问答按「不限定课程」落库");
                None
            }
        }
        None => None,
    };

    let latest: Option<i64> = match course_id {
        Some(cid) => conn
            .query_row(
                "SELECT id FROM chat_sessions WHERE course_id = ?1
                 ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT 1",
                [cid],
                |r| r.get(0),
            )
            .optional()
            .map_err(friendly)?,
        None => conn
            .query_row(
                "SELECT id FROM chat_sessions WHERE course_id IS NULL
                 ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(friendly)?,
    };

    let now = chrono::Local::now().to_rfc3339();
    // 与 chat_history_save 共用同一道图片上限（超限给出可读中文错误）
    let images_json = images_text(&Some(json!(images)))?;

    let tx = conn.unchecked_transaction().map_err(friendly)?;
    let sid = match latest {
        Some(id) => id,
        None => {
            tx.execute(
                "INSERT INTO chat_sessions(course_id, title, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?3)",
                rusqlite::params![course_id, "悬浮球问答", now],
            )
            .map_err(friendly)?;
            tx.last_insert_rowid()
        }
    };
    tx.execute(
        "INSERT INTO chat_messages(session_id, role, content, refs, source_kind, created_at, images)
         VALUES (?1, 'user', ?2, NULL, 'ball_ask', ?3, ?4)",
        rusqlite::params![sid, question, now, images_json],
    )
    .map_err(friendly)?;
    tx.execute(
        "INSERT INTO chat_messages(session_id, role, content, refs, source_kind, created_at, images)
         VALUES (?1, 'assistant', ?2, NULL, 'ball_ask', ?3, NULL)",
        rusqlite::params![sid, answer, now],
    )
    .map_err(friendly)?;
    tx.execute(
        "UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, sid],
    )
    .map_err(friendly)?;
    tx.commit().map_err(friendly)?;
    Ok(sid)
}

/// 写入会话摘要（供画像与笔记复用）
pub fn chat_session_summary_set(
    conn: &Connection,
    session_id: i64,
    summary: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    let n = conn
        .execute(
            "UPDATE chat_sessions SET summary = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![summary, now, session_id],
        )
        .map_err(friendly)?;
    ensure_affected(n, "会话", session_id)
}

// ---------------------------------------------------------------------------
// 笔记（notes）—— M3
// ---------------------------------------------------------------------------

/// 笔记来源的**合法取值**（契约 §2.1）：
///   · `ai_session` —— 由 AI 依据某次对话整理（界面上必须标「AI 整理 · 待核对」）；
///   · `user`       —— 用户自己写的。
const NOTE_SOURCES: [&str; 2] = ["user", "ai_session"];

/// 校验并规范化笔记来源；非法值给可读中文错误（**不静默落库**，
/// 否则"AI 整理"与"自己写的"会在界面上互相冒充，这是本产品的诚实红线）。
fn norm_note_source(source: &str) -> Result<String, String> {
    let s = source.trim();
    if NOTE_SOURCES.contains(&s) {
        return Ok(s.to_string());
    }
    Err(format!(
        "笔记来源只能是 ai_session（AI 整理）或 user（自己写的），收到的是「{}」。",
        if s.is_empty() { "(空)" } else { s }
    ))
}

/// 笔记列表：**只给字符数 `content_len`，不塞全文**（列表可能很长，全文走 `note_get`）。
/// `course_id` 为 None = 全部课程；无结果返回 `[]`。
pub fn notes_list(conn: &Connection, course_id: Option<i64>) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.course_id, n.session_id, n.title, n.date, n.exported,
                    IFNULL(n.source, 'user'), n.created_at, length(n.content_md)
             FROM notes n
             WHERE (?1 IS NULL OR n.course_id = ?1)
             ORDER BY n.id DESC",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map([course_id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "course_id": r.get::<_, i64>(1)?,
                "session_id": r.get::<_, Option<i64>>(2)?,
                "title": r.get::<_, String>(3)?,
                "date": r.get::<_, Option<String>>(4)?,
                "exported": r.get::<_, Option<String>>(5)?,
                "source": r.get::<_, String>(6)?,
                "created_at": r.get::<_, String>(7)?,
                // length() 对 TEXT 返回**字符数**（不是字节数），与前端「正文字数」口径一致
                "content_len": r.get::<_, i64>(8)?,
            }))
        })
        .map_err(friendly)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

/// 笔记详情（含 Markdown 全文）。
pub fn note_get(conn: &Connection, id: i64) -> Result<Value, String> {
    conn.query_row(
        "SELECT id, course_id, session_id, title, content_md, date, exported,
                IFNULL(source, 'user'), created_at, length(content_md)
         FROM notes WHERE id = ?1",
        [id],
        |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "course_id": r.get::<_, i64>(1)?,
                "session_id": r.get::<_, Option<i64>>(2)?,
                "title": r.get::<_, String>(3)?,
                "content_md": r.get::<_, String>(4)?,
                "date": r.get::<_, Option<String>>(5)?,
                "exported": r.get::<_, Option<String>>(6)?,
                "source": r.get::<_, String>(7)?,
                "created_at": r.get::<_, String>(8)?,
                "content_len": r.get::<_, i64>(9)?,
            }))
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            format!("笔记不存在（id={id}），可能已被删除；请刷新页面后重试。")
        }
        other => friendly(other),
    })
}

/// 新建笔记，返回新 id。`date` 省略时按**本地日期**（`YYYY-MM-DD`）。
#[allow(clippy::too_many_arguments)]
pub fn note_save(
    conn: &Connection,
    course_id: i64,
    session_id: Option<i64>,
    title: &str,
    content_md: &str,
    date: Option<&str>,
    source: &str,
) -> Result<i64, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("笔记标题不能为空。".into());
    }
    let source = norm_note_source(source)?;
    let date = match date.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => d.to_string(),
        None => chrono::Local::now().format("%Y-%m-%d").to_string(),
    };
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO notes(course_id, session_id, title, content_md, date, exported, source, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7)",
        rusqlite::params![course_id, session_id, title, content_md, date, source, now],
    )
    .map_err(friendly)?;
    Ok(conn.last_insert_rowid())
}

/// 局部更新（标题 / 正文）；两个都不传时是无副作用的 no-op。
/// 刻意**不允许通过本函数改 `source` 与 `exported`**：来源是"内容怎么来的"这一事实，不该被随手改写。
pub fn note_update(
    conn: &Connection,
    id: i64,
    title: Option<&str>,
    content_md: Option<&str>,
) -> Result<(), String> {
    if let Some(t) = title {
        let t = t.trim();
        if t.is_empty() {
            return Err("笔记标题不能为空。".into());
        }
        let n = conn
            .execute(
                "UPDATE notes SET title = ?1 WHERE id = ?2",
                rusqlite::params![t, id],
            )
            .map_err(friendly)?;
        ensure_affected(n, "笔记", id)?;
    }
    if let Some(c) = content_md {
        let n = conn
            .execute(
                "UPDATE notes SET content_md = ?1 WHERE id = ?2",
                rusqlite::params![c, id],
            )
            .map_err(friendly)?;
        ensure_affected(n, "笔记", id)?;
    }
    Ok(())
}

/// 删除笔记：**连同它的批注一起删**（`annotations` 没有外键，否则会留下指向空笔记的孤儿批注）。
pub fn note_delete(conn: &Connection, id: i64) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(friendly)?;
    tx.execute(
        "DELETE FROM annotations WHERE target_kind = 'note' AND target_id = ?1",
        [id],
    )
    .map_err(friendly)?;
    let n = tx
        .execute("DELETE FROM notes WHERE id = ?1", [id])
        .map_err(friendly)?;
    ensure_affected(n, "笔记", id)?;
    tx.commit().map_err(friendly)
}

/// 导出用：取笔记标题与 Markdown 正文（导出走 `docx::export_docx`，由 lib.rs 的实现体串起来）。
pub fn note_export_source(conn: &Connection, id: i64) -> Result<(String, String), String> {
    conn.query_row(
        "SELECT title, content_md FROM notes WHERE id = ?1",
        [id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            format!("笔记不存在（id={id}），无法导出；请刷新页面后重试。")
        }
        other => friendly(other),
    })
}

/// 记录「这条笔记最近一次导出到了哪个文件」（界面上显示「已导出」标记）。
pub fn note_exported_set(conn: &Connection, id: i64, path: &str) -> Result<(), String> {
    let n = conn
        .execute(
            "UPDATE notes SET exported = ?1 WHERE id = ?2",
            rusqlite::params![path, id],
        )
        .map_err(friendly)?;
    ensure_affected(n, "笔记", id)
}

// ---------------------------------------------------------------------------
// 高亮与批注（annotations）—— M3
//
// 锚点 = `block_index`（块序号，与前端 splitBlocks / data-block 一一对应）
//      + `start_off` / `end_off`（**在该块纯文本内**的字符偏移，不是全文字符偏移）
//      + `quote`（被标注的原文片段，用于渲染时校验与自愈）
// 三个字段必须**进出都带上**：只回传字符偏移的实现无法在 Markdown 重排后自愈，会静默标注错位置。
// ---------------------------------------------------------------------------

/// 某对象的批注列表。排序按「块序号 → 块内起点 → id」，
/// NULL 的 `block_index`（旧数据）排在最后，不参与定位。
pub fn annotations_list(
    conn: &Connection,
    target_kind: &str,
    target_id: i64,
) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, target_kind, target_id, block_index, quote, start_off, end_off,
                    color, comment, created_at
             FROM annotations
             WHERE target_kind = ?1 AND target_id = ?2
             ORDER BY (block_index IS NULL) ASC, block_index ASC, start_off ASC, id ASC",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map(rusqlite::params![target_kind, target_id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "target_kind": r.get::<_, String>(1)?,
                "target_id": r.get::<_, i64>(2)?,
                // 允许 NULL：旧批注没有块序号，前端据此把它归入「已失效的批注」
                "block_index": r.get::<_, Option<i64>>(3)?,
                "quote": r.get::<_, Option<String>>(4)?,
                "start_off": r.get::<_, Option<i64>>(5)?,
                "end_off": r.get::<_, Option<i64>>(6)?,
                "color": r.get::<_, Option<String>>(7)?,
                "comment": r.get::<_, Option<String>>(8)?,
                "created_at": r.get::<_, String>(9)?,
            }))
        })
        .map_err(friendly)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

/// 新增一条批注，返回 id。锚点三件套（blockIndex / startOff+endOff / quote）都要校验：
/// 缺了任何一件，前端渲染时就无法"取文本 → 与 quote 比对 → 找不到就自愈"。
#[allow(clippy::too_many_arguments)]
pub fn annotation_add(
    conn: &Connection,
    target_kind: &str,
    target_id: i64,
    block_index: i64,
    quote: &str,
    start_off: i64,
    end_off: i64,
    color: Option<&str>,
    comment: Option<&str>,
) -> Result<i64, String> {
    let target_kind = target_kind.trim();
    if target_kind.is_empty() {
        return Err("批注对象类型（targetKind）不能为空。".into());
    }
    if target_id <= 0 {
        return Err(format!("批注对象不存在（id={target_id}）。"));
    }
    if block_index < 0 {
        return Err(format!(
            "批注的块序号不能为负数（收到 {block_index}）；块序号从 0 开始。"
        ));
    }
    let quote = quote.trim();
    if quote.is_empty() {
        return Err("批注的原文片段（quote）不能为空：没有它就无法在正文改动后校验位置。".into());
    }
    if start_off < 0 || end_off < 0 {
        return Err(format!(
            "批注的字符偏移不能为负数（收到 {start_off}~{end_off}）。"
        ));
    }
    if end_off < start_off {
        return Err(format!(
            "批注的结束位置不能早于开始位置（收到 {start_off}~{end_off}）。"
        ));
    }
    let color = color.map(str::trim).filter(|c| !c.is_empty()).unwrap_or("yellow");
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO annotations(target_kind, target_id, block_index, quote, start_off, end_off,
                                 color, comment, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            target_kind,
            target_id,
            block_index,
            quote,
            start_off,
            end_off,
            color,
            comment,
            now
        ],
    )
    .map_err(friendly)?;
    Ok(conn.last_insert_rowid())
}

/// 局部更新批注（颜色 / 备注）。
/// **锚点（block_index / start_off / end_off / quote）不在这里改**：批注移动位置 = 重新划一次。
pub fn annotation_update(
    conn: &Connection,
    id: i64,
    color: Option<&str>,
    comment: Option<&str>,
) -> Result<(), String> {
    if let Some(c) = color {
        let c = c.trim();
        if c.is_empty() {
            return Err("批注颜色不能为空。".into());
        }
        let n = conn
            .execute(
                "UPDATE annotations SET color = ?1 WHERE id = ?2",
                rusqlite::params![c, id],
            )
            .map_err(friendly)?;
        ensure_affected(n, "批注", id)?;
    }
    if let Some(c) = comment {
        let n = conn
            .execute(
                "UPDATE annotations SET comment = ?1 WHERE id = ?2",
                rusqlite::params![c, id],
            )
            .map_err(friendly)?;
        ensure_affected(n, "批注", id)?;
    }
    Ok(())
}

/// 删除一条批注
pub fn annotation_delete(conn: &Connection, id: i64) -> Result<(), String> {
    let n = conn
        .execute("DELETE FROM annotations WHERE id = ?1", [id])
        .map_err(friendly)?;
    ensure_affected(n, "批注", id)
}

// ---------------------------------------------------------------------------
// 番茄钟（focus_sessions）—— M3
//
// ⚠ `started_at` 存的是 `chrono::Local::now().to_rfc3339()`（**本地时间 + 时区偏移**）。
//   统计时必须先换算回 `Local` 再取日期：直接用 UTC 切日期会把晚间（或凌晨）的专注算到相邻的一天。
// ---------------------------------------------------------------------------

/// 专注段的合法取值（契约 §2.2）
const FOCUS_KINDS: [&str; 2] = ["focus", "break"];

fn norm_focus_kind(kind: &str) -> Result<String, String> {
    let k = kind.trim().to_ascii_lowercase();
    if FOCUS_KINDS.contains(&k.as_str()) {
        return Ok(k);
    }
    Err(format!(
        "专注类型只能是 focus（专注）或 break（休息），收到的是「{}」。",
        if kind.trim().is_empty() {
            "(空)"
        } else {
            kind.trim()
        }
    ))
}

/// 开始一段专注/休息，返回 id（记录里只有开始时间与计划时长）。
pub fn focus_start(
    conn: &Connection,
    course_id: Option<i64>,
    kind: &str,
    plan_min: i64,
) -> Result<i64, String> {
    let kind = norm_focus_kind(kind)?;
    if plan_min < 1 {
        return Err(format!("计划时长至少 1 分钟，收到的是 {plan_min}。"));
    }
    let started_at = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO focus_sessions(course_id, kind, plan_min, actual_min, completed, started_at, ended_at)
         VALUES (?1, ?2, ?3, NULL, 0, ?4, NULL)",
        rusqlite::params![course_id, kind, plan_min, started_at],
    )
    .map_err(friendly)?;
    Ok(conn.last_insert_rowid())
}

/// 结束一段专注/休息：写入实际时长、是否完成、结束时间。
pub fn focus_finish(
    conn: &Connection,
    id: i64,
    actual_min: i64,
    completed: bool,
) -> Result<(), String> {
    if actual_min < 0 {
        return Err(format!("实际时长不能为负数（收到 {actual_min}）。"));
    }
    let ended_at = chrono::Local::now().to_rfc3339();
    let n = conn
        .execute(
            "UPDATE focus_sessions SET actual_min = ?1, completed = ?2, ended_at = ?3 WHERE id = ?4",
            rusqlite::params![actual_min, flag(completed), ended_at, id],
        )
        .map_err(friendly)?;
    ensure_affected(n, "专注记录", id)
}

/// `focus_list` 的条数口径：默认 20、上限 200、小于 1 按 1。
const FOCUS_LIST_LIMIT_DEFAULT: i64 = 20;
const FOCUS_LIST_LIMIT_MAX: i64 = 200;

/// 专注记录列表（按 `started_at` 倒序，同秒用 id 兜底稳定排序）。
pub fn focus_list(conn: &Connection, limit: Option<i64>) -> Result<Vec<Value>, String> {
    let lim = limit
        .unwrap_or(FOCUS_LIST_LIMIT_DEFAULT)
        .clamp(1, FOCUS_LIST_LIMIT_MAX);
    let mut stmt = conn
        .prepare(
            "SELECT id, course_id, kind, plan_min, actual_min, completed, started_at, ended_at
             FROM focus_sessions
             ORDER BY started_at DESC, id DESC
             LIMIT ?1",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map([lim], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "course_id": r.get::<_, Option<i64>>(1)?,
                "kind": r.get::<_, String>(2)?,
                "plan_min": r.get::<_, i64>(3)?,
                "actual_min": r.get::<_, Option<i64>>(4)?,
                "completed": r.get::<_, i64>(5)?,
                "started_at": r.get::<_, String>(6)?,
                "ended_at": r.get::<_, Option<String>>(7)?,
            }))
        })
        .map_err(friendly)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

/// `focus_stats` 的窗口口径：默认 7 天、上限 365 天、小于 1 按 1。
const FOCUS_STATS_DAYS_DEFAULT: i64 = 7;
const FOCUS_STATS_DAYS_MAX: i64 = 365;
/// `week_min` **固定**看最近 7 天（含今天），与 `days` 参数无关 —— 字段名说的是"周"。
const FOCUS_WEEK_DAYS: i64 = 7;

/// 专注统计：`{ today_min, week_min, sessions, by_day: [{date, min}] }`
///
/// * 只统计 `kind = 'focus'` 的段（休息时长不算专注时长）；
/// * 分钟数取 `actual_min`（**实际**时长）；未结束的段按 0 分钟计，但仍计入 `sessions`；
/// * 分桶按 `started_at` 的**本地日期**（`Local`，不是 UTC）；
/// * `by_day` 覆盖窗口内**每一天**（没有记录的日期给 0），日期升序，供柱状图直接画；
/// * `sessions` = 窗口内的专注**段数**（默认近 7 天）。
pub fn focus_stats(conn: &Connection, days: Option<i64>) -> Result<Value, String> {
    let days = days
        .unwrap_or(FOCUS_STATS_DAYS_DEFAULT)
        .clamp(1, FOCUS_STATS_DAYS_MAX);
    let today = chrono::Local::now().date_naive();
    let from = today - chrono::Duration::days(days - 1);
    let week_from = today - chrono::Duration::days(FOCUS_WEEK_DAYS - 1);

    let mut stmt = conn
        .prepare("SELECT started_at, actual_min FROM focus_sessions WHERE kind = 'focus'")
        .map_err(friendly)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))
        })
        .map_err(friendly)?;

    let mut per_day: std::collections::BTreeMap<chrono::NaiveDate, i64> =
        std::collections::BTreeMap::new();
    let mut today_min = 0i64;
    let mut week_min = 0i64;
    let mut sessions = 0i64;

    for row in rows {
        let (started_at, actual_min) = row.map_err(friendly)?;
        // 时间戳坏掉的行不该带崩整页统计：跳过并打日志（数据是本机写的，正常不会走到这）
        let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&started_at) else {
            eprintln!("[focus] 无法解析的 started_at，已跳过统计：{started_at}");
            continue;
        };
        // ⚠ 关键一行：换算回**本地**时间再取日期。若写成 dt.date_naive()（UTC 日期），
        //   UTC+8 下凌晨 00:30 的专注会被算到前一天、UTC-5 下晚间 23:30 会被算到后一天。
        let date = dt.with_timezone(&chrono::Local).date_naive();
        let min = actual_min.unwrap_or(0).max(0);
        if date >= week_from && date <= today {
            week_min += min;
        }
        if date < from || date > today {
            continue;
        }
        sessions += 1;
        if date == today {
            today_min += min;
        }
        *per_day.entry(date).or_insert(0) += min;
    }

    let mut by_day: Vec<Value> = Vec::with_capacity(days as usize);
    let mut d = from;
    while d <= today {
        by_day.push(json!({
            "date": d.format("%Y-%m-%d").to_string(),
            "min": per_day.get(&d).copied().unwrap_or(0),
        }));
        d = d + chrono::Duration::days(1);
    }

    Ok(json!({
        "today_min": today_min,
        "week_min": week_min,
        "sessions": sessions,
        "by_day": by_day,
    }))
}

// ---------------------------------------------------------------------------
// 待办（todos）：M0 只给后台提醒线程用，读写命令留到 M1
// ---------------------------------------------------------------------------

/// 挑出「未完成 + 开了桌面弹窗 + 有到期时间 + 该到期时间还没提醒过」的待办
pub fn todos_due(conn: &Connection) -> Result<Vec<(i64, String, String, i64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, due_at, remind_minutes FROM todos
             WHERE done = 0 AND desktop_popup = 1 AND due_at IS NOT NULL
               AND (last_notified_due IS NULL OR last_notified_due != due_at)",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(friendly)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

/// 记录「已按该到期时间提醒过」，避免同一到期时间重复弹窗
pub fn todo_mark_notified(conn: &Connection, id: i64, due_at: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE todos SET last_notified_due = ?1 WHERE id = ?2",
        rusqlite::params![due_at, id],
    )
    .map(|_| ())
    .map_err(friendly)
}

// ---------------------------------------------------------------------------
// M4 · 知识点 / 题库 / 练习作答 / 学习画像
// ---------------------------------------------------------------------------
//
// 口径红线（`docs/10-M4契约.md` §一，代码与注释都按这里写死）：
//   1) 掌握度是**统计量**，不是"模型学会了"：本机只做统计加权与提示词调整，
//      **不训练、不上传**；本层与注释里不得出现"智能推荐 / 自我进化 / 越用越聪明"一类措辞。
//   2) 样本不足不展示结论：`attempts < MIN_EVIDENCE` 的知识点**只进 `not_enough`**，
//      不进 `mastery` 的有效结论、不进 `weak_points`。
//   3) 无数据时如实用空数组 / `null` 表达，不造数据。
// 全部为本机查询：本文件不做任何网络请求。

/// 题型白名单（契约 §2.2）
const Q_TYPES: [&str; 4] = ["choice", "blank", "short", "essay"];

/// 画像条目类型（契约 §2.4）：
/// `mastery` 是**系统按作答记录算出来的、只读**；
/// `weakness_self` 是**用户自述缺漏**（"你说的"），与统计结论分区展示，绝不混为一谈。
const TRAIT_KINDS: [&str; 4] = ["mastery", "weakness_self", "preference", "style"];

/// 样本不足阈值：`attempts < min_evidence` 只进 `not_enough`（契约 §2.4 与 §一 第 2 条）。
pub const MIN_EVIDENCE: i64 = 3;

/// 弱项榜条数上限（契约 §2.4：`mastery` 升序取前 10）
const WEAK_POINTS_MAX: usize = 10;

const QUESTIONS_LIST_LIMIT_DEFAULT: i64 = 200;
const QUESTIONS_LIST_LIMIT_MAX: i64 = 1000;
const ATTEMPTS_LIST_LIMIT_DEFAULT: i64 = 200;
const ATTEMPTS_LIST_LIMIT_MAX: i64 = 1000;
const PRACTICE_PICK_DEFAULT: i64 = 5;
const PRACTICE_PICK_MAX: i64 = 50;

/// 掌握度公式（**口径红线，逐字取自 `docs/10-M4契约.md` §2.4，不要改**）：
///
/// ```text
/// mastery  = (correct + 1) / (attempts + 2)   // 拉普拉斯平滑，避免 0/0 与 1/1 的极端
/// evidence = attempts
/// ```
///
/// 平滑的意义：一次都没答不会显示 0%，只答对一次也不会显示 100%。
/// 它是**统计量**——模型权重不会因此改变，本机没有训练，也没有上传。
fn mastery_of(correct: i64, attempts: i64) -> f64 {
    (correct as f64 + 1.0) / (attempts as f64 + 2.0)
}

/// 原始正确率 `correct / attempts`；`attempts = 0` 时返回 `None`（JSON `null`）。
/// 它与平滑后的 `mastery` **并存展示**，避免读者误以为平滑值就是原始正确率（契约 §2.4）。
fn accuracy_of(correct: i64, attempts: i64) -> Option<f64> {
    if attempts <= 0 {
        None
    } else {
        Some(correct as f64 / attempts as f64)
    }
}

/// JSON 值的类型名（拼可读错误用）
fn json_kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "布尔值",
        Value::Number(_) => "数字",
        Value::String(_) => "字符串",
        Value::Array(_) => "数组",
        Value::Object(_) => "对象",
    }
}

/// 校验题型；非法值给可读中文错误（**不静默落库**）。
fn norm_qtype(qtype: &str) -> Result<String, String> {
    let t = qtype.trim();
    if Q_TYPES.contains(&t) {
        return Ok(t.to_string());
    }
    Err(format!(
        "题型只能是 choice（选择）/ blank（填空）/ short（简答）/ essay（论述），收到的是「{}」。",
        if t.is_empty() { "(空)" } else { t }
    ))
}

/// `options` 统一成「**合法 JSON 数组**字符串」。
/// 前端传 `["A项","B项"]` 的字符串形式（契约口径）或直接传数组（更省事）都收；
/// 其它形状（坏 JSON / 数字 / 对象）一律报可读错误 —— 契约 §2.2 明确要求。
fn options_text(v: Option<&Value>) -> Result<Option<String>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                return Ok(None);
            }
            match serde_json::from_str::<Value>(t) {
                Ok(Value::Array(_)) => Ok(Some(t.to_string())),
                Ok(other) => Err(format!(
                    "options 必须是 JSON **数组**（选择题形如 [\"A项\",\"B项\"]），收到的是 JSON {}。",
                    json_kind(&other)
                )),
                Err(e) => Err(format!(
                    "options 不是合法 JSON（正确写法如 [\"A项\",\"B项\"]）：{e}"
                )),
            }
        }
        Some(arr @ Value::Array(_)) => Ok(Some(arr.to_string())),
        Some(other) => Err(format!(
            "options 必须是 JSON 数组或它的字符串形式，收到的是 JSON {}。",
            json_kind(other)
        )),
    }
}

// ---- 知识点（knowledge_points：题库与画像的公共轴） ----

/// 某课程的知识点列表（扁平返回，前端按 `parent_id` 组树）。
/// 附带每个知识点下的题目数，以及该知识点**全部作答**的 `attempts` / `correct` 汇总。
pub fn knowledge_points_list(conn: &Connection, course_id: i64) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT k.id, k.course_id, k.prior_id, k.name, k.parent_id,
                    (SELECT COUNT(*) FROM questions q WHERE q.kp_id = k.id),
                    (SELECT COUNT(*) FROM attempts a JOIN questions q ON q.id = a.question_id
                      WHERE q.kp_id = k.id),
                    (SELECT COUNT(*) FROM attempts a JOIN questions q ON q.id = a.question_id
                      WHERE q.kp_id = k.id AND a.correct = 1)
             FROM knowledge_points k
             WHERE k.course_id = ?1
             ORDER BY COALESCE(k.parent_id, 0), k.id",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map([course_id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "course_id": r.get::<_, i64>(1)?,
                "prior_id": r.get::<_, Option<i64>>(2)?,
                "name": r.get::<_, String>(3)?,
                "parent_id": r.get::<_, Option<i64>>(4)?,
                "question_count": r.get::<_, i64>(5)?,
                "attempts": r.get::<_, i64>(6)?,
                "correct": r.get::<_, i64>(7)?,
            }))
        })
        .map_err(friendly)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

/// 新建知识点。**同名同课程已存在则返回既有 id**（不重复插 ——
/// 公共轴上长出两个"极限"会让题库与画像对不上账）。
pub fn knowledge_point_save(
    conn: &Connection,
    course_id: i64,
    name: &str,
    prior_id: Option<i64>,
    parent_id: Option<i64>,
) -> Result<i64, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("知识点名称不能为空。".into());
    }
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM knowledge_points WHERE course_id = ?1 AND name = ?2 ORDER BY id LIMIT 1",
            rusqlite::params![course_id, name],
            |r| r.get(0),
        )
        .optional()
        .map_err(friendly)?;
    if let Some(id) = existing {
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO knowledge_points(course_id, prior_id, name, parent_id) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![course_id, prior_id, name, parent_id],
    )
    .map_err(friendly)?;
    Ok(conn.last_insert_rowid())
}

/// 一条先验 → 一条知识点（**幂等的核心**）：
/// ① 同 `course_id` + `prior_id` 已存在 → 直接返回既有 id，**不重复建**；
/// ② 存在同名、但还没关联先验的手工知识点 → **认领**它（补上 `prior_id` / `parent_id`），
///    而不是再造一条重名的；
/// ③ 都没有 → 新建，`created` 计数 +1。
fn sync_prior_node(
    conn: &Connection,
    course_id: i64,
    prior_id: i64,
    topic: &str,
    parent_kp: Option<i64>,
    created: &mut i64,
) -> Result<i64, String> {
    if let Some(k) = conn
        .query_row(
            "SELECT id FROM knowledge_points WHERE course_id = ?1 AND prior_id = ?2",
            rusqlite::params![course_id, prior_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .map_err(friendly)?
    {
        return Ok(k);
    }
    let name = topic.trim();
    let name = if name.is_empty() {
        format!("未命名知识点（先验 #{prior_id}）")
    } else {
        name.to_string()
    };
    if let Some(k) = conn
        .query_row(
            "SELECT id FROM knowledge_points
             WHERE course_id = ?1 AND name = ?2 AND prior_id IS NULL ORDER BY id LIMIT 1",
            rusqlite::params![course_id, name],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .map_err(friendly)?
    {
        conn.execute(
            "UPDATE knowledge_points SET prior_id = ?1, parent_id = ?2 WHERE id = ?3",
            rusqlite::params![prior_id, parent_kp, k],
        )
        .map_err(friendly)?;
        return Ok(k);
    }
    conn.execute(
        "INSERT INTO knowledge_points(course_id, prior_id, name, parent_id) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![course_id, prior_id, name, parent_kp],
    )
    .map_err(friendly)?;
    *created += 1;
    Ok(conn.last_insert_rowid())
}

/// 从该课程的**先验知识树**派生知识点（`prior_id` 关联，`topic` 作 `name`，
/// 先验的 `parent_id` 映射成知识点的 `parent_id`），返回 `{ created, total }`。
///
/// **幂等**：已存在的（同 `course_id` + `prior_id`）不重复建 —— 连点两次按钮
/// 第二次必然是 `created = 0`（测试 `knowledge_points_sync_from_prior_is_idempotent` 钉住）。
/// `total` = 该课程当前**由先验派生**的知识点总数（界面上的"共 N 个"）。
pub fn knowledge_points_sync_from_prior(
    conn: &Connection,
    course_id: i64,
) -> Result<Value, String> {
    #[derive(Clone)]
    struct PriorNode {
        id: i64,
        parent_id: Option<i64>,
        topic: String,
    }

    let mut stmt = conn
        .prepare("SELECT id, parent_id, topic FROM course_prior WHERE course_id = ?1 ORDER BY id")
        .map_err(friendly)?;
    let nodes: Vec<PriorNode> = stmt
        .query_map([course_id], |r| {
            Ok(PriorNode {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                topic: r.get(2)?,
            })
        })
        .map_err(friendly)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(friendly)?;

    // 已同步过的先验 → 知识点 id。先把它们装进 map，第二次同步时全是命中（幂等的关键）。
    let mut kp_of_prior: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    {
        let mut s = conn
            .prepare(
                "SELECT prior_id, id FROM knowledge_points
                 WHERE course_id = ?1 AND prior_id IS NOT NULL",
            )
            .map_err(friendly)?;
        let rows = s
            .query_map([course_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
            .map_err(friendly)?;
        for row in rows {
            let (p, k) = row.map_err(friendly)?;
            kp_of_prior.insert(p, k);
        }
    }

    let mut created = 0i64;
    let mut pending = nodes;
    // 先验树的父节点顺序不保证（`parent_id` 可能大于子节点 id），所以按"父已就绪"分轮处理。
    while !pending.is_empty() {
        let mut next: Vec<PriorNode> = Vec::new();
        let mut progressed = false;
        for p in pending {
            let parent_kp = match p.parent_id {
                None => None,
                Some(pid) => match kp_of_prior.get(&pid) {
                    Some(k) => Some(*k),
                    // 父先验这一轮还没轮到，留到下一轮，避免把父子关系接错
                    None => {
                        next.push(p);
                        continue;
                    }
                },
            };
            let kp_id = sync_prior_node(conn, course_id, p.id, &p.topic, parent_kp, &mut created)?;
            kp_of_prior.insert(p.id, kp_id);
            progressed = true;
        }
        if !progressed {
            // 剩下的 `parent_id` 指向**已不在该课程先验树里**的节点（历史脏数据）：
            // 当根节点处理，避免死循环。**不猜**它原来挂在哪（诚实边界）。
            for p in next {
                let kp_id = sync_prior_node(conn, course_id, p.id, &p.topic, None, &mut created)?;
                kp_of_prior.insert(p.id, kp_id);
            }
            break;
        }
        pending = next;
    }

    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM knowledge_points WHERE course_id = ?1 AND prior_id IS NOT NULL",
            [course_id],
            |r| r.get(0),
        )
        .map_err(friendly)?;
    Ok(json!({ "created": created, "total": total }))
}

// ---- 题库（questions） ----

/// 题库列表：含每个题目的作答次数与**最近一次是否答对**（`attempts` / `last_correct`）。
/// 列表给全字段（题干 / 选项 / 答案 / 解析都要回填到编辑框，缺一项就会把旧内容改没），
/// 只额外挂两个聚合列；`courseId` / `kpId` 不传 = 不过滤；无结果返回 `[]`。
pub fn questions_list(
    conn: &Connection,
    course_id: Option<i64>,
    kp_id: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<Value>, String> {
    let limit = limit
        .unwrap_or(QUESTIONS_LIST_LIMIT_DEFAULT)
        .clamp(1, QUESTIONS_LIST_LIMIT_MAX);
    let mut stmt = conn
        .prepare(
            "SELECT q.id, q.course_id, q.kp_id, k.name, q.qtype, q.stem, q.options, q.answer,
                    q.explain, q.difficulty, q.source, q.source_ref, q.flawed, q.created_at,
                    (SELECT COUNT(*) FROM attempts a WHERE a.question_id = q.id),
                    (SELECT a.correct FROM attempts a WHERE a.question_id = q.id
                      ORDER BY a.id DESC LIMIT 1)
             FROM questions q LEFT JOIN knowledge_points k ON k.id = q.kp_id
             WHERE (?1 IS NULL OR q.course_id = ?1) AND (?2 IS NULL OR q.kp_id = ?2)
             ORDER BY q.id DESC
             LIMIT ?3",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map(rusqlite::params![course_id, kp_id, limit], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "course_id": r.get::<_, i64>(1)?,
                "kp_id": r.get::<_, Option<i64>>(2)?,
                "kp_name": r.get::<_, Option<String>>(3)?,
                "qtype": r.get::<_, String>(4)?,
                "stem": r.get::<_, String>(5)?,
                "options": r.get::<_, Option<String>>(6)?,
                "answer": r.get::<_, String>(7)?,
                "explain": r.get::<_, Option<String>>(8)?,
                "difficulty": r.get::<_, Option<i64>>(9)?,
                "source": r.get::<_, String>(10)?,
                "source_ref": r.get::<_, Option<String>>(11)?,
                "flawed": r.get::<_, i64>(12)?,
                "created_at": r.get::<_, String>(13)?,
                "attempts": r.get::<_, i64>(14)?,
                // 从未作答 = null（不是 0）；0 表示明确答错
                "last_correct": r.get::<_, Option<i64>>(15)?,
            }))
        })
        .map_err(friendly)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

/// 题目详情（全字段 + 所属知识点名 + 聚合列）。
pub fn question_get(conn: &Connection, id: i64) -> Result<Value, String> {
    conn.query_row(
        "SELECT q.id, q.course_id, q.kp_id, k.name, q.qtype, q.stem, q.options, q.answer,
                q.explain, q.difficulty, q.source, q.source_ref, q.flawed, q.created_at,
                (SELECT COUNT(*) FROM attempts a WHERE a.question_id = q.id),
                (SELECT a.correct FROM attempts a WHERE a.question_id = q.id
                  ORDER BY a.id DESC LIMIT 1)
         FROM questions q LEFT JOIN knowledge_points k ON k.id = q.kp_id
         WHERE q.id = ?1",
        [id],
        |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "course_id": r.get::<_, i64>(1)?,
                "kp_id": r.get::<_, Option<i64>>(2)?,
                "kp_name": r.get::<_, Option<String>>(3)?,
                "qtype": r.get::<_, String>(4)?,
                "stem": r.get::<_, String>(5)?,
                "options": r.get::<_, Option<String>>(6)?,
                "answer": r.get::<_, String>(7)?,
                "explain": r.get::<_, Option<String>>(8)?,
                "difficulty": r.get::<_, Option<i64>>(9)?,
                "source": r.get::<_, String>(10)?,
                "source_ref": r.get::<_, Option<String>>(11)?,
                "flawed": r.get::<_, i64>(12)?,
                "created_at": r.get::<_, String>(13)?,
                "attempts": r.get::<_, i64>(14)?,
                "last_correct": r.get::<_, Option<i64>>(15)?,
            }))
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            format!("题目不存在（id={id}），可能已被删除；请刷新页面后重试。")
        }
        other => friendly(other),
    })
}

/// 新建题目，返回新 id。`qtype` 与 `options` 都按契约校验（见 `norm_qtype` / `options_text`）。
#[allow(clippy::too_many_arguments)]
pub fn question_save(
    conn: &Connection,
    course_id: i64,
    kp_id: Option<i64>,
    qtype: &str,
    stem: &str,
    options: Option<&Value>,
    answer: &str,
    explain: Option<&str>,
    difficulty: Option<i64>,
    source: &str,
    source_ref: Option<&str>,
) -> Result<i64, String> {
    let qtype = norm_qtype(qtype)?;
    let stem = stem.trim();
    if stem.is_empty() {
        return Err("题干不能为空。".into());
    }
    let answer = answer.trim();
    if answer.is_empty() {
        return Err("答案不能为空。".into());
    }
    let source = source.trim();
    if source.is_empty() {
        return Err("来源不能为空（ai / user / textbook …）：题目要能溯源。".into());
    }
    let options = options_text(options)?;
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO questions(course_id, kp_id, qtype, stem, options, answer, explain,
                               difficulty, source, source_ref, flawed, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11)",
        rusqlite::params![
            course_id,
            kp_id,
            qtype,
            stem,
            options,
            answer,
            explain,
            difficulty,
            source,
            source_ref,
            now
        ],
    )
    .map_err(friendly)?;
    Ok(conn.last_insert_rowid())
}

/// `questions_save_batch` 的单项（与前端 `NewQuestion` 对应）。
/// 字段名 snake_case；同时容忍 camelCase（`kpId` / `sourceRef`）——
/// 与 `ChatMsg` 同样的道理：嵌套结构体**不经过** Tauri 的命令参数名映射，
/// 前端写成驼峰时只会静默变 None（母本踩过）。
#[derive(Debug, serde::Deserialize)]
pub struct NewQuestion {
    #[serde(default, alias = "kpId")]
    pub kp_id: Option<i64>,
    pub qtype: String,
    pub stem: String,
    #[serde(default)]
    pub options: Option<Value>,
    pub answer: String,
    #[serde(default)]
    pub explain: Option<String>,
    #[serde(default)]
    pub difficulty: Option<i64>,
    /// 省略时按 `ai`：批量入库是「AI 生成 → 预览确认 → 入库」这条链路（契约 §一 第 5 条）。
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default, alias = "sourceRef")]
    pub source_ref: Option<String>,
}

/// **批量入库：一次事务写完**，避免前端 N 次 IPC 往返（M3 的 T20 就是这个教训）。
/// 任何一项不合法 → **整体回滚**，并在错误里指出是第几题，绝不留半份题库。
pub fn questions_save_batch(
    conn: &Connection,
    course_id: i64,
    items: &[NewQuestion],
) -> Result<Vec<i64>, String> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    let now = chrono::Local::now().to_rfc3339();
    let tx = conn.unchecked_transaction().map_err(friendly)?;
    let mut ids: Vec<i64> = Vec::with_capacity(items.len());
    for (idx, it) in items.iter().enumerate() {
        let no = idx + 1;
        let qtype = norm_qtype(&it.qtype).map_err(|e| format!("第 {no} 题：{e}"))?;
        let stem = it.stem.trim();
        if stem.is_empty() {
            return Err(format!("第 {no} 题：题干不能为空。"));
        }
        let answer = it.answer.trim();
        if answer.is_empty() {
            return Err(format!("第 {no} 题：答案不能为空。"));
        }
        let source = it.source.as_deref().unwrap_or("ai").trim().to_string();
        if source.is_empty() {
            return Err(format!("第 {no} 题：来源不能为空。"));
        }
        let options = options_text(it.options.as_ref()).map_err(|e| format!("第 {no} 题：{e}"))?;
        tx.execute(
            "INSERT INTO questions(course_id, kp_id, qtype, stem, options, answer, explain,
                                   difficulty, source, source_ref, flawed, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11)",
            rusqlite::params![
                course_id,
                it.kp_id,
                qtype,
                stem,
                options,
                answer,
                it.explain,
                it.difficulty,
                source,
                it.source_ref,
                now
            ],
        )
        .map_err(friendly)?;
        ids.push(tx.last_insert_rowid());
    }
    tx.commit().map_err(friendly)?;
    Ok(ids)
}

/// 人工校正入口（契约 §一 第 5 条：题目与答案**必须**可人工校正）。
/// 传 `None` 的字段**不改动**；`options` 传 `null` 表示**清空选项**（Value 才能区分
/// "没传"与"显式清空"）；`flawed` 就是"标记题目有问题"。
#[allow(clippy::too_many_arguments)]
pub fn question_update(
    conn: &Connection,
    id: i64,
    stem: Option<&str>,
    options: Option<&Value>,
    answer: Option<&str>,
    explain: Option<&str>,
    difficulty: Option<i64>,
    flawed: Option<bool>,
) -> Result<(), String> {
    if let Some(v) = stem {
        let v = v.trim();
        if v.is_empty() {
            return Err("题干不能为空。".into());
        }
        let n = conn
            .execute(
                "UPDATE questions SET stem = ?1 WHERE id = ?2",
                rusqlite::params![v, id],
            )
            .map_err(friendly)?;
        ensure_affected(n, "题目", id)?;
    }
    if let Some(v) = options {
        let text = options_text(Some(v))?;
        let n = conn
            .execute(
                "UPDATE questions SET options = ?1 WHERE id = ?2",
                rusqlite::params![text, id],
            )
            .map_err(friendly)?;
        ensure_affected(n, "题目", id)?;
    }
    if let Some(v) = answer {
        let v = v.trim();
        if v.is_empty() {
            return Err("答案不能为空。".into());
        }
        let n = conn
            .execute(
                "UPDATE questions SET answer = ?1 WHERE id = ?2",
                rusqlite::params![v, id],
            )
            .map_err(friendly)?;
        ensure_affected(n, "题目", id)?;
    }
    if let Some(v) = explain {
        let n = conn
            .execute(
                "UPDATE questions SET explain = ?1 WHERE id = ?2",
                rusqlite::params![v, id],
            )
            .map_err(friendly)?;
        ensure_affected(n, "题目", id)?;
    }
    if let Some(v) = difficulty {
        let n = conn
            .execute(
                "UPDATE questions SET difficulty = ?1 WHERE id = ?2",
                rusqlite::params![v, id],
            )
            .map_err(friendly)?;
        ensure_affected(n, "题目", id)?;
    }
    if let Some(v) = flawed {
        let n = conn
            .execute(
                "UPDATE questions SET flawed = ?1 WHERE id = ?2",
                rusqlite::params![flag(v), id],
            )
            .map_err(friendly)?;
        ensure_affected(n, "题目", id)?;
    }
    Ok(())
}

/// 删除题目，**连同它的作答记录**（契约 §2.2）。
/// FK 已声明 `ON DELETE CASCADE`，这里仍显式删：不依赖 PRAGMA 一定开着，
/// 也避免外键关闭时留下指向不存在题目的孤儿作答。
pub fn question_delete(conn: &Connection, id: i64) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(friendly)?;
    tx.execute("DELETE FROM attempts WHERE question_id = ?1", [id])
        .map_err(friendly)?;
    let n = tx
        .execute("DELETE FROM questions WHERE id = ?1", [id])
        .map_err(friendly)?;
    if n == 0 {
        return Err(format!(
            "题目不存在（id={id}），可能已被删除；请刷新页面后重试。"
        ));
    }
    tx.commit().map_err(friendly)
}

// ---- 练习与作答（practice / attempts） ----

/// 选题：**按"弱项优先"排序**（排序规则全部可解释，**不是**"智能推荐"）：
///   ① 从未作答的题目优先（本题 `attempts = 0`）—— 先补样本，没有样本就没有结论；
///   ② 其次按所属知识点的**掌握度升序**（越弱越先，掌握度算法见 `mastery_of`）；
///   ③ 同分按题目 `id` 升序 —— 稳定排序，同一批题每次取出来顺序一致。
/// `count` 默认 5、上限 50。带 `flawed` 标记的题**仍会被选出**（契约只规定了排序规则，
/// 没授权过滤）；前端可自行跳过并在界面上说明。
pub fn practice_pick(
    conn: &Connection,
    course_id: i64,
    kp_id: Option<i64>,
    count: Option<i64>,
) -> Result<Vec<Value>, String> {
    let count = count.unwrap_or(PRACTICE_PICK_DEFAULT).clamp(1, PRACTICE_PICK_MAX);
    let mut stmt = conn
        .prepare(
            "SELECT q.id, q.course_id, q.kp_id, k.name, q.qtype, q.stem, q.options, q.answer,
                    q.explain, q.difficulty, q.source, q.source_ref, q.flawed, q.created_at,
                    (SELECT COUNT(*) FROM attempts a WHERE a.question_id = q.id),
                    (SELECT COUNT(*) FROM attempts a JOIN questions q2 ON q2.id = a.question_id
                      WHERE q2.kp_id IS q.kp_id),
                    (SELECT COUNT(*) FROM attempts a JOIN questions q2 ON q2.id = a.question_id
                      WHERE q2.kp_id IS q.kp_id AND a.correct = 1)
             FROM questions q LEFT JOIN knowledge_points k ON k.id = q.kp_id
             WHERE q.course_id = ?1 AND (?2 IS NULL OR q.kp_id = ?2)
             ORDER BY q.id",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map(rusqlite::params![course_id, kp_id], |r| {
            Ok((
                json!({
                    "id": r.get::<_, i64>(0)?,
                    "course_id": r.get::<_, i64>(1)?,
                    "kp_id": r.get::<_, Option<i64>>(2)?,
                    "kp_name": r.get::<_, Option<String>>(3)?,
                    "qtype": r.get::<_, String>(4)?,
                    "stem": r.get::<_, String>(5)?,
                    "options": r.get::<_, Option<String>>(6)?,
                    "answer": r.get::<_, String>(7)?,
                    "explain": r.get::<_, Option<String>>(8)?,
                    "difficulty": r.get::<_, Option<i64>>(9)?,
                    "source": r.get::<_, String>(10)?,
                    "source_ref": r.get::<_, Option<String>>(11)?,
                    "flawed": r.get::<_, i64>(12)?,
                    "created_at": r.get::<_, String>(13)?,
                }),
                r.get::<_, i64>(0)?,  // 题目 id（稳定排序用）
                r.get::<_, i64>(14)?, // 本题作答次数
                r.get::<_, i64>(15)?, // 所属知识点的样本数
                r.get::<_, i64>(16)?, // 所属知识点的答对数
            ))
        })
        .map_err(friendly)?;

    // (题目, id, 本题作答数, 知识点掌握度, 知识点样本数)
    let mut items: Vec<(Value, i64, i64, f64, i64)> = Vec::new();
    for row in rows {
        let (mut item, id, q_attempts, kp_attempts, kp_correct) = row.map_err(friendly)?;
        let mastery = mastery_of(kp_correct, kp_attempts);
        if let Some(obj) = item.as_object_mut() {
            obj.insert("attempts".into(), json!(q_attempts));
            obj.insert("kp_mastery".into(), json!(mastery));
            obj.insert("kp_evidence".into(), json!(kp_attempts));
        }
        items.push((item, id, q_attempts, mastery, kp_attempts));
    }

    items.sort_by(|a, b| {
        // ① false（未作答）排在 true（已作答）前面
        (a.2 > 0)
            .cmp(&(b.2 > 0))
            // ② 掌握度升序：越弱越先
            .then(a.3.partial_cmp(&b.3).unwrap_or(std::cmp::Ordering::Equal))
            // ③ 同分按 id 稳定排序
            .then(a.1.cmp(&b.1))
    });
    items.truncate(count as usize);
    Ok(items.into_iter().map(|(v, _, _, _, _)| v).collect())
}

/// 记录一次作答，返回新记录 id。
/// `correct` 允许省略（主观题**待自评**）；`self_eval` 0/1；`duration_ms` / `confidence` 可空。
/// **校验**（契约 §2.3）：`confidence` 越界、`duration_ms` 为负、`self_eval` 非 0/1
/// 一律报可读中文错误 —— 宁可报错，也不把越界数据悄悄落库。
#[allow(clippy::too_many_arguments)]
pub fn attempt_record(
    conn: &Connection,
    question_id: i64,
    user_answer: Option<&str>,
    correct: Option<bool>,
    self_eval: Option<i64>,
    duration_ms: Option<i64>,
    confidence: Option<i64>,
) -> Result<i64, String> {
    if let Some(c) = confidence {
        if !(1..=5).contains(&c) {
            return Err(format!("信心度只能是 1–5 之间的整数，收到的是 {c}。"));
        }
    }
    if let Some(d) = duration_ms {
        if d < 0 {
            return Err(format!("作答耗时不能为负数，收到的是 {d} 毫秒。"));
        }
    }
    if let Some(s) = self_eval {
        if s != 0 && s != 1 {
            return Err(format!(
                "自评只能是 0（还没掌握）或 1（已掌握），收到的是 {s}。"
            ));
        }
    }
    let exists = conn
        .query_row("SELECT 1 FROM questions WHERE id = ?1", [question_id], |_| {
            Ok(())
        })
        .is_ok();
    if !exists {
        return Err(format!(
            "题目不存在（id={question_id}），可能已被删除；请刷新页面后重试。"
        ));
    }
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO attempts(question_id, user_answer, correct, self_eval, duration_ms,
                              confidence, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            question_id,
            user_answer,
            correct.map(flag),
            self_eval,
            duration_ms,
            confidence,
            now
        ],
    )
    .map_err(friendly)?;
    Ok(conn.last_insert_rowid())
}

/// 作答记录列表（**错题本的数据源**）：连题目 `stem` / `qtype` / `answer` / `explain` 一起给，
/// 前端不必再逐条 `question_get`。
///
/// `only_wrong` 口径：`COALESCE(correct, self_eval) = 0` ——
/// 明确判错（客观题）或**自评未掌握**（主观题）都算"未答对"；
/// 两者都为 NULL 的"待自评"记录**不算错题**（避免把还没判分的题误列为错题）。
pub fn attempts_list(
    conn: &Connection,
    course_id: Option<i64>,
    kp_id: Option<i64>,
    only_wrong: Option<bool>,
    limit: Option<i64>,
) -> Result<Vec<Value>, String> {
    let limit = limit
        .unwrap_or(ATTEMPTS_LIST_LIMIT_DEFAULT)
        .clamp(1, ATTEMPTS_LIST_LIMIT_MAX);
    let only_wrong = flag(only_wrong.unwrap_or(false));
    let mut stmt = conn
        .prepare(
            "SELECT a.id, a.question_id, q.course_id, q.kp_id, k.name, q.stem, q.qtype,
                    q.options, q.answer, q.explain, a.user_answer, a.correct, a.self_eval,
                    a.duration_ms, a.confidence, a.created_at
             FROM attempts a
             JOIN questions q ON q.id = a.question_id
             LEFT JOIN knowledge_points k ON k.id = q.kp_id
             WHERE (?1 IS NULL OR q.course_id = ?1)
               AND (?2 IS NULL OR q.kp_id = ?2)
               AND (?3 = 0 OR COALESCE(a.correct, a.self_eval) = 0)
             ORDER BY a.id DESC
             LIMIT ?4",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map(
            rusqlite::params![course_id, kp_id, only_wrong, limit],
            |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "question_id": r.get::<_, i64>(1)?,
                    "course_id": r.get::<_, i64>(2)?,
                    "kp_id": r.get::<_, Option<i64>>(3)?,
                    "kp_name": r.get::<_, Option<String>>(4)?,
                    "stem": r.get::<_, String>(5)?,
                    "qtype": r.get::<_, String>(6)?,
                    "options": r.get::<_, Option<String>>(7)?,
                    "answer": r.get::<_, String>(8)?,
                    "explain": r.get::<_, Option<String>>(9)?,
                    "user_answer": r.get::<_, Option<String>>(10)?,
                    "correct": r.get::<_, Option<i64>>(11)?,
                    "self_eval": r.get::<_, Option<i64>>(12)?,
                    "duration_ms": r.get::<_, Option<i64>>(13)?,
                    "confidence": r.get::<_, Option<i64>>(14)?,
                    "created_at": r.get::<_, String>(15)?,
                }))
            },
        )
        .map_err(friendly)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

// ---- 统计与画像（question_stats / profile_*） ----

/// 契约 §2.4 的一行：`accuracy` 与 `mastery` **并存**（`attempts = 0` 时 `accuracy` 为 null）。
fn stats_row(
    kp_id: Option<i64>,
    kp_name: Option<String>,
    questions: i64,
    attempts: i64,
    correct: i64,
    last_at: Option<String>,
) -> Value {
    json!({
        "kp_id": kp_id,
        "kp_name": kp_name,
        "questions": questions,
        "attempts": attempts,
        "correct": correct,
        "accuracy": accuracy_of(correct, attempts),
        "mastery": mastery_of(correct, attempts),
        "evidence": attempts,
        "last_at": last_at,
    })
}

/// 按知识点聚合的统计（返回数组）。`kp_id = null` 的一行留给**未归入知识点**的题目 ——
/// 如实单列，不硬塞给某个知识点（那是假归因）。
pub fn question_stats(conn: &Connection, course_id: i64) -> Result<Value, String> {
    let mut out: Vec<Value> = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT k.id, k.name,
                    (SELECT COUNT(*) FROM questions q WHERE q.kp_id = k.id),
                    (SELECT COUNT(*) FROM attempts a JOIN questions q ON q.id = a.question_id
                      WHERE q.kp_id = k.id),
                    (SELECT COUNT(*) FROM attempts a JOIN questions q ON q.id = a.question_id
                      WHERE q.kp_id = k.id AND a.correct = 1),
                    (SELECT MAX(a.created_at) FROM attempts a JOIN questions q ON q.id = a.question_id
                      WHERE q.kp_id = k.id)
             FROM knowledge_points k
             WHERE k.course_id = ?1
             ORDER BY k.id",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map([course_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(friendly)?;
    for row in rows {
        let (id, name, questions, attempts, correct, last_at) = row.map_err(friendly)?;
        out.push(stats_row(
            Some(id),
            Some(name),
            questions,
            attempts,
            correct,
            last_at,
        ));
    }

    let q_null: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM questions WHERE course_id = ?1 AND kp_id IS NULL",
            [course_id],
            |r| r.get(0),
        )
        .map_err(friendly)?;
    if q_null > 0 {
        let (attempts, correct, last_at): (i64, i64, Option<String>) = conn
            .query_row(
                "SELECT COUNT(*), IFNULL(SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END), 0),
                        MAX(a.created_at)
                 FROM attempts a JOIN questions q ON q.id = a.question_id
                 WHERE q.course_id = ?1 AND q.kp_id IS NULL",
                [course_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(friendly)?;
        out.push(stats_row(
            None,
            Some("未归入知识点".into()),
            q_null,
            attempts,
            correct,
            last_at,
        ));
    }
    Ok(Value::Array(out))
}

/// 画像条目列表。`course_id` 不传 = 全部；不挂知识点（`kp_id` 为 NULL）的**自述/偏好**
/// 在任何课程下都返回（它们本来就不属于某一门课）。
pub fn profile_traits_list(conn: &Connection, course_id: Option<i64>) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.kp_id, k.name, t.trait, t.value, t.evidence, t.updated_at
             FROM profile_traits t
             LEFT JOIN knowledge_points k ON k.id = t.kp_id
             WHERE (?1 IS NULL OR t.kp_id IS NULL OR k.course_id = ?1)
             ORDER BY t.trait, COALESCE(t.kp_id, 0), t.id",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map([course_id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "kp_id": r.get::<_, Option<i64>>(1)?,
                "kp_name": r.get::<_, Option<String>>(2)?,
                "trait": r.get::<_, String>(3)?,
                "value": r.get::<_, Option<f64>>(4)?,
                "evidence": r.get::<_, Option<i64>>(5)?,
                "updated_at": r.get::<_, String>(6)?,
            }))
        })
        .map_err(friendly)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

/// 写入一条画像条目（**只在本机**，不外传）。
///
/// `mastery` 是系统按作答记录算出来的**只读**口径（契约 §2.4），这里**拒收**：
/// 掌握度只能来自作答记录，不接受手工写入 —— 否则画像可以被"编"出来。
/// 用户自述缺漏请用 `weakness_self`（"你说的"），与统计结论分区展示。
/// 同一「知识点 + 条目类型」只保留一条：重复设置 = 更新，不堆历史行。
pub fn profile_trait_set(
    conn: &Connection,
    kp_id: Option<i64>,
    trait_name: &str,
    value: Option<f64>,
    evidence: Option<i64>,
) -> Result<i64, String> {
    let t = trait_name.trim();
    if !TRAIT_KINDS.contains(&t) {
        return Err(format!(
            "画像条目类型只能是 mastery / weakness_self（自述缺漏）/ preference / style，收到的是「{}」。",
            if t.is_empty() { "(空)" } else { t }
        ));
    }
    if t == "mastery" {
        return Err(
            "mastery（掌握度）由本机作答记录统计得出，是只读口径，不能手工写入；自述弱项请用 weakness_self。"
                .into(),
        );
    }
    if let Some(k) = kp_id {
        let ok = conn
            .query_row("SELECT 1 FROM knowledge_points WHERE id = ?1", [k], |_| {
                Ok(())
            })
            .is_ok();
        if !ok {
            return Err(format!(
                "知识点不存在（id={k}），可能已被删除；请刷新页面后重试。"
            ));
        }
    }
    let now = chrono::Local::now().to_rfc3339();
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM profile_traits WHERE kp_id IS ?1 AND trait = ?2 ORDER BY id LIMIT 1",
            rusqlite::params![kp_id, t],
            |r| r.get(0),
        )
        .optional()
        .map_err(friendly)?;
    if let Some(id) = existing {
        conn.execute(
            "UPDATE profile_traits SET value = ?1, evidence = ?2, updated_at = ?3 WHERE id = ?4",
            rusqlite::params![value, evidence, now, id],
        )
        .map_err(friendly)?;
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO profile_traits(kp_id, trait, value, evidence, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![kp_id, t, value, evidence, now],
    )
    .map_err(friendly)?;
    Ok(conn.last_insert_rowid())
}

/// 掌握度升序（越弱越前）；同分按 `kp_id` 稳定排序。
fn cmp_mastery(a: &Value, b: &Value) -> std::cmp::Ordering {
    let ma = a["mastery"].as_f64().unwrap_or(0.0);
    let mb = b["mastery"].as_f64().unwrap_or(0.0);
    ma.partial_cmp(&mb)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then(
            a["kp_id"]
                .as_i64()
                .unwrap_or(i64::MAX)
                .cmp(&b["kp_id"].as_i64().unwrap_or(i64::MAX)),
        )
}

/// 学习画像总览（**全部来自本机查询，无网络、无上传**）：
/// `mastery`（样本足够的统计结论）/ `weak_points`（掌握度升序前 10，**每项带 evidence**）/
/// `not_enough`（`attempts < min_evidence`，**只在这里出现**）/ `declared_gaps`（用户自述）/
/// `preferences`（偏好与风格）/ `min_evidence`。
pub fn profile_overview(conn: &Connection, course_id: i64) -> Result<Value, String> {
    let stats = question_stats(conn, course_id)?;
    let stats = stats.as_array().cloned().unwrap_or_default();

    let mut mastery: Vec<Value> = Vec::new();
    let mut not_enough: Vec<Value> = Vec::new();
    for s in &stats {
        let attempts = s["attempts"].as_i64().unwrap_or(0);
        let correct = s["correct"].as_i64().unwrap_or(0);
        if attempts < MIN_EVIDENCE {
            // 口径红线 §一 第 2 条：样本不足**不给掌握度数字、不进弱项榜**，
            // 只进 not_enough 说明"样本不足（n 次）"。
            not_enough.push(json!({
                "kp_id": s["kp_id"].clone(),
                "kp_name": s["kp_name"].clone(),
                "questions": s["questions"].clone(),
                "attempts": attempts,
                "evidence": attempts,
                "reason": format!("样本不足（{attempts} 次作答，至少需要 {MIN_EVIDENCE} 次）"),
            }));
            continue;
        }
        mastery.push(json!({
            "kp_id": s["kp_id"].clone(),
            "kp_name": s["kp_name"].clone(),
            "questions": s["questions"].clone(),
            // mastery = (correct + 1) / (attempts + 2)（拉普拉斯平滑）
            "mastery": mastery_of(correct, attempts),
            // 原始正确率，与 mastery 并存展示（attempts = 0 时为 null）
            "accuracy": accuracy_of(correct, attempts),
            // evidence = attempts：结论必须带样本数
            "evidence": attempts,
            "attempts": attempts,
            "correct": correct,
            "last_at": s["last_at"].clone(),
        }));
    }
    mastery.sort_by(cmp_mastery);

    // 弱项榜：掌握度升序取前 10（每项都带 evidence，见上面构造处）
    let mut weak_points = mastery.clone();
    weak_points.truncate(WEAK_POINTS_MAX);

    // 自述缺漏与偏好：来自 profile_traits，与系统统计**分区展示、不混淆**
    let mut declared_gaps: Vec<Value> = Vec::new();
    let mut preferences: Vec<Value> = Vec::new();
    for t in profile_traits_list(conn, Some(course_id))? {
        match t["trait"].as_str().unwrap_or("") {
            "weakness_self" => declared_gaps.push(t),
            "preference" | "style" => preferences.push(t),
            // mastery 是系统口径，不在这里当"用户自述"展示
            _ => {}
        }
    }

    Ok(json!({
        "mastery": mastery,
        "weak_points": weak_points,
        "not_enough": not_enough,
        "declared_gaps": declared_gaps,
        "preferences": preferences,
        "min_evidence": MIN_EVIDENCE,
    }))
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/// 布尔 → SQLite 整数（NOT NULL 列必须显式 0/1，不能靠 NULL 当 false）
fn flag(v: bool) -> i64 {
    if v {
        1
    } else {
        0
    }
}

/// 影响行数为 0 → 目标记录不存在（错误文本直接给用户看）
fn ensure_affected(affected: usize, what: &str, id: i64) -> Result<(), String> {
    if affected == 0 {
        return Err(format!(
            "{what}不存在（id={id}），可能已被删除；请刷新页面后重试。"
        ));
    }
    Ok(())
}

/// SQLite 原始报错 → 用户可读中文
/// （避免把 "NOT NULL constraint failed: ..." 直接抛到界面上）
pub fn friendly_db_err(raw: &str) -> String {
    if let Some(col) = raw.strip_prefix("NOT NULL constraint failed: ") {
        let name = match col.trim() {
            "courses.name" => "课程名称",
            "course_prior.topic" => "知识点名称",
            "course_prior.source" => "来源",
            "materials.file_name" => "材料文件名",
            "chat_sessions.title" => "会话标题",
            "chat_messages.role" => "消息角色",
            "chat_messages.content" => "消息内容",
            other => other,
        };
        return format!("{name}不能为空（数据列约束）；请补全后重试。");
    }
    if raw.contains("FOREIGN KEY constraint failed") {
        return "关联的课程或材料不存在（可能已被删除），请刷新页面后重试。".into();
    }
    if raw.starts_with("UNIQUE constraint failed") {
        return "该记录已存在，无需重复添加。".into();
    }
    if raw.contains("database is locked") || raw.contains("database table is locked") {
        return "数据库正被占用（可能有另一个窗口在写入），请稍后重试。".into();
    }
    if raw.contains("no such table") || raw.contains("no such column") {
        return "数据表或字段缺失，数据库可能未正确初始化；可到「设置 → 数据」从备份还原。".into();
    }
    if raw.contains("readonly") || raw.contains("read-only") {
        return "数据库为只读（可能目录权限受限或被其它程序占用），请检查数据目录权限。".into();
    }
    if raw.contains("disk I/O error") || raw.contains("disk full") {
        return "磁盘写入失败（空间不足或磁盘异常），请检查磁盘后重试。".into();
    }
    format!("数据库操作失败：{raw}")
}

fn friendly(e: rusqlite::Error) -> String {
    friendly_db_err(&e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().expect("打开内存库");
        prepare(&conn).expect("PRAGMA");
        migrate(&conn).expect("迁移应成功");
        conn
    }

    /// 表里是否存在某列（用 `PRAGMA table_info` 读真实 schema，而不是相信实现里的常量）
    fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("PRAGMA table_info");
        let mut rows = stmt.query([]).expect("query");
        while let Some(r) = rows.next().expect("next") {
            if r.get::<_, String>(1).expect("列名") == column {
                return true;
            }
        }
        false
    }

    #[test]
    fn migrate_is_idempotent_and_seeds_one_example_course() {
        let conn = mem();
        migrate(&conn).expect("重复迁移应幂等");
        let courses = courses_list(&conn).unwrap();
        assert_eq!(courses.len(), 1, "空库只播种一门示例课程");
        assert!(courses[0]["name"].as_str().unwrap().contains("示例课程"));
        // 绝不播种假知识点 / 假题目
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM course_prior", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        let q: i64 = conn
            .query_row("SELECT COUNT(*) FROM questions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(q, 0);
        // 契约要求的全部表都在
        for t in [
            "courses",
            "course_prior",
            "materials",
            "material_chunks",
            "chunks_fts",
            "chat_sessions",
            "chat_messages",
            "notes",
            "annotations",
            "knowledge_points",
            "questions",
            "attempts",
            "profile_traits",
            "pet_state",
            "focus_sessions",
            "todos",
            "settings",
            "mem_vectors",
        ] {
            let ok: bool = conn
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE name = ?1",
                    [t],
                    |_| Ok(()),
                )
                .is_ok();
            assert!(ok, "缺表：{t}");
        }
    }

    #[test]
    fn material_chunks_feed_fts_and_cascade_delete() {
        let conn = mem();
        let cid = course_create(&conn, "高等数学", Some("2026-秋"), None, None).unwrap();
        let text = "# 第一章 极限\n\n极限的定义是……\n\n## 1.1 数列极限\n\n数列极限的定义……";
        let mid = material_add(
            &conn,
            cid,
            "讲义.md",
            "D:\\x\\讲义.md",
            "md",
            Some(1024),
            "local",
            text,
            Some(2),
            Some(false),
            None,
        )
        .unwrap();
        assert!(mid > 0);
        let chunks: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM material_chunks WHERE material_id = ?1",
                [mid],
                |r| r.get(0),
            )
            .unwrap();
        assert!(chunks >= 1);
        // FTS 触发器已把块写进索引
        let hit: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chunks_fts WHERE chunks_fts MATCH ?1",
                ["数列极限"],
                |r| r.get(0),
            )
            .unwrap();
        assert!(hit >= 1, "FTS5 应能检索到材料块");
        // 删除材料 → 切块级联 + 索引同步
        material_delete(&conn, mid).unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM material_chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn chat_session_roundtrip_and_partial_course_update() {
        let conn = mem();
        let cid = course_create(&conn, "线性代数", None, Some("王老师"), None).unwrap();
        course_update(&conn, cid, Some("线性代数（重修）"), None, None, None).unwrap();
        let list = courses_list(&conn).unwrap();
        let me = list.iter().find(|c| c["id"] == cid).unwrap();
        assert_eq!(me["name"], "线性代数（重修）");
        assert_eq!(me["teacher"], "王老师", "未传的字段不应被清空");

        let sid = chat_session_create(&conn, Some(cid), "第一次提问").unwrap();
        chat_history_save(
            &conn,
            sid,
            &[
                ChatMsg {
                    role: "user".into(),
                    content: "什么是秩？".into(),
                    source_kind: Some(json!("ball_manual")),
                    refs: Some(json!([{"kind": "chunk", "id": 1}])),
                    images: Some(json!(["data:image/jpeg;base64,AAAA"])),
                },
                ChatMsg {
                    role: "assistant".into(),
                    content: "秩是……".into(),
                    source_kind: None,
                    refs: None,
                    images: None,
                },
            ],
        )
        .unwrap();
        let hist = chat_history_load(&conn, sid).unwrap();
        assert_eq!(hist.len(), 2);
        assert_eq!(hist[0]["role"], "user");
        assert_eq!(hist[0]["source_kind"], "ball_manual");
        assert!(hist[0]["refs"].as_str().unwrap().contains("chunk"));
        // R4：图片往返（回传的是**数组**，前端拿它渲染 <img src>）
        assert_eq!(hist[0]["images"][0], "data:image/jpeg;base64,AAAA");
        // 无图消息必须是 null 而不是空数组：前端要能区分"这轮没图"与"图数组为空"
        assert!(
            hist[1]["images"].is_null(),
            "无图消息的 images 必须是 null，实际是 {}",
            hist[1]["images"]
        );
        chat_session_summary_set(&conn, sid, "讨论了秩的定义").unwrap();
        let sessions = chat_sessions_list(&conn, Some(cid)).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["summary"], "讨论了秩的定义");
        assert_eq!(sessions[0]["message_count"], 2);

        chat_session_delete(&conn, sid).unwrap();
        assert!(chat_history_load(&conn, sid).unwrap().is_empty());
    }

    /// R4：图片超限必须**整条拒绝**并给可读中文错误（而不是悄悄截断或写坏库）。
    #[test]
    fn chat_images_over_hard_limit_are_rejected_with_readable_error() {
        let conn = mem();
        let sid = chat_session_create(&conn, None, "大图").unwrap();
        // 造一张"图片"：base64 串长度直接过线（内容本身无意义，只测长度判定）
        let huge = format!("data:image/jpeg;base64,{}", "A".repeat(CHAT_IMAGES_MAX_BYTES));
        let err = chat_history_save(
            &conn,
            sid,
            &[ChatMsg {
                role: "user".into(),
                content: "很大的一张图".into(),
                source_kind: None,
                refs: None,
                images: Some(json!([huge])),
            }],
        )
        .expect_err("超过 6 MB 上限时必须报错");
        assert!(
            err.contains("图片太大") && err.contains("MB"),
            "错误信息要可读并带上上限，实际：{err}"
        );
        // 整条被拒绝：不能留下半截消息（先校验后写事务）
        assert!(chat_history_load(&conn, sid).unwrap().is_empty());
    }

    /// R4：非字符串 / 非数组的 images 一律按"没有图片"处理 ——
    /// 对话落库是主链路，不能因为一个坏元素让整段对话保存失败。
    #[test]
    fn chat_images_tolerate_malformed_shapes() {
        let conn = mem();
        let sid = chat_session_create(&conn, None, "坏图").unwrap();
        chat_history_save(
            &conn,
            sid,
            &[ChatMsg {
                role: "user".into(),
                content: "形状不对的图片字段".into(),
                source_kind: None,
                refs: None,
                images: Some(json!(["", { "not": "a string" }, 42])),
            }],
        )
        .unwrap();
        let hist = chat_history_load(&conn, sid).unwrap();
        assert!(hist[0]["images"].is_null(), "非法形状应落成 null");
    }

    /// R4：悬浮球问答落库 —— 第一次新建会话、第二次复用同一个，
    /// 并且**课程不存在时退化为「不限定课程」**而不是把问答丢掉。
    #[test]
    fn ball_append_qa_creates_then_reuses_session_and_survives_bad_course() {
        let conn = mem();
        let cid = course_create(&conn, "数据结构", None, None, None).unwrap();
        let imgs = vec!["data:image/png;base64,BBBB".to_string()];

        let s1 = ball_append_qa(&conn, Some(cid), "什么是摊还分析？", "摊还分析是……", &imgs).unwrap();
        let s2 = ball_append_qa(&conn, Some(cid), "再举个例子", "比如动态数组……", &[]).unwrap();
        assert_eq!(s1, s2, "同一课程的第二次问答应复用同一个会话");

        let hist = chat_history_load(&conn, s1).unwrap();
        assert_eq!(hist.len(), 4, "两次问答 = 4 条消息");
        assert_eq!(hist[0]["role"], "user");
        assert_eq!(hist[0]["content"], "什么是摊还分析？");
        assert_eq!(hist[0]["images"][0], "data:image/png;base64,BBBB");
        assert_eq!(hist[0]["source_kind"], "ball_ask");
        assert_eq!(hist[1]["role"], "assistant");
        // 会话确实挂在这门课上，标题可辨认
        let sessions = chat_sessions_list(&conn, Some(cid)).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["title"], "悬浮球问答");

        // 不存在的课程 → 退化为「不限定课程」，问答照样落库（不能丢）
        let s3 = ball_append_qa(&conn, Some(999_999), "失效课程的提问", "回答照旧", &[]).unwrap();
        assert_ne!(s3, s1, "退化后应落到另一个（不限定课程的）会话");
        let hist3 = chat_history_load(&conn, s3).unwrap();
        assert_eq!(hist3.len(), 2);
        assert_eq!(hist3[0]["content"], "失效课程的提问");
        let no_course = chat_sessions_list(&conn, None).unwrap();
        assert!(
            no_course.iter().any(|s| s["id"] == s3 && s["course_id"].is_null()),
            "退化后的会话必须 course_id = NULL"
        );
    }

    #[test]
    fn prior_requires_source_and_delete_removes_subtree() {
        let conn = mem();
        let cid = course_create(&conn, "概率论", None, None, None).unwrap();
        assert!(prior_add(&conn, cid, None, "第一章", None, None, "  ", None, None).is_err());
        let root = prior_add(
            &conn,
            cid,
            None,
            "第一章 随机事件",
            Some("一句话要点"),
            None,
            "教材",
            Some("P1"),
            Some(0.9),
        )
        .unwrap();
        let child = prior_add(&conn, cid, Some(root), "1.1 样本空间", None, None, "user", None, None)
            .unwrap();
        let leaf = prior_add(&conn, cid, Some(child), "1.1.1 事件运算", None, None, "ai", None, Some(0.4))
            .unwrap();
        prior_verify(&conn, leaf, true).unwrap();
        let list = prior_list(&conn, cid).unwrap();
        assert_eq!(list.len(), 3);
        let verified = list.iter().find(|p| p["id"] == leaf).unwrap();
        assert_eq!(verified["verified"], 1, "verified 返回 0|1 原值");
        // 删除根节点 → 整棵子树一起走
        prior_delete(&conn, root).unwrap();
        assert!(prior_list(&conn, cid).unwrap().is_empty());
    }

    #[test]
    fn chunk_text_keeps_headings_and_hard_splits_long_text() {
        let text = "# 标题一\n\n短段落。\n\n# 标题二\n\n一段很长的话".to_string()
            + &"啊".repeat(2000);
        let chunks = chunk_text(&text);
        assert!(chunks.len() >= 3, "超长文本必须切块：{}", chunks.len());
        assert_eq!(chunks[0].0.as_deref(), Some("标题一"));
        assert!(chunks.iter().any(|(h, _)| h.as_deref() == Some("标题二")));
        assert!(
            chunks.iter().all(|(_, c)| c.chars().count() <= CHUNK_MAX),
            "单块不得超过上限"
        );
        assert!(chunk_text("   ").is_empty(), "空白文本不产生块");
    }

    #[test]
    fn settings_and_materials_text_all() {
        let conn = mem();
        set_setting(&conn, "ai.base_url", "https://api.deepseek.com").unwrap();
        set_setting(&conn, "ai.base_url", "https://api.deepseek.com/v1").unwrap();
        assert_eq!(
            get_setting(&conn, "ai.base_url").unwrap().as_deref(),
            Some("https://api.deepseek.com/v1")
        );
        assert_eq!(get_setting(&conn, "不存在").unwrap(), None);
        assert_eq!(settings_all(&conn).unwrap().len(), 1);

        let cid = course_create(&conn, "操作系统", None, None, None).unwrap();
        material_add(
            &conn, cid, "a.txt", "D:\\a.txt", "txt", None, "local", "进程与线程", None, None, None,
        )
        .unwrap();
        material_add(
            &conn,
            cid,
            "b.txt",
            "D:\\b.txt",
            "txt",
            None,
            "local",
            "死锁的四个必要条件",
            None,
            None,
            Some("本地提取"),
        )
        .unwrap();
        let all = material_text_all(&conn, cid).unwrap();
        assert!(all.contains("【材料：a.txt"));
        assert!(all.contains("进程与线程"));
        assert!(all.contains("死锁的四个必要条件"));
        assert!(all.contains("（本地提取）"));
    }

    // ---------------- M1：材料检索 ----------------

    /// 材料检索：FTS5 能命中、字段形状按契约、`score` **越大越相关**（相关度高的排在前面）。
    #[test]
    fn material_search_fts_hits_and_ranks() {
        let conn = mem();
        let cid = course_create(&conn, "机器学习", None, None, None).unwrap();
        // 材料 A：唯一关键词只出现一次
        material_add(
            &conn,
            cid,
            "绪论.md",
            "D:\\绪论.md",
            "md",
            None,
            "local",
            "绪论：本节只提一次梯度下降的基本思想，细节见后面的章节。",
            None,
            None,
            None,
        )
        .unwrap();
        // 材料 B：同一关键词密集出现（BM25 应给它更高的相关度）
        let dense = "梯度下降的收敛条件与学习率选择。".repeat(12);
        material_add(
            &conn,
            cid,
            "第4章 优化.md",
            "D:\\第4章 优化.md",
            "md",
            None,
            "local",
            &dense,
            None,
            None,
            None,
        )
        .unwrap();

        let hits = material_search(&conn, Some(cid), "梯度下降", None).unwrap();
        assert!(hits.len() >= 2, "两门材料都应命中，实际 {} 条", hits.len());

        // ① 返回字段（snake_case，与列名逐字一致）
        let first = &hits[0];
        for k in [
            "chunk_id",
            "material_id",
            "material",
            "kind",
            "seq",
            "page",
            "heading",
            "snippet",
            "score",
        ] {
            assert!(first.get(k).is_some(), "返回行缺字段 {k}：{first}");
        }
        assert_eq!(first["kind"], "md", "kind 应来自 materials.kind");
        assert!(first["material_id"].as_i64().unwrap() > 0);
        assert!(first["chunk_id"].as_i64().unwrap() > 0);
        assert_eq!(first["page"], Value::Null, "page 未解析时应为 null");

        // ② 相关度高的在前（score 降序 = 越大越相关）
        assert_eq!(
            first["material"], "第4章 优化.md",
            "关键词密集的块应排在只出现一次的前面：{hits:?}"
        );
        assert!(
            first["score"].as_f64().unwrap() > 0.0,
            "FTS 路径的 score 是 -bm25，命中时应为正数（越大越相关）：{}",
            first["score"]
        );
        assert!(
            first["snippet"].as_str().unwrap().contains("梯度下降"),
            "片段必须以命中关键词为中心裁出来：{}",
            first["snippet"]
        );
        for w in hits.windows(2) {
            let (a, b) = (
                w[0]["score"].as_f64().unwrap(),
                w[1]["score"].as_f64().unwrap(),
            );
            assert!(a >= b, "score 必须降序（越大越相关）：{a} < {b}");
        }

        // ③ courseId 过滤 / 全库检索
        let other = course_create(&conn, "大学英语", None, None, None).unwrap();
        assert!(
            material_search(&conn, Some(other), "梯度下降", None)
                .unwrap()
                .is_empty(),
            "按课程过滤后不应命中别的课程的材料"
        );
        assert!(
            !material_search(&conn, None, "梯度下降", None).unwrap().is_empty(),
            "courseId 为 None 时应全库检索"
        );
    }

    /// **本任务最容易做错的点**：两字中文查询 —— trigram 分词器命不中，
    /// 必须靠 LIKE 兜底仍能命中（若实现只走 FTS，这条会红）。
    #[test]
    fn material_search_two_char_query_falls_back_to_like() {
        let conn = mem();
        let cid = course_create(&conn, "高等数学", None, None, None).unwrap();
        // 材料一：关键词出现在**正文**
        material_add(
            &conn,
            cid,
            "极限讲义.md",
            "D:\\极限讲义.md",
            "md",
            None,
            "local",
            "# 2.1 导引\n\n极限描述的是函数在自变量趋近某值时的变化趋势。",
            None,
            None,
            None,
        )
        .unwrap();
        // 材料二：关键词**只在标题**（正文刻意不含），验证 heading 也参与兜底匹配
        material_add(
            &conn,
            cid,
            "运算法则.md",
            "D:\\运算法则.md",
            "md",
            None,
            "local",
            "# 极限的运算法则\n\n函数在趋近过程中遵循四则运算规律。",
            None,
            None,
            None,
        )
        .unwrap();

        // 先确认前提：FTS 侧对两字查询确实命不中（否则这条测试没验证到兜底路径）
        let fts_hits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chunks_fts WHERE chunks_fts MATCH ?1",
                ["极限"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            fts_hits, 0,
            "trigram 分词器对 2 字查询本就不该命中；若这里不为 0，说明前提已变"
        );

        let hits = material_search(&conn, Some(cid), "极限", None).unwrap();
        assert_eq!(hits.len(), 2, "两字中文查询必须靠 LIKE 兜底命中：{hits:?}");
        for h in &hits {
            assert_eq!(h["score"].as_f64().unwrap(), 0.0, "LIKE 路径 score 固定 0");
        }
        let by_content = hits
            .iter()
            .find(|h| h["material"] == "极限讲义.md")
            .expect("正文含关键词的材料必须命中");
        assert!(by_content["snippet"].as_str().unwrap().contains("极限"));
        let by_heading = hits
            .iter()
            .find(|h| h["material"] == "运算法则.md")
            .expect("关键词只在标题的材料也必须命中");
        assert_eq!(by_heading["heading"], "极限的运算法则");
        // LIKE 路径按 material_id, seq 稳定排序
        assert_eq!(hits[0]["material"], "极限讲义.md");
    }

    /// 空 / 空白查询直接返回 `[]`（不返回全量）；limit 边界收敛；
    /// 超长中文正文裁切后仍是合法 UTF-8（不 panic、长度受控）。
    #[test]
    fn material_search_empty_query_returns_empty() {
        let conn = mem();
        let cid = course_create(&conn, "大学物理", None, None, None).unwrap();
        material_add(
            &conn,
            cid,
            "力学.md",
            "D:\\力学.md",
            "md",
            None,
            "local",
            "牛顿三定律是经典力学的基础。",
            None,
            None,
            None,
        )
        .unwrap();

        for q in ["", "   ", "\t\n "] {
            assert!(
                material_search(&conn, Some(cid), q, None).unwrap().is_empty(),
                "空查询不应返回全量：{q:?}"
            );
            assert!(material_search(&conn, None, q, Some(5)).unwrap().is_empty());
        }

        // limit：< 1 按 1、超上限按 50 截断（不 panic、不返回超过库里的条数）
        assert_eq!(
            material_search(&conn, Some(cid), "牛顿", Some(0)).unwrap().len(),
            1,
            "limit < 1 应按 1 处理"
        );
        assert_eq!(
            material_search(&conn, Some(cid), "牛顿", Some(999)).unwrap().len(),
            1
        );

        // 超长中文（多字节）正文：切块 + 片段裁切都不能切坏 UTF-8
        let long = "牛顿第一定律描述惯性。".repeat(120);
        material_add(
            &conn, cid, "长文.md", "D:\\长文.md", "md", None, "local", &long, None, None, None,
        )
        .unwrap();
        let hits = material_search(&conn, Some(cid), "牛顿第一定律", Some(50)).unwrap();
        let hit = hits
            .iter()
            .find(|h| h["material"] == "长文.md")
            .expect("超长材料也应能命中");
        let snip = hit["snippet"].as_str().unwrap();
        assert!(snip.contains("牛顿第一定律"), "片段应含关键词：{snip}");
        assert!(
            snip.chars().count() <= 2 * SNIPPET_HALF + 10,
            "片段长度应受控（约 200 字），实际 {}",
            snip.chars().count()
        );
    }

    /// limit 口径（契约 §2.1）：默认 8、上限 50、小于 1 按 1。
    #[test]
    fn material_search_limit_defaults_and_cap() {
        let conn = mem();
        let cid = course_create(&conn, "理论力学", None, None, None).unwrap();
        // 造 60 个都命中「牛顿第二定律」的块（每段约 720 字 → 各自成块）
        let mut blob = String::new();
        for _ in 0..60 {
            blob.push_str(&"牛顿第二定律的描述段落。".repeat(60));
            blob.push_str("\n\n");
        }
        material_add(
            &conn, cid, "大量块.md", "D:\\大量块.md", "md", None, "local", &blob, None, None, None,
        )
        .unwrap();
        let chunks: i64 = conn
            .query_row("SELECT COUNT(*) FROM material_chunks", [], |r| r.get(0))
            .unwrap();
        assert!(chunks >= 60, "测试前置：至少要造出 60 个块，实际 {chunks}");

        let q = "牛顿第二定律";
        assert_eq!(
            material_search(&conn, Some(cid), q, None).unwrap().len(),
            8,
            "limit 省略时应默认 8 条"
        );
        assert_eq!(
            material_search(&conn, Some(cid), q, Some(999)).unwrap().len(),
            50,
            "超过上限时按 50 截断"
        );
        assert_eq!(material_search(&conn, Some(cid), q, Some(3)).unwrap().len(), 3);
    }

    // ---------------- M2：多关键词 OR 召回 ----------------

    /// **本任务最容易做错的点之一**：多词查询必须是 **OR 召回**。
    /// 两块材料各只含其中一个词 —— 只做 AND（返回空）或只取首词（只回一块）的实现会当场变红。
    /// 分两条路径各钉一次：≥3 字词走 FTS5 的 `"w1" OR "w2"`，2 字词走 LIKE 的 OR 兜底。
    #[test]
    fn material_search_multi_keyword_or_recall() {
        let conn = mem();
        let cid = course_create(&conn, "机器学习", None, None, None).unwrap();
        // 两个 ≥3 字的词，各占一块材料（彼此都不含对方的词）
        material_add(
            &conn, cid, "A优化.md", "D:\\A优化.md", "md", None, "local",
            "本段只讨论梯度下降的收敛速度。", None, None, None,
        )
        .unwrap();
        material_add(
            &conn, cid, "B调参.md", "D:\\B调参.md", "md", None, "local",
            "本段只讨论学习率的取值范围。", None, None, None,
        )
        .unwrap();
        // 空格分隔（FTS 路径：两个词都 ≥3 字）
        let hits = material_search(&conn, Some(cid), "梯度下降 学习率", None).unwrap();
        let names: Vec<&str> = hits.iter().map(|h| h["material"].as_str().unwrap()).collect();
        assert!(
            names.contains(&"A优化.md") && names.contains(&"B调参.md"),
            "多词必须 OR 召回：两块材料都要回，实际 {names:?}"
        );

        // 两个 2 字词，各占一块材料（trigram 命不中 → 必须靠 LIKE 的多词 OR）
        material_add(
            &conn, cid, "C极限.md", "D:\\C极限.md", "md", None, "local",
            "这一段讲的是极限的直观含义。", None, None, None,
        )
        .unwrap();
        material_add(
            &conn, cid, "D导数.md", "D:\\D导数.md", "md", None, "local",
            "这一段讲的是导数的几何含义。", None, None, None,
        )
        .unwrap();
        // 逗号分隔（LIKE 路径：两个词都只有 2 字）
        let hits2 = material_search(&conn, Some(cid), "极限,导数", None).unwrap();
        let names2: Vec<&str> = hits2.iter().map(|h| h["material"].as_str().unwrap()).collect();
        assert!(
            names2.contains(&"C极限.md") && names2.contains(&"D导数.md"),
            "2 字词必须走 LIKE 的 OR 兜底把两块都召回，实际 {names2:?}"
        );
        for h in &hits2 {
            assert_eq!(h["score"].as_f64().unwrap(), 0.0, "LIKE 路径 score 固定 0");
        }
    }

    /// 查询里带 FTS5 语法字符（`-` `*` `"` `(` `)`）**不得报错**，且仍要给出结果。
    /// 实现若把词裸拼进 `MATCH`（不加双引号），这里会直接抛 `fts5: syntax error`
    /// —— 检索是旁路能力，炸掉就等于把整条「就课程材料提问」链路带崩。
    #[test]
    fn material_search_survives_fts_syntax_chars() {
        let conn = mem();
        let cid = course_create(&conn, "信息检索", None, None, None).unwrap();
        material_add(
            &conn, cid, "语料.md", "D:\\语料.md", "md", None, "local",
            "学习率的取值影响收敛速度，反向传播-bp 是常见叫法。", None, None, None,
        )
        .unwrap();

        // ① 语法字符当独立 token：`-` `*` `"` `(` `)` 都被切掉或丢弃，剩下的正常词仍能检索
        for q in [
            "学习率 - \"*\" (反向传播)",
            "学习率* (反向传播) -",
            "\"学习率\"-(反向传播)",
        ] {
            let hits = material_search(&conn, Some(cid), q, None)
                .unwrap_or_else(|e| panic!("查询 {q:?} 不得报错：{e}"));
            assert!(!hits.is_empty(), "查询 {q:?} 仍应给出结果");
            for h in &hits {
                assert!(h["terms"].is_array(), "每行都要带 terms：{h}");
            }
        }

        // ② 语法字符落在**词内部**（`-` 不是分隔符）：加引号后 FTS 不报错，LIKE 也能字面兜底
        let hits = material_search(&conn, Some(cid), "反向传播-bp", None)
            .expect("词内含连字符不得报错");
        assert!(!hits.is_empty(), "词内含连字符时仍应字面命中：{hits:?}");

        // ③ 整条查询都是语法字符 → 切不出 ≥2 字的词 → 返回空数组（不是错误、也不是全量）
        let hits = material_search(&conn, Some(cid), "\"(( * -", None).expect("纯语法字符不得报错");
        assert!(hits.is_empty(), "没有可用检索词时应返回 []，而不是全量：{hits:?}");
    }

    /// 返回行必须新增 `terms`，且它是**已去重、已剔除长度 <2 字**的实际使用词列表；
    /// 同时 M1 的 9 个字段一个都不能少、不能改名。
    #[test]
    fn material_search_response_includes_terms() {
        let conn = mem();
        let cid = course_create(&conn, "数据科学", None, None, None).unwrap();
        material_add(
            &conn, cid, "T.md", "D:\\T.md", "md", None, "local",
            "梯度下降与学习率的配合决定收敛速度。", None, None, None,
        )
        .unwrap();

        let hits = material_search(&conn, Some(cid), "梯度下降, 的, 梯度下降, 学习率", None).unwrap();
        assert!(!hits.is_empty(), "至少应命中一条");
        let first = &hits[0];

        // M1 冻结的 9 个字段：一个都不能少
        for k in [
            "chunk_id",
            "material_id",
            "material",
            "kind",
            "seq",
            "page",
            "heading",
            "snippet",
            "score",
        ] {
            assert!(first.get(k).is_some(), "返回行缺 M1 字段 {k}：{first}");
        }

        let terms = first["terms"].as_array().expect("返回行必须含 terms 数组");
        let got: Vec<&str> = terms.iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(
            got,
            vec!["梯度下降", "学习率"],
            "terms 应去重（大小写不敏感）并剔除长度 <2 的词"
        );
        assert!(
            terms.iter().all(|v| v.as_str().unwrap().chars().count() >= 2),
            "terms 里不允许有单字词：{terms:?}"
        );
    }

    /// 分词器本身的四条口径：大小写不敏感去重、丢弃 1 字词、标点/空白切分、最多 8 个。
    #[test]
    fn split_terms_dedups_and_caps() {
        // 去重：大小写不敏感，保留**首次出现**的写法
        assert_eq!(split_terms("CNN cnn Cnn 卷积"), vec!["CNN", "卷积"]);
        // 丢弃 1 字词（中文单字与单个字母都算）
        assert_eq!(split_terms("的 是 a 学习 极限"), vec!["学习", "极限"]);
        // 中英文标点与空白都是分隔符（中文标点不带进词里）
        assert_eq!(
            split_terms("梯度下降，学习率；正则化。"),
            vec!["梯度下降", "学习率", "正则化"]
        );
        // 去首尾空白：词两端不留空格
        assert_eq!(split_terms("  梯度下降  \t 学习率  "), vec!["梯度下降", "学习率"]);
        // 最多 8 个（按出现顺序取前 8）
        let many = "a1 a2 a3 a4 a5 a6 a7 a8 a9 a10";
        let capped = split_terms(many);
        assert_eq!(capped.len(), 8, "最多只取前 8 个词：{capped:?}");
        assert_eq!(capped, vec!["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]);
        // 空 / 纯标点 / 纯单字 → 没有可用词
        assert!(split_terms("").is_empty());
        assert!(split_terms("   ").is_empty());
        assert!(split_terms("，。；：！？").is_empty());
        assert!(split_terms("a b c").is_empty(), "全是 1 字词等于没有检索词");
    }

    // ---------------- 集成阶段补的两个修复（回归） ----------------

    /// **召回漏洞回归：混合长度多词查询必须 FTS ∪ LIKE 合并。**
    ///
    /// 中文 2 字词极常见（极限 / 导数 / 矩阵 / 概率 …），而 trigram 的 FTS 只吃 ≥3 字的词。
    /// 旧实现「只有 FTS 0 命中时才走 LIKE」会把这些块**静默丢掉**：
    /// 查询 `"极限 梯度下降"` 时 FTS 只查「梯度下降」，一旦命中就不再走 LIKE，
    /// 于是"只含极限"的那块材料永远检不到 —— 用户明明有相关材料却检不到。
    #[test]
    fn material_search_mixed_length_terms_unions_fts_and_like() {
        let conn = mem();
        let cid = course_create(&conn, "高等数学", None, None, None).unwrap();
        material_add(
            &conn,
            cid,
            "A极限.md",
            "D:\\A极限.md",
            "md",
            None,
            "local",
            "本段只讲极限的定义与性质。",
            None,
            None,
            None,
        )
        .unwrap();
        material_add(
            &conn,
            cid,
            "B梯度.md",
            "D:\\B梯度.md",
            "md",
            None,
            "local",
            "本段只讲梯度下降的收敛速度。",
            None,
            None,
            None,
        )
        .unwrap();

        // 一个 2 字词 + 一个 4 字词：FTS 只会拿「梯度下降」去查
        let hits = material_search(&conn, Some(cid), "极限 梯度下降", None).unwrap();
        let names: Vec<&str> = hits
            .iter()
            .map(|h| h["material"].as_str().unwrap())
            .collect();
        assert!(
            names.contains(&"B梯度.md"),
            "命中 ≥3 字词的块要在结果里，实际 {names:?}"
        );
        assert!(
            names.contains(&"A极限.md"),
            "只命中 2 字词「极限」的块必须被 LIKE 补齐回来，实际 {names:?}"
        );

        // 不变量：**同一次响应里所有行的 `terms` 必须一致**。
        // FTS 路径的 MATCH 表达式只用了 ≥3 字词，但返回的 `terms` 是全量词表；
        // 若两条路径各回各的词表，同一次检索里不同行的高亮词就会忽多忽少（前端依赖它）。
        let t0 = hits[0]["terms"].clone();
        assert!(
            hits.iter().all(|h| h["terms"] == t0),
            "同一响应各行的 terms 必须一致，实际：{hits:?}"
        );
        assert_eq!(t0, serde_json::json!(["极限", "梯度下降"]), "terms 应是全量词表且按出现顺序");

        // 机制反证：limit=1 时 FTS 已占满名额 → 不再补齐，只回 FTS 的命中。
        // 这既覆盖了"占满即停"的分支，也正好复现了**修复前的行为**
        //（旧实现永远只有 FTS 结果，所以 A 永远检不到）。
        let one = material_search(&conn, Some(cid), "极限 梯度下降", Some(1)).unwrap();
        assert_eq!(one.len(), 1, "limit=1 时只应有一条");
        assert_eq!(
            one[0]["material"].as_str().unwrap(),
            "B梯度.md",
            "占满名额时补齐不再发生，回的应是 FTS 命中（这也正是修复前丢掉 A 的原因）"
        );
    }

    /// **大小写不敏感定位回归**：FTS 的匹配不区分大小写，snippet 定位也必须如此。
    ///
    /// 旧实现用大小写敏感的 `str::find`：查询 `CNN` 命中 `cnn` 时定位失败，
    /// snippet 退成"前 200 字"窗口 —— 用户看到的片段里没有命中词，高亮也无从下手。
    #[test]
    fn snippet_around_is_case_insensitive() {
        // 命中点放在 250 字之后：若定位失败退回"前 200 字"窗口，就**不会**包含 cnn
        let content = format!("{}cnn{}", "甲".repeat(250), "乙".repeat(250));
        let sn = snippet_around(&content, &["CNN".to_string()]);
        assert!(
            sn.contains("cnn"),
            "查询 CNN 命中 cnn 时必须定位到命中处，而不是退回开头窗口；实际片段开头：{}",
            sn.chars().take(40).collect::<String>()
        );
        assert!(sn.starts_with('…'), "命中点在中部时片段应带省略号");

        // 中文词仍按字面定位
        let c2 = format!("{}梯度下降{}", "甲".repeat(250), "乙".repeat(250));
        assert!(snippet_around(&c2, &["梯度下降".to_string()]).contains("梯度下降"));

        // 都没命中 → 退回开头窗口（既有行为不变）
        let sn3 = snippet_around("很短的一段话", &["不存在的词".to_string()]);
        assert_eq!(sn3, "很短的一段话");
    }

    // ---------------- M3：迁移 / 笔记 / 批注 / 番茄钟 ----------------

    /// ① 两列新字段的**幂等迁移**：新库重复迁移不报错、旧库形状能平滑补齐。
    ///
    /// 契约 §2.1：`annotations.block_index` 允许 NULL（旧数据没有块序号，
    /// 必须能与"块序号就是 0"区分开）；`notes.source` 默认 `'user'`
    /// （老笔记无法证明是 AI 整理的，补列时**不能反过来假装**）。
    #[test]
    fn ensure_column_is_idempotent_for_new_columns() {
        // ---- ① 新库：migrate 跑三遍都不报错，两列都在 ----
        let conn = mem();
        migrate(&conn).expect("第二次迁移应幂等");
        migrate(&conn).expect("第三次迁移也应幂等");
        assert!(
            has_column(&conn, "annotations", "block_index"),
            "annotations 缺 block_index 列"
        );
        assert!(has_column(&conn, "notes", "source"), "notes 缺 source 列");

        // ---- ② 旧库形状（M0/M2 的库：这两列都不存在）→ migrate 必须补列，而不是报错 ----
        let old = Connection::open_in_memory().unwrap();
        prepare(&old).unwrap();
        old.execute_batch(
            "CREATE TABLE notes (
                 id         INTEGER PRIMARY KEY AUTOINCREMENT,
                 course_id  INTEGER NOT NULL,
                 session_id INTEGER,
                 title      TEXT NOT NULL,
                 content_md TEXT NOT NULL,
                 date       TEXT,
                 exported   TEXT,
                 created_at TEXT NOT NULL
             );
             CREATE TABLE annotations (
                 id          INTEGER PRIMARY KEY AUTOINCREMENT,
                 target_kind TEXT NOT NULL,
                 target_id   INTEGER NOT NULL,
                 quote       TEXT,
                 start_off   INTEGER,
                 end_off     INTEGER,
                 color       TEXT,
                 comment     TEXT,
                 created_at  TEXT NOT NULL
             );",
        )
        .unwrap();
        old.execute(
            "INSERT INTO notes(course_id, session_id, title, content_md, date, created_at)
             VALUES (1, NULL, 'M2 时期的老笔记', '老正文', '2026-01-01', '2026-01-01T09:00:00+08:00')",
            [],
        )
        .unwrap();
        old.execute(
            "INSERT INTO annotations(target_kind, target_id, quote, start_off, end_off, color, created_at)
             VALUES ('note', 1, '老批注', 0, 3, 'yellow', '2026-01-01T09:00:00+08:00')",
            [],
        )
        .unwrap();

        migrate(&old).expect("旧库升级不得报错");
        assert!(has_column(&old, "annotations", "block_index"));
        assert!(has_column(&old, "notes", "source"));

        // 旧数据的 source 落到默认值 'user'：不假装是 AI 整理的
        let src: Option<String> = old
            .query_row("SELECT source FROM notes WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            src.as_deref(),
            Some("user"),
            "旧笔记补列后必须落到默认来源 'user'"
        );
        let list = notes_list(&old, None).unwrap();
        assert_eq!(list[0]["source"], "user", "列表接口同样按 'user' 如实回传");

        // 旧批注的 block_index 允许为 NULL（前端据此把它归入「已失效的批注」）
        let annos = annotations_list(&old, "note", 1).unwrap();
        assert_eq!(annos.len(), 1);
        assert!(
            annos[0]["block_index"].is_null(),
            "旧批注的 block_index 必须是 NULL，而不是被默认成 0：{annos:?}"
        );
    }

    /// ② 笔记 CRUD 往返：保存（含来源）→ 列表带 `content_len` 且**不带全文** →
    /// 详情全文一字不差 → 局部更新 → 删除后取不到。
    #[test]
    fn note_crud_roundtrip() {
        let conn = mem();
        let cid = course_create(&conn, "数据结构", None, None, None).unwrap();
        let sid = chat_session_create(&conn, Some(cid), "今天讲了红黑树").unwrap();
        let body = "# 红黑树\n\n- 五个性质\n- 插入修复：变色 + 旋转\n\n```c\nrotate_left(root);\n```\n";

        let nid = note_save(
            &conn,
            cid,
            Some(sid),
            "  红黑树笔记  ",
            body,
            None,
            "ai_session",
        )
        .unwrap();

        // 列表：字段齐全、带 content_len、**不含全文**
        let list = notes_list(&conn, Some(cid)).unwrap();
        assert_eq!(list.len(), 1);
        let row = &list[0];
        assert_eq!(row["id"], nid);
        assert_eq!(row["course_id"], cid);
        assert_eq!(row["session_id"], sid);
        assert_eq!(row["title"], "红黑树笔记", "标题应去掉首尾空白");
        assert_eq!(row["source"], "ai_session");
        assert!(row["exported"].is_null());
        assert_eq!(
            row["content_len"].as_i64().unwrap(),
            body.chars().count() as i64,
            "content_len 必须是字符数（不是字节数）"
        );
        assert!(
            row.get("content_md").is_none(),
            "列表接口不得把全文塞进来：{row}"
        );
        assert_eq!(
            row["date"].as_str().unwrap().chars().count(),
            10,
            "未传 date 时按本地今天（YYYY-MM-DD）：{}",
            row["date"]
        );
        assert!(row["created_at"].as_str().unwrap().contains('T'));

        // 详情：全文一字不差
        let got = note_get(&conn, nid).unwrap();
        assert_eq!(got["content_md"], body);
        assert_eq!(got["content_len"].as_i64().unwrap(), body.chars().count() as i64);

        // 按课程过滤（笔记属于别的课程时不该串进来）
        let other = course_create(&conn, "大学英语", None, None, None).unwrap();
        assert!(notes_list(&conn, Some(other)).unwrap().is_empty());
        assert_eq!(notes_list(&conn, None).unwrap().len(), 1, "不传 courseId = 全部");

        // 更新：标题 + 正文；来源不得被顺手改掉
        note_update(&conn, nid, Some("红黑树笔记（修订）"), Some("正文已改")).unwrap();
        let got = note_get(&conn, nid).unwrap();
        assert_eq!(got["title"], "红黑树笔记（修订）");
        assert_eq!(got["content_md"], "正文已改");
        assert_eq!(got["source"], "ai_session", "更新不得改动来源");
        // 只改标题 → 正文不动（局部更新语义）
        note_update(&conn, nid, Some("再改一次"), None).unwrap();
        assert_eq!(note_get(&conn, nid).unwrap()["content_md"], "正文已改");
        assert!(note_update(&conn, nid, Some("   "), None).is_err(), "空标题必须报错");
        // 显式 date 落库
        let d2 = note_save(&conn, cid, None, "带日期的笔记", "x", Some(" 2026-03-01 "), "user").unwrap();
        assert_eq!(note_get(&conn, d2).unwrap()["date"], "2026-03-01");

        // 非法来源：给可读中文错误，且**不入库**
        let e = note_save(&conn, cid, None, "标题", "x", None, "ai").unwrap_err();
        assert!(
            e.contains("ai_session") && e.contains("user"),
            "错误信息必须写清合法取值：{e}"
        );
        assert!(note_save(&conn, cid, None, "  ", "x", None, "user").is_err());
        assert_eq!(notes_list(&conn, Some(cid)).unwrap().len(), 2, "非法来源不得静默入库");

        // 删除后取不到
        note_delete(&conn, nid).unwrap();
        assert!(note_get(&conn, nid).is_err(), "删除后 note_get 应报错");
        assert!(note_delete(&conn, nid).is_err(), "重复删除应给可读错误");
        assert_eq!(notes_list(&conn, Some(cid)).unwrap().len(), 1);
    }

    /// ③ 批注必须**带着 `block_index` 进出**（本轮锚点的核心）。
    /// 只回传字符偏移的实现会在这条测试上红。
    #[test]
    fn annotation_keeps_block_index() {
        let conn = mem();
        let cid = course_create(&conn, "编译原理", None, None, None).unwrap();
        let nid = note_save(
            &conn,
            cid,
            None,
            "第一章 词法分析",
            "# 第一章\n\n词法分析把字符流切成记号流，再由语法分析组装成语法树。",
            None,
            "user",
        )
        .unwrap();

        // 锚点：块序号 3 + 块内偏移 12~16 + 原文片段
        let aid = annotation_add(
            &conn,
            "note",
            nid,
            3,
            "词法分析",
            12,
            16,
            Some("green"),
            Some("考试要考"),
        )
        .unwrap();
        let list = annotations_list(&conn, "note", nid).unwrap();
        assert_eq!(list.len(), 1);
        let a = &list[0];
        assert_eq!(a["id"], aid);
        assert_eq!(a["target_kind"], "note");
        assert_eq!(a["target_id"], nid);
        assert_eq!(a["block_index"], 3, "block_index 必须原样带回");
        assert_eq!(a["start_off"], 12);
        assert_eq!(a["end_off"], 16);
        assert_eq!(a["quote"], "词法分析");
        assert_eq!(a["color"], "green");
        assert_eq!(a["comment"], "考试要考");

        // 第二条批注：另一个块（0），未传颜色 → 默认色；列表按块序返回
        let bid = annotation_add(&conn, "note", nid, 0, "字符流", 0, 3, None, None).unwrap();
        let list = annotations_list(&conn, "note", nid).unwrap();
        let blocks: Vec<Option<i64>> = list
            .iter()
            .map(|x| x["block_index"].as_i64())
            .collect();
        assert_eq!(blocks, vec![Some(0), Some(3)], "按块序号升序返回");
        assert_eq!(list[0]["color"], "yellow", "未传颜色给默认值");

        // 别的目标 / 别的对象互不串台
        assert!(annotations_list(&conn, "note", 999).unwrap().is_empty());
        assert!(annotations_list(&conn, "material", nid).unwrap().is_empty());

        // 更新备注与颜色：**锚点一个都不能被动**
        annotation_update(&conn, aid, Some("blue"), Some("改过的备注")).unwrap();
        let a2 = annotations_list(&conn, "note", nid)
            .unwrap()
            .into_iter()
            .find(|x| x["id"] == aid)
            .unwrap();
        assert_eq!(a2["color"], "blue");
        assert_eq!(a2["comment"], "改过的备注");
        assert_eq!(a2["block_index"], 3, "改备注不得动锚点");
        assert_eq!(a2["start_off"], 12);
        assert_eq!(a2["end_off"], 16);
        assert_eq!(a2["quote"], "词法分析");
        assert!(annotation_update(&conn, aid, Some("  "), None).is_err(), "空颜色必须报错");

        // 非法锚点：宁可报错，也不写一条定位不了的数据
        assert!(annotation_add(&conn, "note", nid, -1, "x", 0, 1, None, None).is_err());
        assert!(annotation_add(&conn, "note", nid, 0, "   ", 0, 1, None, None).is_err());
        assert!(annotation_add(&conn, "note", nid, 0, "x", 5, 2, None, None).is_err());
        assert!(annotation_add(&conn, "note", nid, 0, "x", -1, 1, None, None).is_err());
        assert_eq!(annotations_list(&conn, "note", nid).unwrap().len(), 2);

        // 删除
        annotation_delete(&conn, aid).unwrap();
        assert!(!annotations_list(&conn, "note", nid)
            .unwrap()
            .iter()
            .any(|x| x["id"] == aid));
        assert!(annotation_delete(&conn, aid).is_err(), "重复删除应给可读错误");
        let _ = bid;

        // 删笔记 → 它的批注一起走，不留孤儿
        note_delete(&conn, nid).unwrap();
        assert!(annotations_list(&conn, "note", nid).unwrap().is_empty());
    }

    /// ④ `focus_stats` 必须按**本地日期**分桶。
    ///
    /// 本机是 UTC+8：**凌晨 00:30 的本地时间在 UTC 下属于前一天** —— 若实现写成
    /// `dt.date_naive()`（UTC 日期），`today_min` 会少掉这一段，这条断言必然变红。
    /// 同时造一条晚间 23:30（负时区如 UTC-5 下会跨到次日 UTC），两个方向都钉住。
    #[test]
    fn focus_stats_buckets_by_local_date() {
        use chrono::TimeZone as _;

        let conn = mem();
        let today = chrono::Local::now().date_naive();
        let yesterday = today - chrono::Duration::days(1);

        // focus_start 只会写"现在"，造历史数据只能直接插库（带明确的本机时区偏移）
        let insert = |d: chrono::NaiveDate,
                      hour: u32,
                      min: u32,
                      kind: &str,
                      plan: i64,
                      actual: Option<i64>|
         -> i64 {
            let naive = d.and_hms_opt(hour, min, 0).expect("合法时间");
            let started_at = match chrono::Local.from_local_datetime(&naive) {
                chrono::LocalResult::Single(dt) => dt.to_rfc3339(),
                chrono::LocalResult::Ambiguous(dt, _) => dt.to_rfc3339(),
                chrono::LocalResult::None => naive.format("%Y-%m-%dT%H:%M:%S").to_string(),
            };
            conn.execute(
                "INSERT INTO focus_sessions(course_id, kind, plan_min, actual_min, completed, started_at, ended_at)
                 VALUES (NULL, ?1, ?2, ?3, ?4, ?5, NULL)",
                rusqlite::params![
                    kind,
                    plan,
                    actual,
                    if actual.is_some() { 1 } else { 0 },
                    started_at
                ],
            )
            .unwrap();
            conn.last_insert_rowid()
        };

        // 今天凌晨（UTC 视角是昨天）+ 今天晚间（负时区视角是明天）
        insert(today, 0, 30, "focus", 25, Some(25));
        let late = insert(today, 23, 30, "focus", 30, None);
        focus_finish(&conn, late, 30, true).unwrap(); // 走一遍真实的结束路径
        // 昨天晚上
        insert(yesterday, 23, 50, "focus", 15, Some(15));
        // 休息段：不该计入专注时长
        insert(today, 12, 0, "break", 5, Some(5));
        // 未结束的专注段：算场次，但不贡献分钟数
        insert(today, 14, 0, "focus", 50, None);

        let s = focus_stats(&conn, None).unwrap();
        assert_eq!(
            s["today_min"], 55,
            "今天 = 凌晨 25 + 晚间 30，且按**本地日期**分桶：{s}"
        );
        assert_eq!(
            s["sessions"], 4,
            "窗口内 focus 段共 4 条（含 1 条未结束；break 不算）：{s}"
        );

        let by_day = s["by_day"].as_array().unwrap();
        assert_eq!(by_day.len(), 7, "默认近 7 天，逐日分桶（没有记录的日期也要给 0）");
        let min_of = |d: chrono::NaiveDate| -> i64 {
            let key = d.format("%Y-%m-%d").to_string();
            by_day
                .iter()
                .find(|r| r["date"] == Value::String(key.clone()))
                .unwrap_or_else(|| panic!("by_day 缺日期 {key}：{by_day:?}"))["min"]
                .as_i64()
                .unwrap()
        };
        assert_eq!(min_of(today), 55, "今天的桶：{by_day:?}");
        assert_eq!(min_of(yesterday), 15, "昨天的桶：{by_day:?}");
        assert_eq!(
            by_day[by_day.len() - 1]["date"],
            Value::String(today.format("%Y-%m-%d").to_string()),
            "日期升序，最后一天是今天"
        );
        let sum: i64 = by_day.iter().map(|r| r["min"].as_i64().unwrap()).sum();
        assert_eq!(s["week_min"], sum, "默认 days=7 时 week_min 就是逐日之和");
        assert_eq!(s["week_min"], 70);

        // 窗口收窄：days=1 只剩今天；week_min 仍按最近 7 天（字段名说的是"周"）
        let s1 = focus_stats(&conn, Some(1)).unwrap();
        assert_eq!(s1["by_day"].as_array().unwrap().len(), 1);
        assert_eq!(s1["today_min"], 55);
        assert_eq!(s1["sessions"], 3, "days=1 只数今天的 3 条 focus 段");
        assert_eq!(s1["week_min"], 70, "week_min 固定看最近 7 天");

        // 非法 days 收敛到边界，不 panic
        assert_eq!(
            focus_stats(&conn, Some(0)).unwrap()["by_day"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            focus_stats(&conn, Some(99_999)).unwrap()["by_day"]
                .as_array()
                .unwrap()
                .len(),
            365
        );
    }

    /// ④b 番茄钟全流程：非法 `kind` 必须报错（**不能静默入库**，否则统计里会多出无法解释的时长）、
    /// `kind` 规范化（首尾空白 + 大小写）、列表/结束/错误分支、倒序与 limit 边界。
    ///
    /// 命名说明：原名 `focus_start_rejects_unknown_kind` 只描述了本测试的一小部分，已改为与内容相符。
    #[test]
    fn focus_crud_validation_and_limit() {
        let conn = mem();
        let cid = course_create(&conn, "离散数学", None, None, None).unwrap();

        let e = focus_start(&conn, Some(cid), "pomodoro", 25).unwrap_err();
        assert!(
            e.contains("focus") && e.contains("break"),
            "错误信息要写清合法取值：{e}"
        );
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM focus_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "非法 kind 绝不能静默入库");
        assert!(focus_start(&conn, Some(cid), "focus", 0).is_err(), "计划时长至少 1 分钟");

        // 合法值：容忍首尾空白与大小写
        let id = focus_start(&conn, Some(cid), " FOCUS ", 25).unwrap();
        let list = focus_list(&conn, None).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["kind"], "focus", "kind 应规范化成小写");
        assert_eq!(list[0]["plan_min"], 25);
        assert_eq!(list[0]["course_id"], cid);
        assert!(list[0]["actual_min"].is_null(), "未结束的段没有实际时长");
        assert!(list[0]["ended_at"].is_null());
        assert_eq!(list[0]["completed"], 0);

        // 结束
        focus_finish(&conn, id, 25, true).unwrap();
        let list = focus_list(&conn, None).unwrap();
        assert_eq!(list[0]["actual_min"], 25);
        assert_eq!(list[0]["completed"], 1);
        assert!(list[0]["ended_at"].is_string());
        assert!(focus_finish(&conn, 999, 1, true).is_err(), "不存在的记录要报错");
        assert!(focus_finish(&conn, id, -1, true).is_err(), "负数时长要报错");

        // 倒序 + limit（同秒写入时用 id 兜底稳定排序）
        let id2 = focus_start(&conn, None, "break", 5).unwrap();
        let list = focus_list(&conn, Some(1)).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], id2, "最新的排在最前");
        assert!(list[0]["course_id"].is_null(), "不带课程也允许");
        // ⚠ `limit < 1` 被 `clamp(1, 上限)` 夹到 1，因此只回 1 条（不是 2 条）。
        //    这句期望值曾误写成 2（与消息"按 1 处理"自相矛盾），已按实现修正 —— 不要再改回 2。
        assert_eq!(focus_list(&conn, Some(0)).unwrap().len(), 1, "limit < 1 按 1 处理");
    }

    /// ⑤ `note_export_docx`：产出文件存在、非空、**头 4 字节是 `PK\x03\x04`**（合法 ZIP），
    /// 并把绝对路径写回 `notes.exported`。测完把临时文件删干净。
    #[test]
    fn note_export_docx_produces_valid_zip() {
        let conn = mem();
        let cid = course_create(&conn, "操作系统", None, None, None).unwrap();
        let md = "# 进程与线程\n\n| 对比项 | 进程 | 线程 |\n| --- | --- | --- |\n| 地址空间 | 独立 | 共享 |\n\n- 进程是资源分配单位\n- 线程是调度单位\n\n> 注意：同一进程内的线程共享地址空间。\n";
        let nid = note_save(&conn, cid, None, "进程与线程", md, None, "user").unwrap();

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "chunxiao-docx-test-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let path = crate::export_note_docx(&conn, nid, &dir.to_string_lossy())
            .expect("导出 .docx 应成功");
        let p = std::path::Path::new(&path);
        assert!(p.exists(), "导出文件必须存在：{path}");
        assert!(
            p.parent().map(|d| d == dir.as_path()).unwrap_or(false)
                || p.starts_with(&dir),
            "导出文件应落在指定目录：{path}"
        );

        let bytes = std::fs::read(p).unwrap();
        assert!(!bytes.is_empty(), "导出文件不得为空");
        assert_eq!(
            &bytes[0..4],
            &[0x50, 0x4B, 0x03, 0x04],
            "docx 必须是合法 ZIP（本地文件头 PK\\x03\\x04），实际头部：{:02X?}",
            &bytes[0..4]
        );
        assert!(bytes.len() > 1000, "docx 体积过小，可能没写进正文：{}", bytes.len());
        let as_text = String::from_utf8_lossy(&bytes);
        assert!(as_text.contains("word/document.xml"), "ZIP 内应有 word/document.xml");
        assert!(as_text.contains("[Content_Types].xml"), "ZIP 内应有 [Content_Types].xml");
        assert!(as_text.contains("进程与线程"), "笔记正文应写进 document.xml");

        // exported 被写成该路径（界面上的「已导出」标记依赖它）
        assert_eq!(
            note_get(&conn, nid).unwrap()["exported"].as_str(),
            Some(path.as_str()),
            "notes.exported 必须是导出的绝对路径"
        );
        let row = notes_list(&conn, Some(cid))
            .unwrap()
            .into_iter()
            .find(|r| r["id"] == nid)
            .unwrap();
        assert_eq!(row["exported"].as_str(), Some(path.as_str()));

        // 不存在的笔记 / 空目录都要给可读错误，而不是产出半个文件
        assert!(crate::export_note_docx(&conn, 9999, &dir.to_string_lossy()).is_err());
        assert!(crate::export_note_docx(&conn, nid, "   ").is_err());

        // 收尾：临时文件与目录都删掉
        let _ = std::fs::remove_file(p);
        let _ = std::fs::remove_dir(&dir);
        assert!(!p.exists(), "测试后临时文件必须删除");
    }

    // -----------------------------------------------------------------------
    // M4：知识点 / 题库 / 练习作答 / 学习画像（契约 docs/10-M4契约.md §四）
    // -----------------------------------------------------------------------

    /// ① `knowledge_points_sync_from_prior`：跑两次不重复建（幂等），
    /// `prior_id` / `parent_id` 关联正确，且不会把别的课程的先验串进来。
    #[test]
    fn knowledge_points_sync_from_prior_is_idempotent() {
        let conn = mem();
        let cid = course_create(&conn, "数据结构", None, None, None).unwrap();
        let root = prior_add(&conn, cid, None, "线性表", None, None, "textbook", Some("P12"), None)
            .unwrap();
        let child = prior_add(
            &conn,
            cid,
            Some(root),
            "链表",
            None,
            None,
            "textbook",
            Some("P20"),
            None,
        )
        .unwrap();
        // 先手工建一个同名知识点（还没关联先验）：同步时应**认领**它，而不是再造一条重名的
        let manual = knowledge_point_save(&conn, cid, "链表", None, None).unwrap();
        // 另一门课的先验：不该被同步进来
        let cid2 = course_create(&conn, "操作系统", None, None, None).unwrap();
        prior_add(&conn, cid2, None, "进程", None, None, "textbook", None, None).unwrap();

        let first = knowledge_points_sync_from_prior(&conn, cid).unwrap();
        assert_eq!(first["created"], 1, "只新建 1 条（另一条认领了手工建的同名知识点）");
        assert_eq!(first["total"], 2, "共 2 条由先验派生的知识点");

        let list = knowledge_points_list(&conn, cid).unwrap();
        assert_eq!(list.len(), 2, "同名手工知识点被认领，不该出现重名两条");
        let kp_root = list.iter().find(|k| k["name"] == "线性表").expect("线性表");
        let kp_child = list.iter().find(|k| k["name"] == "链表").expect("链表");
        assert_eq!(kp_root["prior_id"], root, "prior_id 必须指向来源先验");
        assert_eq!(kp_child["prior_id"], child);
        assert_eq!(kp_child["id"], manual, "同名手工知识点是被认领的，不是新建的");
        assert_eq!(
            kp_child["parent_id"], kp_root["id"],
            "先验的父子关系要映射到知识点的 parent_id"
        );
        assert_eq!(kp_root["question_count"], 0);
        assert_eq!(kp_root["attempts"], 0);

        // 幂等：再跑一次，一条都不新建
        let second = knowledge_points_sync_from_prior(&conn, cid).unwrap();
        assert_eq!(second["created"], 0, "第二次同步必须 created = 0");
        assert_eq!(second["total"], 2, "总数不变");
        assert_eq!(knowledge_points_list(&conn, cid).unwrap().len(), 2);
        let all: i64 = conn
            .query_row("SELECT COUNT(*) FROM knowledge_points", [], |r| r.get(0))
            .unwrap();
        assert_eq!(all, 2, "别的课程的先验不该被同步进来");
    }

    /// ② `questions_save_batch` + `question_update`：批量入库、人工校正、`flawed` 落库；
    /// 批次里夹一条坏的 → **整体回滚**，不留半份题库。
    #[test]
    fn questions_save_batch_and_update() {
        let conn = mem();
        let cid = course_create(&conn, "概率论", None, None, None).unwrap();
        let kp = knowledge_point_save(&conn, cid, "条件概率", None, None).unwrap();

        let items = vec![
            NewQuestion {
                kp_id: Some(kp),
                qtype: "choice".into(),
                stem: "P(A|B) 的定义是？".into(),
                options: Some(json!(["P(AB)/P(B)", "P(B)/P(AB)", "P(A)P(B)"])),
                answer: "P(AB)/P(B)".into(),
                explain: Some("条件概率的原始定义".into()),
                difficulty: Some(2),
                source: None, // 省略 → 按 ai（AI 生成 → 预览确认 → 入库）
                source_ref: None,
            },
            NewQuestion {
                kp_id: Some(kp),
                qtype: "blank".into(),
                stem: "事件 A 与 B 独立时 P(AB) = ?".into(),
                options: None,
                answer: "P(A)P(B)".into(),
                explain: None,
                difficulty: None,
                source: Some("user".into()),
                source_ref: Some("自制".into()),
            },
        ];
        let ids = questions_save_batch(&conn, cid, &items).unwrap();
        assert_eq!(ids.len(), 2);
        assert_eq!(questions_list(&conn, Some(cid), None, None).unwrap().len(), 2);

        let q1 = question_get(&conn, ids[0]).unwrap();
        assert_eq!(q1["kp_id"], kp);
        assert_eq!(q1["source"], "ai", "批量入库默认 source = ai");
        assert_eq!(q1["flawed"], 0);
        assert_eq!(q1["attempts"], 0);
        assert!(q1["last_correct"].is_null(), "从未作答 = null（不是 0）");
        let opts: Value =
            serde_json::from_str(q1["options"].as_str().unwrap()).expect("options 要是合法 JSON");
        assert_eq!(opts, json!(["P(AB)/P(B)", "P(B)/P(AB)", "P(A)P(B)"]));
        assert_eq!(question_get(&conn, ids[1]).unwrap()["source"], "user");
        assert_eq!(question_get(&conn, ids[1]).unwrap()["source_ref"], "自制");

        // 人工校正：改题干 / 解析 / 难度 + 标记「题目有问题」
        question_update(
            &conn,
            ids[0],
            Some("P(A|B) 的定义（单选）"),
            None,
            Some("P(AB)/P(B)"),
            Some("修正后的解析"),
            Some(3),
            Some(true),
        )
        .unwrap();
        let q1 = question_get(&conn, ids[0]).unwrap();
        assert_eq!(q1["stem"], "P(A|B) 的定义（单选）");
        assert_eq!(q1["explain"], "修正后的解析");
        assert_eq!(q1["difficulty"], 3);
        assert_eq!(q1["flawed"], 1, "「题目有问题」标记落库为 1");
        // 只改 flawed 不动别的字段；传 None 的字段保持原值
        question_update(&conn, ids[0], None, None, None, None, None, Some(false)).unwrap();
        let q1 = question_get(&conn, ids[0]).unwrap();
        assert_eq!(q1["flawed"], 0);
        assert_eq!(q1["stem"], "P(A|B) 的定义（单选）");
        assert_eq!(q1["difficulty"], 3);
        assert!(
            question_update(&conn, 9999, Some("x"), None, None, None, None, None).is_err(),
            "校正不存在的题目要报错"
        );

        // 批次里第 2 题题型非法 → 第 1 题也不许入库
        let bad = vec![
            NewQuestion {
                kp_id: None,
                qtype: "blank".into(),
                stem: "合法的一条".into(),
                options: None,
                answer: "a".into(),
                explain: None,
                difficulty: None,
                source: None,
                source_ref: None,
            },
            NewQuestion {
                kp_id: None,
                qtype: "judge".into(),
                stem: "题型非法的一条".into(),
                options: None,
                answer: "a".into(),
                explain: None,
                difficulty: None,
                source: None,
                source_ref: None,
            },
        ];
        let e = questions_save_batch(&conn, cid, &bad).unwrap_err();
        assert!(e.contains("第 2 题"), "错误要指出是第几题：{e}");
        assert_eq!(
            questions_list(&conn, Some(cid), None, None).unwrap().len(),
            2,
            "坏批次必须整体回滚（第 1 题也不许留下）"
        );
        assert!(
            questions_save_batch(&conn, cid, &[]).unwrap().is_empty(),
            "空批次返回空数组，不是 null"
        );

        // 级联删除：删掉题目后它的作答记录也不留
        attempt_record(&conn, ids[1], Some("P(A)P(B)"), Some(true), None, None, None).unwrap();
        question_delete(&conn, ids[1]).unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM attempts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "删题目要连它的 attempts 一起删");
        assert!(question_delete(&conn, ids[1]).is_err(), "重复删除要报可读错误");
    }

    /// ③ `question_save`：`options` 不是合法 JSON 数组要报可读错误；`qtype` 非法同样报错。
    #[test]
    fn question_save_rejects_bad_options() {
        let conn = mem();
        let cid = course_create(&conn, "线性代数", None, None, None).unwrap();
        let bad = [
            json!("这不是 JSON"),
            json!("{\"a\":1}"), // 是合法 JSON，但不是数组
            json!(123),         // 数字
            json!({"a": 1}),    // 对象
            json!("[1,2"),      // 坏 JSON
        ];
        for b in &bad {
            let e = question_save(&conn, cid, None, "choice", "题干", Some(b), "A", None, None, "user", None)
                .unwrap_err();
            assert!(e.contains("options"), "错误要说明 options 该怎么写：{e}");
        }
        let e = question_save(&conn, cid, None, "judge", "题干", None, "对", None, None, "user", None)
            .unwrap_err();
        assert!(e.contains("题型"), "非法题型要报可读错误：{e}");
        assert!(
            question_save(&conn, cid, None, "short", "题干", None, "答案", None, None, "  ", None)
                .is_err(),
            "来源不能为空（题目要能溯源）"
        );
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM questions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "校验失败一条都不许落库");

        // 合法的两种写法：JSON 字符串（契约口径）与直接给数组
        let a = question_save(
            &conn,
            cid,
            None,
            "choice",
            "题干 A",
            Some(&json!("[\"A项\",\"B项\"]")),
            "A项",
            None,
            None,
            "user",
            None,
        )
        .unwrap();
        let b = question_save(
            &conn,
            cid,
            None,
            "choice",
            "题干 B",
            Some(&json!(["A项", "B项"])),
            "A项",
            None,
            None,
            "user",
            None,
        )
        .unwrap();
        for id in [a, b] {
            let text = question_get(&conn, id).unwrap()["options"]
                .as_str()
                .unwrap()
                .to_string();
            let v: Value = serde_json::from_str(&text).expect("落库的 options 必须是合法 JSON");
            assert_eq!(v, json!(["A项", "B项"]));
        }
    }

    /// ④ `attempt_record`：`confidence` 越界 / 负 `durationMs` / 非 0-1 的 `selfEval` 报错；
    /// 合法记录可落库并被 `attempts_list`（错题本数据源）读回。
    #[test]
    fn attempt_record_validates_ranges() {
        let conn = mem();
        let cid = course_create(&conn, "大学物理", None, None, None).unwrap();
        let qid = question_save(
            &conn,
            cid,
            None,
            "choice",
            "真空光速约为？",
            Some(&json!(["3e8 m/s", "3e5 m/s"])),
            "3e8 m/s",
            None,
            Some(1),
            "user",
            None,
        )
        .unwrap();

        let e = attempt_record(&conn, qid, Some("3e8 m/s"), Some(true), None, Some(1000), Some(0))
            .unwrap_err();
        assert!(e.contains("信心度"), "{e}");
        assert!(
            attempt_record(&conn, qid, Some("x"), Some(true), None, None, Some(6)).is_err(),
            "confidence = 6 越界"
        );
        let e = attempt_record(&conn, qid, Some("x"), Some(false), None, Some(-1), None).unwrap_err();
        assert!(e.contains("负数"), "{e}");
        let e = attempt_record(&conn, qid, Some("x"), None, Some(2), None, None).unwrap_err();
        assert!(e.contains("自评"), "{e}");
        let e = attempt_record(&conn, 9999, Some("x"), Some(true), None, None, None).unwrap_err();
        assert!(e.contains("题目不存在"), "不许写出指向不存在题目的孤儿记录：{e}");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM attempts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "校验失败不许落库");

        let ok = attempt_record(&conn, qid, Some("3e8 m/s"), Some(true), None, Some(1500), Some(4))
            .unwrap();
        // 主观题：correct 省略（待自评），self_eval 由用户给
        let q2 = question_save(
            &conn,
            cid,
            None,
            "short",
            "简述动量守恒的条件",
            None,
            "合外力为零",
            Some("内力不改变总动量"),
            None,
            "user",
            None,
        )
        .unwrap();
        attempt_record(&conn, q2, Some("合外力为零"), None, Some(0), None, None).unwrap();

        let all = attempts_list(&conn, Some(cid), None, None, None).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0]["question_id"], q2, "倒序：最新的在前");
        assert!(all[0]["correct"].is_null(), "待自评时 correct 为 null");
        assert_eq!(all[0]["self_eval"], 0);
        let row = all.iter().find(|a| a["id"] == ok).unwrap();
        assert_eq!(row["confidence"], 4);
        assert_eq!(row["duration_ms"], 1500);
        assert_eq!(row["stem"], "真空光速约为？", "错题本数据源要带题目正文");
        assert_eq!(row["qtype"], "choice");
        assert_eq!(row["answer"], "3e8 m/s");
        assert_eq!(row["explain"].as_str(), None);

        // onlyWrong：明确判错或自评未掌握算「未答对」；两者都为 null 的"待自评"不算
        let wrong = attempts_list(&conn, Some(cid), None, Some(true), None).unwrap();
        assert_eq!(wrong.len(), 1, "只有自评未掌握的那条算未答对");
        assert_eq!(wrong[0]["question_id"], q2);
        assert_eq!(
            attempts_list(&conn, None, None, Some(false), Some(1)).unwrap().len(),
            1,
            "limit 生效"
        );
    }

    /// ⑤ **口径红线的守门测试**：`attempts < 3` 的知识点只进 `not_enough`，
    /// **不进** `mastery` 的有效结论、**不进** `weak_points`；`attempts >= 3` 且正确率低的
    /// 必须进 `weak_points` 且**带 `evidence`**。改公式或改阈值都会让这条变红。
    #[test]
    fn mastery_requires_min_evidence() {
        let conn = mem();
        let near = |a: f64, b: f64| (a - b).abs() < 1e-9;
        let cid = course_create(&conn, "离散数学", None, None, None).unwrap();
        let kp_thin = knowledge_point_save(&conn, cid, "命题逻辑", None, None).unwrap();
        let kp_weak = knowledge_point_save(&conn, cid, "图论", None, None).unwrap();
        let kp_strong = knowledge_point_save(&conn, cid, "集合论", None, None).unwrap();

        // 样本不足：只答了 2 次（而且都答错 —— 即便如此也**不许下结论**）
        let q_thin = question_save(&conn, cid, Some(kp_thin), "choice", "p→q 的逆否？", None, "¬q→¬p", None, None, "user", None).unwrap();
        attempt_record(&conn, q_thin, Some("x"), Some(false), None, None, None).unwrap();
        attempt_record(&conn, q_thin, Some("y"), Some(false), None, None, None).unwrap();

        // 样本足够且很差：3 次全错
        let q_weak = question_save(&conn, cid, Some(kp_weak), "blank", "欧拉回路的条件？", None, "所有顶点度数为偶数", None, None, "user", None).unwrap();
        for _ in 0..3 {
            attempt_record(&conn, q_weak, Some("不知道"), Some(false), None, None, None).unwrap();
        }

        // 样本足够且很好：3 次全对
        let q_strong = question_save(&conn, cid, Some(kp_strong), "blank", "空集是任何集合的子集？", None, "是", None, None, "user", None).unwrap();
        for _ in 0..3 {
            attempt_record(&conn, q_strong, Some("是"), Some(true), None, None, None).unwrap();
        }

        let ov = profile_overview(&conn, cid).unwrap();
        assert_eq!(ov["min_evidence"], 3, "min_evidence 必须是 3（契约 §2.4）");
        let has = |arr: &Value, name: &str| {
            arr.as_array()
                .unwrap()
                .iter()
                .any(|x| x["kp_name"] == name)
        };

        // ① 样本不足的：**只**出现在 not_enough
        assert!(has(&ov["not_enough"], "命题逻辑"), "attempts<3 必须进 not_enough：{ov}");
        assert!(!has(&ov["mastery"], "命题逻辑"), "attempts<3 不许进 mastery 的有效结论：{ov}");
        assert!(!has(&ov["weak_points"], "命题逻辑"), "attempts<3 不许进弱项榜：{ov}");
        let thin = ov["not_enough"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["kp_name"] == "命题逻辑")
            .unwrap()
            .clone();
        assert_eq!(thin["evidence"], 2);
        assert!(thin["attempts"].as_i64().unwrap() < 3);
        assert!(thin["reason"].as_str().unwrap().contains("样本不足"));
        assert!(thin.get("mastery").is_none(), "样本不足**不给掌握度数字**");

        // ② 样本足够且正确率低的：进 weak_points，且每项带 evidence
        assert!(has(&ov["weak_points"], "图论"), "正确率低且样本足够必须进弱项榜：{ov}");
        let weak = ov["weak_points"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["kp_name"] == "图论")
            .unwrap()
            .clone();
        assert_eq!(weak["evidence"], 3, "弱项**每项必须带 evidence**");
        assert!(near(weak["mastery"].as_f64().unwrap(), (0.0 + 1.0) / (3.0 + 2.0)), "mastery = (correct+1)/(attempts+2)：{weak}");
        assert!(near(weak["accuracy"].as_f64().unwrap(), 0.0), "accuracy 是原始 correct/attempts，与 mastery 并存");
        assert_eq!(ov["weak_points"][0]["kp_name"], "图论", "弱项按掌握度升序，最弱的排最前");

        // ③ 样本足够且正确率高的：在 mastery 里，掌握度更高
        let strong = ov["mastery"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["kp_name"] == "集合论")
            .unwrap()
            .clone();
        assert!(near(strong["mastery"].as_f64().unwrap(), 4.0 / 5.0));
        assert!(strong["mastery"].as_f64().unwrap() > weak["mastery"].as_f64().unwrap());

        // ④ 一次都没作答的知识点：evidence = 0、accuracy = null（0/0 不许造数）
        knowledge_point_save(&conn, cid, "数理逻辑", None, None).unwrap();
        let stats = question_stats(&conn, cid).unwrap();
        let row = stats
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["kp_name"] == "数理逻辑")
            .unwrap()
            .clone();
        assert!(row["accuracy"].is_null(), "attempts = 0 时 accuracy 必须为 null");
        assert_eq!(row["evidence"], 0);
        assert!(near(row["mastery"].as_f64().unwrap(), 0.5), "0/0 由拉普拉斯平滑兜住：(0+1)/(0+2)");
        // ⚠ 必须先**重新取一次快照**再断言：上面的 `ov` 是在「数理逻辑」建出来**之前**
        //   取的（见 ④ 段首的 `knowledge_point_save`），拿旧快照查新知识点必然落空。
        //   这是**测试的取样时机写错**，不是 `profile_overview` 的实现问题——
        //   证据：同文件 `profile_trait_set_rejects_mastery_and_upserts` 明确断言
        //   0 作答的知识点落在 `not_enough`（`weak_points` 空、`not_enough` 长度 1），
        //   且 `question_stats` 是 `FROM knowledge_points WHERE course_id = ?1` 全量返回。
        //   同类先例见 `docs/09-M3实现记录.md` §2.1（实现对、测试错）。
        //   后人若要"修"实现来让旧快照断言通过，请先读这段注释。
        let ov = profile_overview(&conn, cid).unwrap();
        assert!(has(&ov["not_enough"], "数理逻辑"), "没作答的知识点也是样本不足");
    }

    /// ⑥ `practice_pick` 的统计加权排序：① 从未作答优先；② 其次知识点掌握度升序；
    /// ③ 同分按 `id` 稳定排序。**不叫"智能推荐"**，规则全部可解释。
    #[test]
    fn practice_pick_prioritizes_unattempted_and_weak() {
        let conn = mem();
        let near = |a: f64, b: f64| (a - b).abs() < 1e-9;
        let cid = course_create(&conn, "算法设计", None, None, None).unwrap();
        let kp_weak = knowledge_point_save(&conn, cid, "动态规划", None, None).unwrap();
        let kp_strong = knowledge_point_save(&conn, cid, "排序", None, None).unwrap();

        let q_weak = question_save(&conn, cid, Some(kp_weak), "short", "LCS 的状态转移？", None, "见教材", None, None, "user", None).unwrap();
        let q_strong = question_save(&conn, cid, Some(kp_strong), "blank", "快排平均复杂度？", None, "O(n log n)", None, None, "user", None).unwrap();
        // 两道**从未作答**的题，且同属一个知识点（掌握度同分 → 走规则③ 按 id）
        let q_new_a = question_save(&conn, cid, Some(kp_weak), "choice", "还没做过的新题 A", Some(&json!(["A", "B"])), "A", None, None, "user", None).unwrap();
        let q_new_b = question_save(&conn, cid, Some(kp_weak), "choice", "还没做过的新题 B", Some(&json!(["A", "B"])), "A", None, None, "user", None).unwrap();

        // 动态规划 3 次全错 → 掌握度 (0+1)/(3+2) = 0.2；排序 3 次全对 → (3+1)/(3+2) = 0.8
        for _ in 0..3 {
            attempt_record(&conn, q_weak, Some("不会"), Some(false), None, None, None).unwrap();
        }
        for _ in 0..3 {
            attempt_record(&conn, q_strong, Some("O(n log n)"), Some(true), None, None, None).unwrap();
        }

        let picked = practice_pick(&conn, cid, None, None).unwrap();
        assert_eq!(picked.len(), 4, "count 默认 5，题不够就返回全部");
        assert_eq!(picked[0]["id"], q_new_a, "① 从未作答的题目最先（先补样本）");
        assert_eq!(picked[1]["id"], q_new_b, "③ 同为未作答且同知识点 → 按 id 稳定排序");
        assert_eq!(picked[2]["id"], q_weak, "② 其次按知识点掌握度升序：弱的先");
        assert_eq!(picked[3]["id"], q_strong, "强的最后");
        assert_eq!(picked[0]["attempts"], 0);
        assert_eq!(picked[1]["attempts"], 0);
        assert_eq!(picked[2]["kp_evidence"], 3, "带出所属知识点的样本数（结论要看样本）");
        assert!(near(picked[2]["kp_mastery"].as_f64().unwrap(), 0.2));
        assert!(near(picked[3]["kp_mastery"].as_f64().unwrap(), 0.8));
        assert_eq!(picked[0]["kp_name"], "动态规划");

        // count 边界与 kpId 过滤
        assert_eq!(practice_pick(&conn, cid, None, Some(0)).unwrap().len(), 1, "count < 1 按 1 处理");
        assert_eq!(practice_pick(&conn, cid, Some(kp_strong), Some(50)).unwrap().len(), 1);
        assert_eq!(practice_pick(&conn, cid, Some(kp_weak), Some(5)).unwrap().len(), 3);
        assert_eq!(practice_pick(&conn, cid, Some(9999), None).unwrap().len(), 0, "无结果返回空数组");
        // 同一批题每次取出来顺序一致（稳定排序）
        let again = practice_pick(&conn, cid, None, Some(2)).unwrap();
        assert_eq!(again[0]["id"], picked[0]["id"]);
        assert_eq!(again[1]["id"], picked[1]["id"]);
    }

    /// ⑦ 画像条目：`mastery` 是系统只读口径（**拒收手工写入**）；
    /// 自述缺漏 / 偏好可写，重复设置是更新而非堆行；自述**不会**变成统计结论。
    #[test]
    fn profile_trait_set_rejects_mastery_and_upserts() {
        let conn = mem();
        let cid = course_create(&conn, "机器学习", None, None, None).unwrap();
        let kp = knowledge_point_save(&conn, cid, "梯度下降", None, None).unwrap();

        let e = profile_trait_set(&conn, Some(kp), "mastery", Some(0.99), None).unwrap_err();
        assert!(e.contains("只读"), "掌握度只能由作答记录算出：{e}");
        let e = profile_trait_set(&conn, Some(kp), "tips", None, None).unwrap_err();
        assert!(e.contains("画像条目类型"), "{e}");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM profile_traits", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "非法条目不许落库");

        let id1 = profile_trait_set(&conn, Some(kp), "weakness_self", None, None).unwrap();
        let id2 = profile_trait_set(&conn, Some(kp), "weakness_self", Some(0.3), Some(5)).unwrap();
        assert_eq!(id1, id2, "同一「知识点 + 类型」重复设置是更新，不堆历史行");
        profile_trait_set(&conn, None, "preference", Some(1.0), None).unwrap();
        profile_trait_set(&conn, None, "style", None, None).unwrap();
        assert!(
            profile_trait_set(&conn, Some(9999), "weakness_self", None, None).is_err(),
            "知识点不存在要报错"
        );

        let traits = profile_traits_list(&conn, Some(cid)).unwrap();
        assert_eq!(traits.len(), 3, "不挂课程的偏好/风格在任何课程下都要返回");
        let gap = traits.iter().find(|t| t["trait"] == "weakness_self").unwrap();
        assert_eq!(gap["kp_name"], "梯度下降");
        assert_eq!(gap["evidence"], 5);

        // 自述缺漏与系统统计**分区展示**：自述只进 declared_gaps，不改变 mastery / weak_points
        let ov = profile_overview(&conn, cid).unwrap();
        assert_eq!(ov["declared_gaps"].as_array().unwrap().len(), 1);
        assert_eq!(ov["declared_gaps"][0]["kp_id"], kp);
        assert_eq!(ov["preferences"].as_array().unwrap().len(), 2, "preference / style 都算偏好");
        assert!(ov["weak_points"].as_array().unwrap().is_empty(), "自述不能变成统计出来的弱项");
        assert!(ov["mastery"].as_array().unwrap().is_empty());
        assert_eq!(ov["not_enough"].as_array().unwrap().len(), 1);
    }

    // -----------------------------------------------------------------------
    // R1：对话课程归属 + 本课问答素材 + 批量先验知识树
    // -----------------------------------------------------------------------

    /// R1 契约 §2.1：会话归属可设可清、幂等、**不改 `updated_at`**（它是"最后消息时间"，
    /// 用于列表排序）；会话不存在 / 课程不存在都给可读中文错误。
    #[test]
    fn chat_session_set_course_sets_and_clears() {
        let conn = mem();
        let cid = course_create(&conn, "操作系统", None, None, None).unwrap();
        let other = course_create(&conn, "计算机网络", None, None, None).unwrap();
        let sid = chat_session_create(&conn, Some(cid), "进程与线程").unwrap();

        let course_of = |id: i64| -> Option<i64> {
            conn.query_row(
                "SELECT course_id FROM chat_sessions WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
        };
        let updated_at = |id: i64| -> Option<String> {
            conn.query_row(
                "SELECT updated_at FROM chat_sessions WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
        };

        assert_eq!(course_of(sid), Some(cid), "create 时写了归属");
        let before = updated_at(sid);
        assert!(before.is_some(), "create 就会写 updated_at");

        // ① 改归属到另一门课
        chat_session_set_course(&conn, sid, Some(other)).unwrap();
        assert_eq!(course_of(sid), Some(other));
        // ② 置 NULL = 不限定课程（不是"置 0"、也不是报错）
        chat_session_set_course(&conn, sid, None).unwrap();
        assert_eq!(course_of(sid), None, "null = 不限定课程");
        // ③ 幂等：重复设同一值无副作用，也不报错
        chat_session_set_course(&conn, sid, None).unwrap();
        chat_session_set_course(&conn, sid, None).unwrap();
        assert_eq!(course_of(sid), None);
        // ④ 再设回原课程
        chat_session_set_course(&conn, sid, Some(cid)).unwrap();
        assert_eq!(course_of(sid), Some(cid));

        // ⑤ **`updated_at` 必须原封不动**：改归属不是消息事件，刷新它会让会话
        //    凭空跳到列表最前面（`chat_sessions_list` 按它倒序排）
        assert_eq!(
            updated_at(sid),
            before,
            "改归属不许改 updated_at（它的语义是「最后消息时间」）"
        );

        // ⑥ 错误文案（逐字对照契约 §2.1）
        let e = chat_session_set_course(&conn, 9999, None).unwrap_err();
        assert_eq!(e, "会话不存在（id=9999）");
        let e = chat_session_set_course(&conn, sid, Some(9999)).unwrap_err();
        assert_eq!(e, "课程不存在（id=9999），请先在「课程」页创建。");
        assert_eq!(course_of(sid), Some(cid), "报错后归属不许被改坏");

        // ⑦ 会话不存在时，即使 course_id 也非法，先报会话（校验顺序稳定可预期）
        assert_eq!(
            chat_session_set_course(&conn, 9999, Some(9999)).unwrap_err(),
            "会话不存在（id=9999）"
        );
    }

    /// R1 契约 §2.2：升序排序、`since` 过滤（含当日）、`limit` **取最近的**、
    /// `truncated` 如实置位、`system` 与空内容被过滤、别课程的消息不许串进来。
    #[test]
    fn chat_course_messages_orders_filters_and_truncates() {
        let conn = mem();
        let cid = course_create(&conn, "数据结构", None, None, None).unwrap();
        let other = course_create(&conn, "编译原理", None, None, None).unwrap();
        let sid = chat_session_create(&conn, Some(cid), "树与图").unwrap();
        let sid2 = chat_session_create(&conn, Some(cid), "排序").unwrap();
        let sid_other = chat_session_create(&conn, Some(other), "别的课").unwrap();

        // 直接插消息：本测试要精确控制 created_at / role / content（chat_history_save
        // 会把整批消息写成同一个时间戳，控不住排序口径）
        let add = |sid: i64, role: &str, content: &str, at: &str| {
            conn.execute(
                "INSERT INTO chat_messages(session_id, role, content, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![sid, role, content, at],
            )
            .unwrap();
        };
        add(sid, "system", "你是春晓，负责答疑。", "2024-03-01T09:00:00+08:00");
        add(sid, "user", "什么是二叉树？", "2024-03-01T09:00:01+08:00");
        add(sid, "assistant", "二叉树是……", "2024-03-01T09:00:02+08:00");
        add(sid, "user", "", "2024-03-01T09:00:03+08:00"); // 空内容 → 过滤
        add(sid, "user", "   ", "2024-03-01T09:00:04+08:00"); // 纯空白 → 过滤
        add(sid, "user", "今天讲红黑树", "2024-03-10T10:00:00+08:00");
        add(sid, "assistant", "红黑树的五条性质……", "2024-03-10T10:00:01+08:00");
        add(sid2, "user", "快排复杂度？", "2024-03-10T11:00:00+08:00");
        add(sid_other, "user", "编译原理的消息", "2024-03-10T12:00:00+08:00");

        let all = chat_course_messages(&conn, cid, None, None).unwrap();
        assert_eq!(all["session_count"], 2, "该课程会话总数（含无消息的）");
        assert_eq!(all["session_count_with_messages"], 2);
        assert_eq!(all["available_count"], 5, "别课程的 1 条不许串进来");
        assert_eq!(all["message_count"], 5, "message_count 是本次实际返回条数");
        assert_eq!(all["truncated"], false);
        let msgs = all["messages"].as_array().unwrap();
        let contents: Vec<&str> = msgs.iter().map(|m| m["content"].as_str().unwrap()).collect();
        assert_eq!(
            contents,
            vec![
                "什么是二叉树？",
                "二叉树是……",
                "今天讲红黑树",
                "红黑树的五条性质……",
                "快排复杂度？"
            ],
            "必须是 (created_at, id) 升序；system 与空内容不入列"
        );
        assert_eq!(msgs[0]["session_id"], sid);
        assert_eq!(msgs[0]["session_title"], "树与图", "要带会话标题，界面上要标出处");
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["created_at"], "2024-03-01T09:00:01+08:00");
        assert_eq!(msgs[4]["session_id"], sid2);

        // `since`：按 substr(created_at,1,10) >= since 过滤（**含当日**）
        let since = chat_course_messages(&conn, cid, Some("2024-03-10"), None).unwrap();
        assert_eq!(since["available_count"], 3, "含当日：3-10 的三条都算");
        assert_eq!(since["session_count"], 2, "session_count 是课程会话总数，不随 since 变");
        assert_eq!(since["session_count_with_messages"], 2);
        assert_eq!(since["message_count"], 3);
        assert_eq!(since["messages"][0]["content"], "今天讲红黑树");
        // 空串 / 纯空白当"没传"，不能变成恒真过滤
        assert_eq!(
            chat_course_messages(&conn, cid, Some("   "), None).unwrap()["available_count"],
            5
        );

        // `limit`：**取最近的**（先倒序截断再翻正序），不是从头截
        let cut = chat_course_messages(&conn, cid, None, Some(2)).unwrap();
        assert_eq!(cut["available_count"], 5, "available_count 是未截断前的总数");
        assert_eq!(cut["message_count"], 2);
        assert_eq!(cut["truncated"], true, "截断了必须如实置位");
        assert_eq!(
            cut["messages"][0]["content"], "红黑树的五条性质……",
            "截断发生在最早的一端：最新内容不许被截掉"
        );
        assert_eq!(cut["messages"][1]["content"], "快排复杂度？");
        assert_eq!(cut["messages"][1]["created_at"], "2024-03-10T11:00:00+08:00");
        // limit 边界：小于 1 按 1；超上限（5000）按上限，不报错
        assert_eq!(
            chat_course_messages(&conn, cid, None, Some(0)).unwrap()["message_count"],
            1
        );
        let huge = chat_course_messages(&conn, cid, None, Some(99999)).unwrap();
        assert_eq!(huge["message_count"], 5);
        assert_eq!(huge["truncated"], false);
        // since + limit 同时给：两者都要生效
        let both = chat_course_messages(&conn, cid, Some("2024-03-10"), Some(1)).unwrap();
        assert_eq!(both["available_count"], 3);
        assert_eq!(both["message_count"], 1);
        assert_eq!(both["messages"][0]["content"], "快排复杂度？");
        assert_eq!(both["truncated"], true);
    }

    /// R1 契约 §2.3：父子映射在 Rust 侧完成、返回 id 与 items 顺序一一对应、
    /// `verified` 硬编码 0、`source` 等字段逐项落库；**任一项非法 → 整批回滚，表内无残留**。
    #[test]
    fn prior_add_tree_maps_parents_and_is_atomic() {
        let conn = mem();
        let cid = course_create(&conn, "离散数学", None, None, None).unwrap();
        let row_of = |id: i64| -> Value {
            prior_list(&conn, cid)
                .unwrap()
                .into_iter()
                .find(|r| r["id"] == id)
                .expect("先验知识应已入库")
        };
        let total = || -> i64 {
            conn.query_row("SELECT COUNT(*) FROM course_prior", [], |r| r.get(0))
                .unwrap()
        };

        // ① 正常批次：两个顶层项 + 各自一个子项（子项在前、父在后也要能映射）
        let items = vec![
            json!({"topic": "第一章 命题逻辑", "summary": "一句话要点"}),
            json!({"topic": "1.1 命题", "detail": "细节", "parent_topic": "第一章 命题逻辑"}),
            json!({"topic": "第二章 集合论"}),
            json!({"topic": "2.1 集合运算", "summary": " ", "parent_topic": "第二章 集合论"}),
        ];
        let ids = prior_add_tree(
            &conn,
            cid,
            &items,
            "ai",
            Some("从对话提炼 · 待核对"),
            Some(0.4),
        )
        .unwrap();
        assert_eq!(ids.len(), 4, "返回 id 与 items 顺序一一对应");
        let (top1, child1, top2, child2) = (ids[0], ids[1], ids[2], ids[3]);
        assert!(row_of(top1)["parent_id"].is_null(), "顶层项 parent_id = NULL");
        assert!(row_of(top2)["parent_id"].is_null());
        assert_eq!(row_of(child1)["parent_id"], top1, "子项挂到本批顶层项的 id 上");
        assert_eq!(row_of(child2)["parent_id"], top2);
        assert_eq!(row_of(child1)["topic"], "1.1 命题");
        assert_eq!(row_of(top1)["summary"], "一句话要点");
        assert_eq!(row_of(child1)["detail"], "细节");
        assert_eq!(row_of(child1)["source"], "ai");
        assert_eq!(row_of(child1)["source_ref"], "从对话提炼 · 待核对");
        assert_eq!(row_of(child1)["confidence"], 0.4);
        assert_eq!(row_of(child1)["verified"], 0, "verified 硬编码 0：只有用户核对过才算数");
        assert!(row_of(child2)["summary"].is_null(), "空白摘要落 NULL，不落空字符串");
        assert_eq!(row_of(child2)["course_id"], cid);
        assert_eq!(total(), 4);

        // ② 非法 parent_topic（引用了本批**之外**的顶层项）→ 整批回滚
        let bad = vec![
            json!({"topic": "第三章 图论"}),
            json!({"topic": "3.1 树", "parent_topic": "第二章 集合论"}),
        ];
        let e = prior_add_tree(&conn, cid, &bad, "ai", None, None).unwrap_err();
        assert_eq!(e, "父知识点「第二章 集合论」不在本批中");
        assert_eq!(total(), 4, "整批回滚：连同合法的「第三章 图论」也不许留半截");
        assert!(
            prior_list(&conn, cid).unwrap().iter().all(|r| r["topic"] != "第三章 图论"),
            "表内无残留（按 topic 再确认一次）"
        );

        // ③ 其它非法项同样不留数据：空 topic / 非对象 / 超 200 字
        assert!(prior_add_tree(&conn, cid, &[json!({"topic": "   "})], "ai", None, None).is_err());
        assert!(prior_add_tree(&conn, cid, &[json!({})], "ai", None, None).is_err());
        assert!(prior_add_tree(&conn, cid, &[json!("不是对象")], "ai", None, None).is_err());
        let long = "长".repeat(201);
        let e = prior_add_tree(&conn, cid, &[json!({"topic": long})], "ai", None, None).unwrap_err();
        assert!(e.contains("200"), "超长要说清上限：{e}");
        assert_eq!(total(), 4, "全部非法批次都不许落库");

        // ④ 边界：恰好 200 字可以入库；空批返回空数组（不报错、不造数据）
        let ok200 = "长".repeat(200);
        assert!(prior_add_tree(&conn, cid, &[json!({"topic": ok200})], "ai", None, None).is_ok());
        assert_eq!(total(), 5);
        assert!(prior_add_tree(&conn, cid, &[], "ai", None, None).unwrap().is_empty());
        assert_eq!(total(), 5, "空批不写任何行");
    }

    /// R1 契约 §2.3 + `prior_add` 红线：**没有来源的知识点不允许入库**（整批拒绝）。
    #[test]
    fn prior_add_tree_rejects_empty_source() {
        let conn = mem();
        let cid = course_create(&conn, "概率论", None, None, None).unwrap();
        let items = vec![
            json!({"topic": "第一章 随机事件"}),
            json!({"topic": "1.1 样本空间", "parent_topic": "第一章 随机事件"}),
        ];
        for src in ["", "   ", "\t\n"] {
            let e = prior_add_tree(&conn, cid, &items, src, None, None).unwrap_err();
            assert!(e.contains("来源不能为空"), "要沿用 prior_add 的溯源红线文案：{e}");
        }
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM course_prior", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0,
            "没有来源的知识点不允许入库"
        );
        // 来源前后空白要 trim 后再判空（"  ai  " 是合法的）
        assert!(prior_add_tree(&conn, cid, &items, "  ai  ", None, None).is_ok());
        assert_eq!(prior_list(&conn, cid).unwrap()[0]["source"], "ai");
        // 连空批也要先拦来源（否则调用方会以为"没写东西所以没事"）
        assert!(prior_add_tree(&conn, cid, &[], "   ", None, None).is_err());
    }

    /// R1 契约 §2.2：该课程只有会话、没有消息时 `session_count > 0` 而
    /// `messages` 必须是 `[]`（**不许 null**）；`system` 消息不算素材。
    #[test]
    fn chat_course_messages_counts_sessions_without_messages() {
        let conn = mem();
        let cid = course_create(&conn, "大学物理", None, None, None).unwrap();
        let empty_a = chat_session_create(&conn, Some(cid), "还没问过 A").unwrap();
        let empty_b = chat_session_create(&conn, Some(cid), "还没问过 B").unwrap();
        assert_ne!(empty_a, empty_b);

        let out = chat_course_messages(&conn, cid, None, None).unwrap();
        assert_eq!(out["session_count"], 2, "session_count 含无消息的会话");
        assert_eq!(out["session_count_with_messages"], 0);
        assert_eq!(out["available_count"], 0);
        assert_eq!(out["message_count"], 0);
        assert_eq!(out["truncated"], false, "0 条不算截断");
        assert!(!out["messages"].is_null(), "空结果不许返回 null");
        assert!(out["messages"].as_array().unwrap().is_empty(), "空结果给 []");

        // 完全没有会话的课程：同样 0 / []，不报错
        let blank = course_create(&conn, "空课程", None, None, None).unwrap();
        let none = chat_course_messages(&conn, blank, None, None).unwrap();
        assert_eq!(none["session_count"], 0);
        assert!(none["messages"].as_array().unwrap().is_empty());

        // 只有 system 消息的会话：算"有会话"，但不算"有可选消息"（system 不可作素材）
        conn.execute(
            "INSERT INTO chat_messages(session_id, role, content, created_at)
             VALUES (?1, 'system', '你是春晓，负责答疑。', '2024-05-01T09:00:00+08:00')",
            [empty_a],
        )
        .unwrap();
        let sys_only = chat_course_messages(&conn, cid, None, None).unwrap();
        assert_eq!(sys_only["session_count"], 2);
        assert_eq!(sys_only["session_count_with_messages"], 0, "system 消息不可选，不算素材");
        assert_eq!(sys_only["available_count"], 0);
        assert!(sys_only["messages"].as_array().unwrap().is_empty());
    }
}
