// 悬浮球（Electron）集成模块
//
// 悬浮球是**独立的外部 Electron 应用**（floating-ball/），不在主程序窗口内：
//   · 本模块负责「主程序 → 球」：多路径解析球的可执行文件并 spawn，再用控制文件下发命令；
//   · 以及「球 → 主程序」：轮询桥接文件，把球推来的文字以 `ball-push` 事件交给前端。
// M0 不自动拉起悬浮球（由用户在设置页点按钮触发），避免调试期反复弹窗。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

// Windows 进程创建标志，使子进程脱离父进程的 Job Object
// 只用 CREATE_BREAKAWAY_FROM_JOB 即可解除关联，不影响 GUI 渲染
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x01000000;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::DbState;
use crate::keycrypt;

/// 悬浮球查找结果
enum BallSource {
    /// 开发态：electron.exe 需把项目目录作为 app 参数加载
    Dev { exe: PathBuf, app_dir: PathBuf },
    /// 已打包 exe（win-unpacked / 便携版），自包含，无需目录参数
    Built { exe: PathBuf },
}

/// 在一个候选目录里探测悬浮球的三种形态
fn probe_dir(dir: &Path) -> Option<BallSource> {
    // 1. 开发态：node_modules/electron/dist/electron.exe（需整目录作为 app 加载）
    let dev_exe = dir
        .join("node_modules")
        .join("electron")
        .join("dist")
        .join("electron.exe");
    if dev_exe.exists() {
        return Some(BallSource::Dev {
            exe: dev_exe,
            app_dir: dir.to_path_buf(),
        });
    }
    // 2. electron-builder win-unpacked 自包含应用（productName = 春晓助手）
    let unpacked = dir.join("win-unpacked").join("春晓助手.exe");
    if unpacked.exists() {
        return Some(BallSource::Built { exe: unpacked });
    }
    // 3. 便携版 exe（春晓助手*.exe，electron-builder portable 产物带版本号）
    //    多版本共存时取**版本最高**的：字符串排序会把 "1.0.10" 排在 "1.0.2" 前面，
    //    升级后可能拉起历史旧包。与 sorted_subdirs 对 win-unpacked-* 的
    //    “版本越大越优先”口径保持一致。
    if let Ok(entries) = fs::read_dir(dir) {
        let mut found: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                let n = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                n.starts_with("春晓助手") && n.ends_with(".exe")
            })
            .collect();
        found.sort_by(|a, b| {
            let na = a.file_name().and_then(|s| s.to_str()).unwrap_or("");
            let nb = b.file_name().and_then(|s| s.to_str()).unwrap_or("");
            portable_ver(na).cmp(&portable_ver(nb))
        });
        if let Some(exe) = found.into_iter().last() {
            return Some(BallSource::Built { exe });
        }
    }
    None
}

fn home_dir_opt() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

/// 主程序 exe 所在目录
fn main_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
}

/// 解析 “win-unpacked-<版本>” 目录的版本段（点号/连字符分隔的数字序列）
fn unpacked_ver(name: &str) -> Vec<u64> {
    name.strip_prefix("win-unpacked-")
        .unwrap_or("")
        .split(['.', '-'])
        .filter_map(|p| p.parse::<u64>().ok())
        .collect()
}

/// 从便携版文件名里抽版本号数字序列（"春晓助手 1.0.2.exe" → [1, 0, 2]）
fn portable_ver(name: &str) -> Vec<u64> {
    name.split(|c: char| !c.is_ascii_digit())
        .filter_map(|p| p.parse::<u64>().ok())
        .collect()
}

/// 子目录探测顺序：版本化目录（win-unpacked-*）按版本号**从大到小**优先，
/// 其余目录按名称升序。这样升级安装写入新版本目录后，主程序优先拉起新版悬浮球，
/// 而不是历史残留的旧目录（旧目录可能正被旧进程占用）。
fn sorted_subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default();
    dirs.sort_by(|a, b| {
        let na = a.file_name().and_then(|s| s.to_str()).unwrap_or("");
        let nb = b.file_name().and_then(|s| s.to_str()).unwrap_or("");
        let (va, vb) = (unpacked_ver(na), unpacked_ver(nb));
        match (!va.is_empty(), !vb.is_empty()) {
            (true, true) => vb.cmp(&va).then_with(|| na.cmp(nb)), // 版本大者优先
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            (false, false) => na.cmp(nb),
        }
    });
    dirs
}

/// 在目录树（有限深度）里递归探测悬浮球，
/// 兼容 NSIS `_up_` 备份目录等嵌套布局（如 `_up_\floating-ball\dist\春晓助手*.exe`）
fn find_ball_recursive(dir: &Path, depth: u32) -> Option<BallSource> {
    if let Some(src) = probe_dir(dir) {
        return Some(src);
    }
    if depth == 0 {
        return None;
    }
    for sub in sorted_subdirs(dir) {
        let name = sub
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        // 跳过与悬浮球无关的大目录（dist 是 electron-builder 产物目录，需保留）
        if name == "node_modules" || name == "target" {
            continue;
        }
        if let Some(src) = find_ball_recursive(&sub, depth - 1) {
            return Some(src);
        }
    }
    None
}

