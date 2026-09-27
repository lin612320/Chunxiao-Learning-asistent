// R13 · 「相关材料」页（侧栏入口）
//
// 用户诉求（原话）：「在侧栏添加一个相关材料，点击材料可以直接跳转窗口（比如 pdf 点开就打开 pdf）」。
//
// ## 这一页要解决的真问题
// 材料的正文一直是**按字节**提取的（浏览器 `<input type=file>` 只给得到字节、给不到绝对路径），
// 所以 M1 契约里 `materials.file_path` **一直是空字符串** —— 于是"点材料打开原文件"
// 这件事在实现上根本无从谈起（`open_file` 需要一个真实存在的路径）。
// 伴随 R13 的两处改动，这一页才可能真的可用：
//   ① 导入时调用 `material_store_file` 把原始文件**在本机留一份副本**，路径写进 `file_path`；
//   ② 对**老材料**（路径为空）提供「补存原文件」：重选一次 → 落副本 → `material_set_path` 记下。
//
// ## 诚实口径（本项目的老规矩，别删）
//   · 没有原文件位置的材料**不摆一个点了没反应的「打开」按钮**，而是明说原因 + 给出补存入口；
//   · 打开失败（文件被删/被移走、扩展名不在白名单）**如实报错**，绝不静默；
//   · 「模型转写」的材料仍然显式标注「模型解析，非原文」。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import Icon from "../components/Icon";
import { useCourses } from "../hooks/useCourses";
import { parseCourseParam } from "../lib/courseScope";
import { isTauri } from "../lib/tauri";
import {
  deleteMaterial,
  fmtSize,
  listMaterials,
  openWithSystem,
  readFileAsB64,
  revealInFolder,
  setMaterialPath,
  storeMaterialFile,
} from "../lib/materials";
import type { MaterialItem } from "../data/sample";
import "./Materials.css";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 提取方式徽标（口径与课程页一致：模型转写必须显式说清"不是原文"） */
function byInfo(extractedBy: string): { text: string; warn: boolean } {
  return extractedBy === "model"
    ? { text: "模型转写", warn: true }
    : { text: "本机直接读出", warn: false };
}