/// 按优先级解析悬浮球可执行文件：
///   1. 环境变量 `FLOATING_BALL_DIR`（指定 floating-ball 项目根或产物目录）
///   2. 主程序 exe 同目录 / `resources` 子目录（发布形态）
///   3. 主程序 exe 旁 `_up_`（NSIS 升级备份布局，兜底旧安装）
///   4. 项目仓库内 floating-ball（开发形态：CARGO_MANIFEST_DIR 上一级）
///   5. 用户桌面 floating-ball（旧开发形态兜底）
fn resolve_ball() -> Option<BallSource> {
    // 1. 环境变量显式指定
    if let Ok(dir) = std::env::var("FLOATING_BALL_DIR") {
        let dir = PathBuf::from(dir);
        if let Some(src) = find_ball_recursive(&dir, 4) {
            return Some(src);
        }
    }
    // 2. 与主程序 exe 同目录 / `resources` 子目录（发布形态）
    //    悬浮球装入版本化子目录（如 win-unpacked-0.1.0），升级时新目录不受旧进程文件占用影响，
    //    故此处用有限递归探测，兼容「直接放根目录」与「放版本化子目录」两种布局。
    if let Some(exe_dir) = main_exe_dir() {
        if let Some(src) = find_ball_recursive(&exe_dir, 2) {
            return Some(src);
        }
        if let Some(src) = find_ball_recursive(&exe_dir.join("resources"), 3) {
            return Some(src);
        }
        // 3. NSIS `_up_` 备份布局兜底（旧版安装包把资源装到这里）
        let up_dir = exe_dir.join("_up_");
        if up_dir.exists() {
            if let Some(src) = find_ball_recursive(&up_dir, 4) {
                return Some(src);
            }
        }
    }
    // 4. 项目仓库内 floating-ball（开发形态）
    let repo_ball = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("floating-ball");
    if let Some(src) = find_ball_recursive(&repo_ball, 2) {
        return Some(src);
    }
    // 5. 用户桌面 floating-ball（旧开发形态兜底）
    if let Some(home) = home_dir_opt() {
        let dev_dir = home.join("Desktop").join("floating-ball");
        if let Some(src) = find_ball_recursive(&dev_dir, 3) {
            return Some(src);
        }
    }
    None
}

/// 以子进程方式启动悬浮球并附加命令行参数，返回被拉起的球 exe 路径（便于前端提示排查）。
/// 使用 CREATE_BREAKAWAY_FROM_JOB 使悬浮球脱离主程序的 Job Object，
/// 这样春晓退出不会杀掉悬浮球，悬浮球退出也不会影响春晓。
/// 说明：若父进程本身位于不允许脱离的 Job 中，带该标志的 CreateProcess 会以
/// ACCESS_DENIED 失败 —— 此时自动去掉标志重试一次（代价：球与主程序同 Job，
/// 主程序退出时球会一并退出；优先保证「能拉起来」）。
fn spawn_ball(extra: &[&str]) -> Result<PathBuf, String> {
    let src = resolve_ball().ok_or_else(|| {
        "找不到悬浮球（Electron）。请设置环境变量 FLOATING_BALL_DIR，\
         或将悬浮球（春晓助手.exe）放到本程序同目录，或准备 floating-ball 开发目录"
            .to_string()
    })?;

    let (exe, current_dir, mut args) = match src {
        BallSource::Dev { exe, app_dir } => {
            let args = vec![app_dir.to_string_lossy().into_owned()];
            (exe, app_dir, args)
        }
        BallSource::Built { exe } => {
            let current_dir = exe
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| PathBuf::from("."));
            (exe, current_dir, Vec::new())
        }
    };
    args.extend(extra.iter().map(|s| s.to_string()));

    // 返回给前端排查用的球路径（build_cmd 闭包借用了 exe，故先克隆一份）
    let exe_out = exe.clone();

    let build_cmd = || {
        let mut cmd = Command::new(&exe);
        cmd.args(&args)
            .current_dir(&current_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd
    };

    #[cfg(windows)]
    {
        let try_spawn = |cmd: &mut Command, breakaway: bool| -> std::io::Result<()> {
            cmd.creation_flags(if breakaway { CREATE_BREAKAWAY_FROM_JOB } else { 0 });
            cmd.spawn().map(|_| ())
        };
        let mut cmd = build_cmd();
        match try_spawn(&mut cmd, true) {
            Ok(()) => Ok(exe_out),
            Err(e1) => {
                eprintln!("[ball] 带 Job 脱离标志启动失败（{e1}），尝试普通方式…");
                let mut cmd2 = build_cmd();
                match try_spawn(&mut cmd2, false) {
                    Ok(()) => Ok(exe_out),
                    Err(e2) => Err(format!("启动悬浮球失败（脱离标志：{e1}；普通方式：{e2}）")),
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let mut cmd = build_cmd();
        cmd.spawn()
            .map(|_| exe_out)
            .map_err(|e| format!("启动悬浮球失败：{e}"))
    }
}

/// 悬浮球 userData 目录（与 floating-ball main.js 的 BRIDGE_DIR 一致）
fn bridge_dir() -> PathBuf {
    if let Some(appdata) = std::env::var_os("APPDATA") {
        return PathBuf::from(appdata).join("chunxiao-ball");
    }
    let mut p = std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:\\Users\\default"));
    p.extend(["AppData", "Roaming", "chunxiao-ball"]);
    p
}

/// 球 → 主程序 桥接文件（主程序读）。与 floating-ball main.js 的 BRIDGE_FILE 一致。
fn bridge_file() -> PathBuf {
    bridge_dir().join("from-ball.json")
}

/// 主程序 → 球 控制文件（主程序写）。与 floating-ball main.js 的 CTRL_FILE 一致。
fn ctrl_file() -> PathBuf {
    bridge_dir().join("to-ball.json")
}

/// 悬浮球 → 春晓 桥接消息
///
/// R4：按 `docs/11` §六 的冻结登记，载荷新增三个字段。
/// ⚠ `text` 改为 `#[serde(default)]`：`set_course`（只切课程、没问题文本）不会带 `text`，
///   若仍要求必填，整条消息会反序列化失败并被**静默丢弃** —— 那正是最难查的一类缺陷。
#[derive(Debug, Deserialize, Clone)]
struct BridgeMsg {
    ts: u64,
    #[serde(default)]
    text: String,
    action: String,
    /// `docs/11` §六 已冻结：球回推时带上它所属的课程
    #[serde(default)]
    course_id: Option<i64>,
    /// R4 新增：球侧已生成的回答（供主程序落库，见 `db::ball_append_qa`）
    #[serde(default)]
    answer: Option<String>,
    /// R4 新增：本轮图片的 dataURL（供主程序落库）
    #[serde(default)]
    images: Option<Vec<String>>,
}

/// 已消费的消息时间戳（避免重复处理）
struct BridgeState {
    last_ts: u64,
}

/// 启动悬浮球（子进程模式）。球运行后会持续轮询 `to-ball.json`，
/// 后续 show / hide / prefill / quit 等命令通过该控制文件下发（见 send_ctrl）。
pub fn ball_start() -> Result<PathBuf, String> {
    spawn_ball(&["--child"])
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 取数据库连接锁（失败给出可读中文错误）
fn lock_conn<'a>(
    state: &'a State<'_, DbState>,
) -> Result<std::sync::MutexGuard<'a, rusqlite::Connection>, String> {
    state
        .0
        .lock()
        .map_err(|_| "数据库连接锁被污染，请重启应用".to_string())
}

/// 从 settings 读出当前 AI 配置，用于随控制命令同步给悬浮球。
///
/// 【BYOK 的配套】主程序与悬浮球各有一份独立配置；母本靠「内置共享 Key」掩盖了
/// 「要填两遍」这件事。本项目不内置 Key，所以每次下发命令都顺带把主程序里的
/// AI 配置带过去，球侧收到即落盘 —— 用户只需在主程序设置一次。
/// 三项全空时返回 None（不覆盖球里已有的配置）。
fn ai_config_of(conn: &rusqlite::Connection) -> Option<serde_json::Value> {
    let get = |k: &str| -> String {
        conn.query_row("SELECT value FROM settings WHERE key = ?1", [k], |r| {
            r.get::<_, String>(0)
        })
        .unwrap_or_default()
    };
    let base = get("ai.base_url");
    // 库里是 enc. 密文，给球之前先解成明文（球侧会用自己的盐重新加密落盘）
    let key = keycrypt::decrypt(&get("ai.api_key"));
    let model = get("ai.model");
    if base.is_empty() && key.is_empty() && model.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "baseURL": base,
        "apiKey": key,
        "model": model,
    }))
}

// ---------------------------------------------------------------------------
// R4：悬浮球的课程上下文（`docs/11` §六 阶段 2）
// ---------------------------------------------------------------------------

/// 悬浮球当前选中的课程（`settings.ball.course_id`）。
///
/// **单一事实来源在库侧**（不是球的本地配置）：主程序读它下发、球改动后回写它，
/// 这样"球重启 / 主程序重启 / 换皮肤"都不会让选择漂移。
/// 值非法（非数字、指向不存在的课程）一律按**不限定课程**处理。
fn ball_course_id(conn: &rusqlite::Connection) -> Option<i64> {
    let raw: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'ball.course_id'",
            [],
            |r| r.get(0),
        )
        .unwrap_or_default();
    let id: i64 = raw.trim().parse().ok()?;
    let ok: bool = conn
        .query_row("SELECT 1 FROM courses WHERE id = ?1", [id], |_| Ok(()))
        .is_ok();
    if !ok {
        // 课程被删了/库被换过：不能让球一直指向一个不存在的课程
        eprintln!("[ball] settings.ball.course_id={id} 已失效，按「不限定课程」下发");
        return None;
    }
    Some(id)
}