export default function Materials() {
  const { courses } = useCourses();
  const { search } = useLocation();
  /** `?course=N` = 本页锁定到这门课（侧栏按课程进入时带的）；不带 = 全部课程 */
  const lockedCourseId = parseCourseParam(search);

  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  /** 「补存原文件」正在为哪一条选文件 */
  const [repickId, setRepickId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const courseName = useCallback(
    (id: number) => courses.find((c) => c.id === id)?.name ?? `课程 #${id}`,
    [courses],
  );

  /**
   * 加载材料。全部课程时**按课程分组**展示（分组只是排版，数据仍是一次合并后的列表）。
   * ⚠ 必须等课程列表读完再拉：全部课程模式下要靠 `courses` 才知道该问哪几门课。
   */
  const reload = useCallback(async () => {
    if (lockedCourseId == null && courses.length === 0) {
      // 还没读完课程列表 → 先别下结论说"没有材料"
      setLoading(true);
      return;
    }
    setLoading(true);
    try {
      const ids = lockedCourseId != null ? [lockedCourseId] : courses.map((c) => c.id);
      const list = await listMaterials(ids);
      setMaterials(list);
      setError(null);
    } catch (e) {
      setError(`读取材料失败：${errText(e)}`);
    } finally {
      setLoading(false);
    }
  }, [courses, lockedCourseId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 按课程分组（锁定到某门课时就只有一组） */
  const grouped = useMemo(() => {
    const map = new Map<number, MaterialItem[]>();
    for (const m of materials) {
      const bucket = map.get(m.course_id);
      if (bucket) bucket.push(m);
      else map.set(m.course_id, [m]);
    }
    return Array.from(map.entries());
  }, [materials]);

  // -------------------------------------------------------------------------
  // 动作
  // -------------------------------------------------------------------------

  /** 用系统默认程序打开（PDF 就打开你的 PDF 阅读器） */
  async function handleOpen(m: MaterialItem) {
    setBusyId(m.id);
    setNotice(null);
    try {
      await openWithSystem(m.file_path);
      setError(null);
    } catch (e) {
      setError(`打开「${m.file_name}」失败：${errText(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function handleReveal(m: MaterialItem) {
    setBusyId(m.id);
    setNotice(null);
    try {
      await revealInFolder(m.file_path);
      setError(null);
    } catch (e) {
      setError(`定位「${m.file_name}」失败：${errText(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(m: MaterialItem) {
    if (!window.confirm(`确定删除材料「${m.file_name}」吗？\n它的检索切块会一并删除，且无法撤销。`)) return;
    setBusyId(m.id);
    try {
      await deleteMaterial(m.id);
      await reload();
      setError(null);
    } catch (e) {
      setError(`删除失败：${errText(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  /** 老材料「补存原文件」：选一次文件 → 落一份副本 → 把路径记进库 */
  async function handleRepick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    const id = repickId;
    e.target.value = ""; // 允许连续两次选同一个文件
    setRepickId(null);
    if (!f || id == null) return;
    setBusyId(id);
    setNotice(`正在给「${f.name}」留一份本机副本…`);
    try {
      const path = await storeMaterialFile(f.name, await readFileAsB64(f));
      await setMaterialPath(id, path);
      await reload();
      setNotice(`已记下原文件位置：以后点「打开」就会用系统默认程序打开它。`);
      setError(null);
    } catch (err) {
      setError(`补存原文件失败：${errText(err)}`);
      setNotice(null);
    } finally {
      setBusyId(null);
    }
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  /** 单条材料（卡片结构与课程页保持一致，样式复用全局 `.material-*`） */
  const renderItem = (m: MaterialItem) => {
    const by = byInfo(m.extracted_by);
    const hasPath = m.file_path.trim().length > 0;
    return (
      <li key={m.id} className="material-item">
        <div className="material-head">
          <span className="material-name">{m.file_name}</span>
          {m.kind && <span className="tag">.{m.kind}</span>}
          <span className={"tag" + (by.warn ? " tag-warn" : "")}>{by.text}</span>
          {typeof m.chunk_count === "number" && (
            <span className={"tag" + (m.chunk_count > 0 ? "" : " tag-warn")}>
              已分成 {m.chunk_count} 段
            </span>
          )}
          {m.truncated ? <span className="tag tag-warn">只保留了一部分</span> : null}
          <div className="material-actions">
            {hasPath ? (
              <>
                <button
                  className="primary mat-open-btn"
                  disabled={busyId === m.id}
                  title="用系统默认程序打开原文件（PDF 会打开你的 PDF 阅读器）"
                  onClick={() => void handleOpen(m)}
                >
                  <Icon name="external" size={14} />
                  打开
                </button>
                <button
                  className="ghost-btn"
                  disabled={busyId === m.id}
                  title="在文件管理器里定位这个文件"
                  onClick={() => void handleReveal(m)}
                >
                  在文件夹中显示
                </button>
              </>
            ) : (
              <button
                className="ghost-btn"
                disabled={busyId === m.id}
                title="这条材料是按内容导入的，没留下原文件位置；重新选一次原文件，春晓会留一份副本并记下位置"
                onClick={() => {
                  setRepickId(m.id);
                  fileRef.current?.click();
                }}
              >
                补存原文件
              </button>
            )}
            <button
              className="danger-btn"
              disabled={busyId === m.id}
              onClick={() => void handleDelete(m)}
            >
              删除
            </button>
          </div>
        </div>

        {by.warn && (
          <div className="material-note-warn">
            这是模型转写的，不是原文：可能有错，请对着原文件核对后再当依据用。
          </div>
        )}
        {m.note && <div className="material-meta material-note">提示：{m.note}</div>}
        <div className="material-meta">
          {fmtSize(m.size_bytes)}
          {` · 正文 ${m.text_len ?? 0} 字`}
          {hasPath ? "" : " · 只导入过内容，没有原文件位置"}
          {lockedCourseId == null ? ` · ${courseName(m.course_id)}` : ""}
          {` · ${m.created_at}`}
        </div>
      </li>
    );
  };

  return (
    <div className="page-stack materials-page">
      <div className="section-head">
        <h2>相关材料</h2>
        <div className="materials-head-note muted">
          {lockedCourseId != null
            ? `这是《${courseName(lockedCourseId)}》导入的材料。`
            : `全部课程的导入材料（按课程分组）。`}
          点「打开」用系统默认程序打开原文件；打不开时会说明原因。
        </div>
      </div>

      {error && (
        <div className="settings-msg err" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {notice && (
        <div className="settings-msg ok" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      {/* 「补存原文件」用的隐藏文件选择器（一次只处理一条） */}
      <input
        ref={fileRef}
        type="file"
        hidden
        aria-label="选择要留副本的原文件"
        onChange={(e) => void handleRepick(e)}
      />

      {loading ? (
        <p className="loading-line">加载中…</p>
      ) : materials.length === 0 ? (
        <p className="empty">
          这里还没有材料。到「课程总览」的「材料」里导入课件、讲义或电子书，它们会出现在这里。
        </p>
      ) : (
        grouped.map(([cid, items]) => (
          <section className="card materials-group" key={cid}>
            {lockedCourseId == null && (
              <div className="materials-group-head">
                <Icon name="folder" size={15} />
                <span>{courseName(cid)}</span>
                <span className="muted">{items.length} 个文件</span>
              </div>
            )}
            <ul className="material-list">{items.map(renderItem)}</ul>
          </section>
        ))
      )}

      {!isTauri() && (
        <p className="muted materials-hint">
          当前是浏览器预览模式：打开 / 定位 / 补存这些动作只桌面版可用，点了会如实报错。
        </p>
      )}
    </div>
  );
}