/// 持久化球的课程选择（`None` = 不限定课程，**写空串而不是删行**，便于排查"是谁改的"）
fn set_ball_course_id(conn: &rusqlite::Connection, course_id: Option<i64>) -> Result<(), String> {
    let v = course_id.map(|id| id.to_string()).unwrap_or_default();
    conn.execute(
        "INSERT INTO settings(key, value) VALUES('ball.course_id', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [v],
    )
    .map_err(|e| format!("保存悬浮球课程选择失败：{e}"))?;
    Ok(())
}

/// 供球面板下拉用的课程列表（`[{id, name}]`）：未归档在前，同组按创建时间倒序。
fn courses_for_ball(conn: &rusqlite::Connection) -> Vec<serde_json::Value> {
    let mut stmt = match conn.prepare(
        "SELECT id, name FROM courses
         ORDER BY archived ASC, created_at DESC, id DESC",
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[ball] 读取课程列表失败：{e}");
            return Vec::new();
        }
    };
    let rows = stmt.query_map([], |r| {
        Ok(serde_json::json!({
            "id": r.get::<_, i64>(0)?,
            "name": r.get::<_, String>(1)?,
        }))
    });
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(e) => {
            eprintln!("[ball] 课程列表解析失败：{e}");
            Vec::new()
        }
    }
}

/// 组装随 `show` / `prefill` 下发的课程上下文载荷。
///
/// 口径（`docs/11` §一 第 3 条）：**不自动套用"最近课程"** —— 没选过就是"不限定课程"，
/// 由用户在球面板上显式选择。
fn ball_context_of(conn: &rusqlite::Connection) -> serde_json::Map<String, serde_json::Value> {
    let courses = courses_for_ball(conn);
    let cid = ball_course_id(conn);
    let name = cid.and_then(|id| {
        conn.query_row("SELECT name FROM courses WHERE id = ?1", [id], |r| {
            r.get::<_, String>(0)
        })
        .ok()
    });
    let mut m = serde_json::Map::new();
    m.insert("courses".into(), serde_json::json!(courses));
    m.insert("courseId".into(), serde_json::json!(cid));
    m.insert("courseName".into(), serde_json::json!(name));
    m
}

/// 通过共享控制文件向悬浮球下发命令。
/// 比「二次 spawn 传命令行参数」可靠：Electron 便携版 stub / 打包 exe
/// 对额外参数透传不可靠，而悬浮球主实例固定轮询控制文件，命令必达。
///
/// `ensure_started = true` 时先确保球实例在运行（show / prefill 用）；
/// hide / quit 传 false —— 球没在跑时不该为了「隐藏 / 退出」反而把它拉起来。
///
/// `ai` 为当前 AI 配置（见 ai_config_of）：随命令一起下发，球侧收到即落盘。
/// 配置搭在命令上而不是单发一条，是为了避开「同一个控制文件后写覆盖先写」的竞态。
fn send_ctrl(
    cmd: &str,
    extra: serde_json::Map<String, serde_json::Value>,
    ensure_started: bool,
    ai: Option<serde_json::Value>,
) -> Result<(), String> {
    if ensure_started {
        ball_start().map_err(|e| format!("悬浮球启动失败：{e}"))?;
    }

    let mut payload = extra;
    payload.insert("ts".into(), serde_json::json!(now_ms()));
    payload.insert("cmd".into(), serde_json::json!(cmd));
    if let Some(ai) = ai {
        payload.insert("ai".into(), ai);
    }

    write_ctrl_payload(&payload)
}

/// 直接把载荷写进控制文件 `to-ball.json`（与 `send_ctrl` 同一份 JSON 写法）。
/// 专供「**回应球的请求**」用：球正在等这条回复，本来就在运行，
/// 因此 **不** ensure_started（不为了回一条消息把球拉起来）。
fn write_ctrl_payload(
    payload: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let dir = bridge_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建悬浮球控制目录失败：{e}"))?;
    let content = serde_json::to_string(payload).map_err(|e| format!("命令序列化失败：{e}"))?;
    fs::write(ctrl_file(), content).map_err(|e| format!("写入悬浮球命令失败：{e}"))
}

// ---------------------------------------------------------------------------
// Tauri Commands（前端通过 invoke() 调用）
// ---------------------------------------------------------------------------

/// 启动悬浮球（无参命令，与母本一致：前端 `invoke("ball_start_cmd")`）。
/// 球已经在跑时，Electron 的单实例锁会让新进程立刻退出，无副作用。
#[tauri::command]
pub fn ball_start_cmd() -> Result<(), String> {
    ball_start().map(|_| ())
}

/// 显示悬浮球（球未运行时先拉起）；顺带把主程序的 AI 配置（BYOK）与**课程上下文**同步过去
#[tauri::command]
pub fn ball_show(conn: State<'_, DbState>) -> Result<(), String> {
    let (ai, ctx) = {
        let c = lock_conn(&conn)?;
        (ai_config_of(&c), ball_context_of(&c))
    };
    send_ctrl("show", ctx, true, ai)
}

/// 隐藏悬浮球面板（进程不退出；球没在跑时什么都不做）
#[tauri::command]
pub fn ball_hide() -> Result<(), String> {
    send_ctrl("hide", serde_json::Map::new(), false, None)
}

/// 预填文本并打开面板（比如用户在春晓里选中了一段教材原文）；
/// 同样顺带同步 AI 配置与课程上下文
#[tauri::command]
pub fn ball_prefill(conn: State<'_, DbState>, text: String) -> Result<(), String> {
    let (ai, mut ctx) = {
        let c = lock_conn(&conn)?;
        (ai_config_of(&c), ball_context_of(&c))
    };
    ctx.insert("text".into(), serde_json::json!(text));
    send_ctrl("prefill", ctx, true, ai)
}

/// 彻底退出悬浮球（球没在跑时什么都不做）
#[tauri::command]
pub fn ball_quit() -> Result<(), String> {
    send_ctrl("quit", serde_json::Map::new(), false, None)
}

// ---------------------------------------------------------------------------
// 悬浮球 → 春晓 桥接：轮询共享文件
// ---------------------------------------------------------------------------

/// 查询词长度上限（超出按标点切段或截窗）
const KEYWORD_MAX: usize = 30;

/// 从球推来的选中文字里抽一个**适合检索的查询词**。
///
/// ⚠ 不能像 M1 契约初稿那样"直接取前 60 个字"：中文长选段含标点时，
/// FTS 的 `MATCH` 会把它变成多词短语、`LIKE` 兜底路径又要求整段**字面**命中，
/// 结果是**长选段几乎必然判"未命中"**（Rust 实现代理上报、主代理复核后修正）。
///
/// 策略：按中英文标点/空白切段，优先取第一个 4–30 字的片段；
/// 没有合适片段就退而取第一个 2–30 字的片段；整段无标点且过长则截取开头一个窗口。
fn pick_keyword(text: &str) -> String {
    const MIN_GOOD: usize = 4;
    const MIN_ANY: usize = 2;

    let t = text.trim();
    if t.is_empty() {
        return String::new();
    }

    let mut fallback: Option<&str> = None;
    for seg in t.split(|c: char| {
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
    }) {
        let seg = seg.trim();
        let n = seg.chars().count();
        if (MIN_GOOD..=KEYWORD_MAX).contains(&n) {
            return seg.to_string();
        }
        if (MIN_ANY..=KEYWORD_MAX).contains(&n) && fallback.is_none() {
            fallback = Some(seg);
        }
    }
    if let Some(s) = fallback {
        return s.to_string();
    }
    // 整段无标点（或只有超长片段）：截取开头窗口，避免把整句丢给检索
    t.chars().take(KEYWORD_MAX).collect()
}

/// 「关联课程材料」按钮（球面板）→ 主程序本地检索 → 结果写回 `to-ball.json`。
///
/// 四条纪律（契约 §三）：
///   1. ~~检索范围是**全库**~~ → **R4 起按球面板选中的课程过滤**（`course_id: None` 才全库）；
///      这是本轮的行为变更，已在 `docs/15` §3.2 登记；
///   2. 回传载荷**逐字冻结** `{ts, cmd:"material_result", kw, results:[{material,page,snippet}], note?}`，
///      球侧 `panel.js` 按 `material / page / snippet` 与 `kw` 解析，字段名不能改；
///   3. **不再 emit `ball-push`** —— 球推来的是「要检索的选中文字」，不是要插进对话框的划词文本；
///   4. 取锁失败 / 检索失败都不 panic：打日志 + 回一条带 note 的结果，轮询线程继续跑。
fn answer_material_search(app: &AppHandle, text: &str, course_id: Option<i64>) {
    let kw = pick_keyword(text);

    // 取库：state 未就绪（理论上不会）与锁被污染都只报错不 panic
    let outcome: Result<Vec<serde_json::Value>, String> = if kw.is_empty() {
        Ok(Vec::new())
    } else {
        match app.try_state::<DbState>() {
            Some(state) => match state.0.lock() {
                Ok(conn) => crate::db::material_search(&conn, course_id, &kw, Some(8)),
                Err(_) => Err("数据库连接锁被污染，请重启春晓。".to_string()),
            },
            None => Err("数据库尚未就绪，请稍后重试。".to_string()),
        }
    };

    let (results, note) = match outcome {
        Ok(rows) => {
            let brief: Vec<serde_json::Value> = rows
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "material": r["material"],
                        "page": r["page"],
                        "snippet": r["snippet"],
                    })
                })
                .collect();
            let note = if brief.is_empty() {
                // 措辞要跟着检索范围走：说"全库"却只查了某门课，是最容易误导用户的那种不一致
                Some(if kw.is_empty() {
                    "选中的文字为空，没有可检索的关键词。".to_string()
                } else if course_id.is_some() {
                    "没在这门课的材料里找到相关内容；可把球面板的课程改成「不限定课程」再试，或先导入材料。".to_string()
                } else {
                    "没有在你的课程材料中找到相关内容，可先在「课程」页导入材料。".to_string()
                })
            } else {
                None
            };
            (brief, note)
        }
        Err(e) => {
            eprintln!("[ball] 材料检索失败：{e}");
            (Vec::new(), Some(format!("检索失败：{e}")))
        }
    };

    let mut payload = serde_json::Map::new();
    payload.insert("ts".into(), serde_json::json!(now_ms()));
    payload.insert("cmd".into(), serde_json::json!("material_result"));
    payload.insert("kw".into(), serde_json::json!(kw));
    payload.insert("courseId".into(), serde_json::json!(course_id));
    payload.insert("results".into(), serde_json::json!(results));
    if let Some(n) = note {
        payload.insert("note".into(), serde_json::json!(n));
    }
    if let Err(e) = write_ctrl_payload(&payload) {
        eprintln!("[ball] 回传材料检索结果失败：{e}");
    }
}

/// 启动桥接轮询线程（每 1.5s 检查一次）
pub fn start_bridge_poller(app: AppHandle) {
    let poll_file = bridge_file();
    let state = Mutex::new(BridgeState { last_ts: 0u64 });

    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(1500));

        // 读桥接文件
        let Ok(content) = fs::read_to_string(&poll_file) else {
            // 文件不存在是正常情况，继续轮询
            continue;
        };

        let Ok(msg) = serde_json::from_str::<BridgeMsg>(&content) else {
            continue;
        };

        // 去重：只处理新消息（ts 更大）
        let mut st = state.lock().unwrap();
        if msg.ts <= st.last_ts {
            continue;
        }
        st.last_ts = msg.ts;
        drop(st);

        // 「关联课程材料」（球面板的📚按钮）：球要的是**检索结果**，走独立回传链路 ——
        // 调主程序本地检索 → 写 to-ball.json 的 material_result → **不 emit ball-push**
        // （否则前端会把这段选中文字当成划词文本插进对话框）。
        // R4：检索范围跟着球面板选中的课程走（原先写死全库）
        if msg.action == "material_search" {
            answer_material_search(&app, &msg.text, msg.course_id);
            let _ = fs::remove_file(&poll_file);
            continue;
        }

        // R4：球面板切换了课程 → **只持久化选择**，不落任何消息。
        // 主程序持有 `settings.ball.course_id` 作为单一事实来源（见 ball_course_id 注释）。
        if msg.action == "set_course" {
            match app.try_state::<DbState>() {
                Some(state) => match state.0.lock() {
                    Ok(conn) => {
                        if let Err(e) = set_ball_course_id(&conn, msg.course_id) {
                            eprintln!("[ball] {e}");
                        }
                    }
                    Err(_) => eprintln!("[ball] 数据库连接锁被污染，悬浮球课程选择未保存"),
                },
                None => eprintln!("[ball] 数据库尚未就绪，悬浮球课程选择未保存"),
            }
            let _ = fs::remove_file(&poll_file);
            continue;
        }

        // R4：球完成了一次问答 → **直接写库**（关闭 `docs/11` §六 的 G4），
        // 再把 `course_id`/`session_id` emit 给前端，让正看着该课程的界面刷新。
        // 刻意**不依赖任何页面打开**：球是独立应用，用户可能压根没开主程序界面。
        if msg.action == "ask" {
            let answer = msg.answer.clone().unwrap_or_default();
            let images = msg.images.clone().unwrap_or_default();
            let appended: Result<i64, String> = match app.try_state::<DbState>() {
                Some(state) => match state.0.lock() {
                    Ok(conn) => {
                        crate::db::ball_append_qa(&conn, msg.course_id, &msg.text, &answer, &images)
                    }
                    Err(_) => Err("数据库连接锁被污染，请重启春晓。".to_string()),
                },
                None => Err("数据库尚未就绪，请稍后重试。".to_string()),
            };
            match appended {
                Ok(session_id) => {
                    let _ = app.emit(
                        "ball-push",
                        serde_json::json!({
                            "text": msg.text,
                            "action": "ask",
                            "ts": msg.ts,
                            "course_id": msg.course_id,
                            "session_id": session_id,
                        }),
                    );
                }
                Err(e) => eprintln!("[ball] 悬浮球问答落库失败：{e}"),
            }
            let _ = fs::remove_file(&poll_file);
            continue;
        }

        // 其余 action 行为不变：发给前端（Tauri event），action 原样透传
        // （prefill / ask / 遗留的 laws_search — 前端忽略即可）。
        let _ = app.emit(
            "ball-push",
            serde_json::json!({
                "text": msg.text,
                "action": msg.action,
                "ts": msg.ts,
                "course_id": msg.course_id,
            }),
        );

        // 处理后删除文件（floating-ball 下次会重新写）
        let _ = fs::remove_file(&poll_file);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 建一个只含 settings 表的最小库（ai_config_of 只依赖它，不必拉起整套迁移）
    fn settings_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        conn
    }

    fn put(conn: &rusqlite::Connection, k: &str, v: &str) {
        conn.execute("INSERT INTO settings(key, value) VALUES(?1, ?2)", [k, v])
            .unwrap();
    }

    /// BYOK 配置同步的核心断言：给悬浮球的 apiKey 必须是**解密后的明文**。
    /// 若这里退化成密文，球侧拿去请求会被网关判为无效 Key，且现象很隐蔽
    /// （用户看到"Key 无效"而不是"配置没同步"）。
    #[test]
    fn ai_config_of_decrypts_api_key_before_handing_to_ball() {
        let conn = settings_db();
        put(&conn, "ai.base_url", "https://api.deepseek.com");
        put(&conn, "ai.model", "deepseek-chat");
        put(&conn, "ai.api_key", &keycrypt::encrypt("sk-chunxiao-test-0123456789"));

        let v = ai_config_of(&conn).expect("三项有值时应返回配置");
        assert_eq!(v["baseURL"], "https://api.deepseek.com");
        assert_eq!(v["model"], "deepseek-chat");
        assert_eq!(
            v["apiKey"], "sk-chunxiao-test-0123456789",
            "apiKey 必须是解密后的明文（密文会让球侧请求失败）"
        );
    }

    /// 三项全空时返回 None —— 不能拿空值去覆盖球里已有的配置
    #[test]
    fn ai_config_of_returns_none_when_nothing_configured() {
        let conn = settings_db();
        assert!(ai_config_of(&conn).is_none());
    }

    /// 只配了 base_url（用户还没填 Key）时也要下发，让球面板能同步出地址与模型
    #[test]
    fn ai_config_of_partial_config_is_still_sent() {
        let conn = settings_db();
        put(&conn, "ai.base_url", "https://api.deepseek.com");
        let v = ai_config_of(&conn).expect("有 base_url 就应下发");
        assert_eq!(v["baseURL"], "https://api.deepseek.com");
        assert_eq!(v["apiKey"], "");
    }

    /// 长选段不能整段当查询词：中文含标点时 FTS 会变成多词短语、LIKE 要求整段字面命中，
    /// 结果几乎必然"未命中"。这里钉死"按标点取片段"的行为。
    #[test]
    fn pick_keyword_extracts_a_searchable_segment_from_long_selection() {
        // 典型的长选段：取第一个有内容的分句，而不是前 60 个字
        let long = "梯度下降的收敛条件，取决于学习率与初始点的选择。若步长过大则震荡，过小则收敛缓慢。";
        let kw = pick_keyword(long);
        assert_eq!(kw, "梯度下降的收敛条件");
        assert!(kw.chars().count() <= KEYWORD_MAX);

        // 两字短选段要保留（走 LIKE 兜底仍能命中）
        assert_eq!(pick_keyword("极限"), "极限");

        // 以标点开头的选段不会把标点带进查询词
        assert_eq!(pick_keyword("，什么是红黑树呢？"), "什么是红黑树呢");

        // 整段无标点且超长：截取开头窗口，绝不整句丢给检索
        let no_punct = "一".repeat(200);
        let kw2 = pick_keyword(&no_punct);
        assert_eq!(kw2.chars().count(), KEYWORD_MAX);

        // 空白与空串
        assert_eq!(pick_keyword("   "), "");
        assert_eq!(pick_keyword(""), "");
    }

    /// 便携版多版本共存时必须按**版本号**取最新，不能按文件名字符串排序
    /// （字符串排序会把 "1.0.10" 排在 "1.0.2" 之前，升级后可能拉起旧包）。
    #[test]
    fn portable_ver_orders_by_version_not_by_string() {
        let mut names = vec![
            "春晓助手 1.0.2.exe",
            "春晓助手 1.0.10.exe",
            "春晓助手 1.0.1.exe",
        ];
        names.sort_by_key(|n| portable_ver(n));
        assert_eq!(
            names.last().copied(),
            Some("春晓助手 1.0.10.exe"),
            "必须按版本号比较：字符串排序会把 1.0.10 误判为更旧"
        );
        assert_eq!(portable_ver("春晓助手 1.0.2.exe"), vec![1, 0, 2]);
        // 畸形文件名不应 panic
        assert!(portable_ver("春晓助手.exe").is_empty());
    }

    // -----------------------------------------------------------------------
    // R4：悬浮球课程上下文（`docs/11` §六 阶段 2）
    // -----------------------------------------------------------------------

    /// 建一个含 settings + courses 的最小库（R4 的课程上下文只依赖这两张表）
    fn ball_ctx_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE courses (
                 id         INTEGER PRIMARY KEY AUTOINCREMENT,
                 name       TEXT NOT NULL,
                 archived   INTEGER NOT NULL DEFAULT 0,
                 created_at TEXT NOT NULL
             );",
        )
        .unwrap();
        conn
    }

    /// 课程选择的往返 + **失效值必须退化**：课程被删或换了库之后，
    /// 若仍把旧 id 下发，球会一直显示一门不存在的课（而且材料检索会静默空手而归）。
    #[test]
    fn ball_course_id_roundtrip_and_invalid_values_degrade_to_none() {
        let conn = ball_ctx_db();
        conn.execute(
            "INSERT INTO courses(id, name, archived, created_at) VALUES
             (1, '数据结构', 0, '2026-01-01'), (2, '线性代数', 0, '2026-01-02')",
            [],
        )
        .unwrap();

        // 从没设过 → 不限定课程（**不自动套用"最近课程"**，docs/11 §一 第 3 条）
        assert_eq!(ball_course_id(&conn), None);

        set_ball_course_id(&conn, Some(1)).unwrap();
        assert_eq!(ball_course_id(&conn), Some(1));

        // 指向不存在的课程 → None
        set_ball_course_id(&conn, Some(999)).unwrap();
        assert_eq!(ball_course_id(&conn), None);

        // 非数字垃圾值 → None（不 panic、不把垃圾当课程）
        conn.execute(
            "UPDATE settings SET value = 'abc' WHERE key = 'ball.course_id'",
            [],
        )
        .unwrap();
        assert_eq!(ball_course_id(&conn), None);

        // 显式取消 → None
        set_ball_course_id(&conn, None).unwrap();
        assert_eq!(ball_course_id(&conn), None);
    }

    /// 下拉列表顺序：未归档在前、同组按创建时间倒序（归档的沉到最后）
    #[test]
    fn courses_for_ball_puts_active_first_then_newest() {
        let conn = ball_ctx_db();
        conn.execute(
            "INSERT INTO courses(id, name, archived, created_at) VALUES
             (1, '归档课', 1, '2026-01-03'),
             (2, '新课',   0, '2026-01-05'),
             (3, '旧课',   0, '2026-01-01')",
            [],
        )
        .unwrap();
        let names: Vec<String> = courses_for_ball(&conn)
            .iter()
            .map(|c| c["name"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(names, vec!["新课", "旧课", "归档课"]);
    }

    /// 载荷字段名是契约（`docs/15` §3.1）的一部分：改名会直接打断球面板
    #[test]
    fn ball_context_payload_field_names_are_frozen() {
        let conn = ball_ctx_db();
        conn.execute(
            "INSERT INTO courses(id, name, archived, created_at) VALUES (1, '数据结构', 0, '2026-01-01')",
            [],
        )
        .unwrap();
        set_ball_course_id(&conn, Some(1)).unwrap();

        let ctx = ball_context_of(&conn);
        assert_eq!(ctx["courseId"], 1);
        assert_eq!(ctx["courseName"], "数据结构");
        assert_eq!(ctx["courses"][0]["id"], 1);
        assert_eq!(ctx["courses"][0]["name"], "数据结构");

        // 没选课程时：courseId / courseName 必须是 null（球据此显示"不限定课程"）
        set_ball_course_id(&conn, None).unwrap();
        let ctx2 = ball_context_of(&conn);
        assert!(ctx2["courseId"].is_null());
        assert!(ctx2["courseName"].is_null());
    }

    /// `set_course` 不带 `text`：若 `text` 仍为必填，整条消息会**反序列化失败并被静默丢弃**
    /// —— 那是最难查的一类缺陷（球说"已切换"，主程序毫无反应）。
    /// 顺带确认**旧版球的载荷**（无任何新字段）照样能解析。
    #[test]
    fn bridge_msg_tolerates_set_course_without_text_and_legacy_payloads() {
        let m: BridgeMsg =
            serde_json::from_str(r#"{"ts":1,"action":"set_course","course_id":3}"#).unwrap();
        assert_eq!(m.action, "set_course");
        assert_eq!(m.text, "");
        assert_eq!(m.course_id, Some(3));
        assert!(m.answer.is_none() && m.images.is_none());

        let old: BridgeMsg =
            serde_json::from_str(r#"{"ts":2,"text":"选中文字","action":"prefill"}"#).unwrap();
        assert_eq!(old.text, "选中文字");
        assert!(old.course_id.is_none());

        // ask 的完整形状（问题 + 回答 + 图片 + 课程）
        let ask: BridgeMsg = serde_json::from_str(
            r#"{"ts":3,"action":"ask","text":"这题怎么做","answer":"先求导","course_id":1,
                "images":["data:image/png;base64,AAAA"]}"#,
        )
        .unwrap();
        assert_eq!(ask.answer.as_deref(), Some("先求导"));
        assert_eq!(ask.images.as_ref().unwrap().len(), 1);
    }
}
