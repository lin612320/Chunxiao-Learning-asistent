import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { callRust, invokeStrict, isTauri } from "../lib/tauri";
import { useCourses } from "../hooks/useCourses";
import { useSettings } from "../hooks/useSettings";
import {
  allocId,
  loadSampleDb,
  saveSampleDb,
  type MaterialItem,
  type PriorItem,
} from "../data/sample";
import {
  extractMaterialB64,
  fmtSize,
  needsVisionModel,
  noteForUser,
  readFileAsB64,
  storeMaterialFile,
  IMPORT_ACCEPT,
  MAX_IMPORT_BYTES,
} from "../lib/materials";
import { transcribeWithModel, VISION_MAX_CHARS, VISION_NOTE } from "../lib/vision";
// R1：把本课对话提炼成先验知识（组件自包含，课程页只负责挂载与刷新）
import PriorFromChatCard from "../components/PriorFromChatCard";
import Icon from "../components/Icon";
import { PRIOR_FROM_CHAT_CHANGED } from "../lib/priorfromchat";
import { assistantPath, rememberLastCourseId } from "../lib/courseScope";
import {
  extractHeadings,
  generatePriorSkeleton,
  PRIOR_CONFIDENCE,
  PRIOR_SOURCE,
  PRIOR_SOURCE_REF,
  type PriorDraft,
  type PriorMaterialHint,
} from "../lib/priorgen";

type Tab = "prior" | "materials";

/** 一次导入里每个文件的归类（M2：本地提取 / 模型解析 / 需视觉模型但未配置 ……） */
type ImportBucket = "local" | "model" | "need_vision" | "model_failed" | "no_text";

const BUCKET_LABEL: Record<ImportBucket, string> = {
  local: "本机读出来的",
  model: "模型读出来的",
  need_vision: "需要能看图的模型，还没配",
  model_failed: "模型没读出来（只存了文件名）",
  no_text: "没读到正文（只存了文件名）",
};

/** 一次批量导入的结果汇总（**只统计，不改口径**：失败必须逐条可见） */
interface ImportReport {
  counts: Record<ImportBucket, number>;
  failed: Array<{ name: string; reason: string }>;
  notes: Array<{ name: string; note: string }>;
}

/** 入库前的草稿行（M2 契约 §三：必须可勾选、可编辑、默认全选） */
interface DraftRow extends PriorDraft {
  key: string;
  checked: boolean;
}

/** 预览顺序：章节在前，其子项紧随其后（缩进展示） */
function orderDrafts(drafts: DraftRow[]): Array<{ row: DraftRow; depth: number }> {
  const out: Array<{ row: DraftRow; depth: number }> = [];
  const used = new Set<string>();
  for (const top of drafts.filter((d) => !d.parent_topic)) {
    out.push({ row: top, depth: 0 });
    used.add(top.key);
    for (const child of drafts.filter((d) => d.parent_topic === top.topic)) {
      out.push({ row: child, depth: 1 });
      used.add(child.key);
    }
  }
  // 兜底：parent_topic 指向的是子项、或顶层缺失时，剩下的按顶层展示（不会丢条目）
  for (const d of drafts) {
    if (used.has(d.key)) continue;
    out.push({ row: d, depth: 0 });
  }
  return out;
}

export default function Course() {
  const { id } = useParams<{ id: string }>();
  const courseId = Number(id);
  const { findById, loading: coursesLoading } = useCourses();
  const { s, hasKey } = useSettings();

  const [tab, setTab] = useState<Tab>("prior");
  const [prior, setPrior] = useState<PriorItem[]>([]);
  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);
  /** R9：一键核对进行中（按钮禁用，避免重复点） */
  const [verifyingAll, setVerifyingAll] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // —— M2：AI 生成知识骨架（生成 → 预览 → 用户确认 → 入库）——
  const [drafts, setDrafts] = useState<DraftRow[] | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [genMsg, setGenMsg] = useState<string | null>(null);
  const [genRaw, setGenRaw] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  const course = findById(courseId);

  const load = useCallback(async () => {
    if (!Number.isFinite(courseId)) {
      setError("课程编号不对。");
      setLoading(false);
      return;
    }
    setLoading(true);
    if (isTauri()) {
      const p = await callRust<PriorItem[]>("prior_list", { courseId });
      const m = await callRust<MaterialItem[]>("materials_list", { courseId });
      setPrior(Array.isArray(p) ? p : []);
      setMaterials(Array.isArray(m) ? m : []);
    } else {
      const db = loadSampleDb();
      setPrior(db.prior.filter((x) => x.course_id === courseId));
      setMaterials(db.materials.filter((x) => x.course_id === courseId));
    }
    setLoading(false);
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  // R1：从对话提炼先验知识入库后刷新本页先验列表。
  // 用自定义事件而不是回调 props：提炼卡片不该知道课程页的数据层（`load`）；
  // detail = {courseId, count}，只响应本课程的事件。
  useEffect(() => {
    function onPriorFromChatSaved(e: Event) {
      const detail = (e as CustomEvent<{ courseId?: number }>).detail;
      if (detail?.courseId == null || detail.courseId === courseId) void load();
    }
    window.addEventListener(PRIOR_FROM_CHAT_CHANGED, onPriorFromChatSaved);
    return () => window.removeEventListener(PRIOR_FROM_CHAT_CHANGED, onPriorFromChatSaved);
  }, [courseId, load]);

  /** 标记「已核对」：AI 生成条目的必经过渡，写入失败必须可见 */
  async function handleVerify(item: PriorItem) {
    setPendingId(item.id);
    try {
      if (isTauri()) {
        await invokeStrict<void>("prior_verify", { id: item.id, verified: true });
      } else {
        const db = loadSampleDb();
        db.prior = db.prior.map((x) => (x.id === item.id ? { ...x, verified: 1 } : x));
        saveSampleDb(db);
      }
      setPrior((prev) => prev.map((x) => (x.id === item.id ? { ...x, verified: 1 } : x)));
      setError(null);
    } catch (e) {
      setError(`标记已核对失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPendingId(null);
    }
  }

  /**
   * R9：**一键核对** —— 把这门课所有「待核对」标为已核对。
   *
   * 用户原话：「核对添加一键核对功能」——原来一门课生成出十几条，就得点十几次「标记已核对」，
   * 而且每点一次一次 IPC（N 次 IPC 是 T20 记过的教训）。
   *
   * ⚠ 两个诚实点：
   *   ① 这是**用户自己的确认动作**，所以先弹一次确认，并写明"一次会标掉多少条"；
   *   ② 只改「是否已核对」这一个标记，不动名称 / 说明 / 来源 —— 核对 ≠ 改写内容。
   */
  async function handleVerifyAll() {
    const pending = prior.filter((p) => !p.verified);
    if (pending.length === 0 || courseId == null) return;
    const ok = window.confirm(
      `把《${course?.name ?? "这门课"}》还没核对的 ${pending.length} 条知识点一次标成「已核对」？\n\n` +
        `只改「是否已核对」这个标记，不会改动它们的名称、说明与来源。`,
    );
    if (!ok) return;
    setVerifyingAll(true);
    try {
      let n = 0;
      if (isTauri()) {
        n = await invokeStrict<number>("prior_verify_all", { courseId });
      } else {
        const db = loadSampleDb();
        n = db.prior.filter((x) => x.course_id === courseId && !x.verified).length;
        db.prior = db.prior.map((x) => (x.course_id === courseId ? { ...x, verified: 1 } : x));
        saveSampleDb(db);
      }
      setPrior((prev) => prev.map((x) => ({ ...x, verified: 1 })));
      setError(null);
      setNotice(`已把 ${n} 条标为「已核对」。`);
    } catch (e) {
      setError(`一键核对失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setVerifyingAll(false);
    }
  }

  /** 删除材料 */
  async function handleDeleteMaterial(m: MaterialItem) {
    if (!window.confirm(`确定删除材料「${m.file_name}」吗？\n只删除本机记录，不会动磁盘上的原文件。`)) return;
    setPendingId(m.id);
    try {
      if (isTauri()) {
        await invokeStrict<void>("material_delete", { id: m.id });
      } else {
        const db = loadSampleDb();
        db.materials = db.materials.filter((x) => x.id !== m.id);
        saveSampleDb(db);
      }
      setMaterials((prev) => prev.filter((x) => x.id !== m.id));
      setError(null);
    } catch (e) {
      setError(`删除材料失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPendingId(null);
    }
  }

  /** 在文件管理器里定位原文件；字节导入的材料没有真实路径，此时不显示这个按钮 */
  async function handleReveal(m: MaterialItem) {
    try {
      await invokeStrict<void>("reveal_in_folder", { path: m.file_path });
      setError(null);
    } catch (e) {
      setError(`打开文件夹失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // -------------------------------------------------------------------------
  // 材料入库（桌面写 SQLite / 预览写 localStorage）
  // -------------------------------------------------------------------------

  async function insertMaterial(
    f: File,
    info: {
      kind: string;
      text: string;
      blocks: number;
      truncated: boolean;
      extractedBy: "local" | "model";
      note: string | null;
    },
  ): Promise<void> {
    if (isTauri()) {
      // R13：**先把原始文件在本机留一份副本**，再入库。
      // 材料的正文是按**字节**提取的（浏览器只给得到字节、给不到绝对路径），
      // 不留副本的话 `file_path` 只能是空字符串 —— 于是「点材料打开原文件」根本无从谈起。
      // 存副本失败**不牵连整条导入**：退回空路径，界面上会如实写「只导入过内容，没有原文件位置」。
      let storedPath = "";
      try {
        storedPath = await storeMaterialFile(f.name, await readFileAsB64(f));
      } catch (e) {
        console.warn("[material] 留副本失败，按「没有原文件位置」导入：", e);
      }
      await invokeStrict<number>("material_add", {
        courseId,
        fileName: f.name,
        filePath: storedPath,
        kind: info.kind,
        sizeBytes: f.size,
        extractedBy: info.extractedBy,
        text: info.text,
        blocks: info.blocks,
        truncated: info.truncated,
        note: info.note,
      });
      return;
    }
    // 浏览器预览：只写进 localStorage 的预览数据（不冒充真实落库）
    const db = loadSampleDb();
    db.materials.unshift({
      id: allocId(db),
      course_id: courseId,
      file_name: f.name,
      file_path: "",
      kind: info.kind,
      size_bytes: f.size,
      extracted_by: info.extractedBy,
      text_len: info.text.length,
      chunk_count: info.text.trim() ? Math.max(1, Math.ceil(info.text.length / 600)) : 0,
      truncated: info.truncated ? 1 : 0,
      note: info.note,
      created_at: new Date().toLocaleString("zh-CN", { hour12: false }).slice(0, 16),
    });
    saveSampleDb(db);
  }

  /**
   * 批量导入：逐个文件走「读字节 → extract_material_b64 →（pdf/图片且已配 Key）视觉转录 → material_add」。
   * - 单个文件失败**不中断整批**，最后汇总分类计数与失败明细；
   * - pdf / 图片未配 Key 时保持 M1 现状：如实提示 + 仍允许以"只有文件名"入库；
   * - 模型转录成功时 `extracted_by = "model"`、`note = "模型解析，非原文"`（**列表里显式展示**）。
   */
  async function handleImport(picked: File[]) {
    if (picked.length === 0) return;
    setImporting(true);
    setReport(null);
    setError(null);
    setNotice(null);
    const counts: Record<ImportBucket, number> = {
      local: 0,
      model: 0,
      need_vision: 0,
      model_failed: 0,
      no_text: 0,
    };
    const failed: ImportReport["failed"] = [];
    const notes: ImportReport["notes"] = [];

    for (let i = 0; i < picked.length; i += 1) {
      const f = picked[i];
      setProgress(`正在导入第 ${i + 1} / ${picked.length} 个：${f.name}`);
      try {
        if (f.size > MAX_IMPORT_BYTES) {
          throw new Error(`文件超过 20 MB 上限（${fmtSize(f.size)}），请先拆分或压缩后再导入。`);
        }
        const dataB64 = await readFileAsB64(f);
        const res = await extractMaterialB64(f.name, dataB64);

        // ① 本机离线提取拿到正文 → 与 M1 完全一致
        if (res.text.trim().length > 0) {
          await insertMaterial(f, {
            kind: res.kind,
            text: res.text,
            blocks: res.blocks,
            truncated: res.truncated,
            extractedBy: "local",
            note: res.note ?? null,
          });
          counts.local += 1;
          const n = (res.note ?? "").trim();
          if (n) notes.push({ name: f.name, note: n });
          continue;
        }

        // ② pdf / 图片：需要视觉（或文件输入）模型
        if (needsVisionModel(res)) {
          if (hasKey) {
            setProgress(
              `正在让能看图的模型读取第 ${i + 1} / ${picked.length} 个：${f.name}（可能要几十秒，先别关窗口）`,
            );
            const vis = await transcribeWithModel(s.ai, f.name, dataB64, res.note ?? null);
            if (vis.ok && vis.text.trim().length > 0) {
              const truncated = res.truncated || vis.text.length >= VISION_MAX_CHARS;
              await insertMaterial(f, {
                kind: res.kind,
                text: vis.text,
                blocks: res.blocks,
                truncated,
                extractedBy: "model",
                note: VISION_NOTE,
              });
              counts.model += 1;
              notes.push({
                name: f.name,
                note:
                  `${VISION_NOTE}：可能有错，请对着原文件核对。` +
                  (truncated ? "（内容过长，已截断到 8 万字）" : ""),
              });
            } else {
              // 转录失败：保留原 note，并把失败原因并入提示（不静默、不假装成功）
              const reason = vis.err ?? "模型没有返回内容。";
              const merged = [(res.note ?? "").trim(), `模型读取失败：${reason}`]
                .filter(Boolean)
                .join("\n");
              await insertMaterial(f, {
                kind: res.kind,
                text: "",
                blocks: res.blocks,
                truncated: res.truncated,
                extractedBy: "local",
                note: merged,
              });
              counts.model_failed += 1;
              notes.push({ name: f.name, note: merged });
            }
          } else {
            // 未配置 Key：如实提示，仍允许以"只有文件名"入库
            await insertMaterial(f, {
              kind: res.kind,
              text: "",
              blocks: res.blocks,
              truncated: res.truncated,
              extractedBy: "local",
              note: res.note ?? null,
            });
            counts.need_vision += 1;
            const n = noteForUser(res);
            if (n) notes.push({ name: f.name, note: n });
          }
          continue;
        }

        // ③ 其它：本机既没取到正文，也不属于"交给视觉模型"的格式（如未知扩展名）
        await insertMaterial(f, {
          kind: res.kind,
          text: "",
          blocks: res.blocks,
          truncated: res.truncated,
          extractedBy: "local",
          note: res.note ?? null,
        });
        counts.no_text += 1;
        const n = noteForUser(res);
        if (n) notes.push({ name: f.name, note: n });
      } catch (e) {
        failed.push({ name: f.name, reason: e instanceof Error ? e.message : String(e) });
      }
    }

    setProgress(null);
    setImporting(false);
    setReport({ counts, failed, notes });
    await load();
  }

  // -------------------------------------------------------------------------
  // M2：AI 生成知识骨架（生成 → 预览 → 用户确认 → prior_add）
  // -------------------------------------------------------------------------

  /** 弱提示：只给文件名 + 本地抽出的标题行，**不发材料全文** */
  async function collectMaterialHints(): Promise<PriorMaterialHint> {
    const names = materials.map((m) => m.file_name);
    if (!isTauri()) {
      // 预览模式没有材料正文，不编造 heading
      return { names, headings: [] };
    }
    try {
      const text = await callRust<string>("material_text_all", { courseId });
      return { names, headings: extractHeadings(typeof text === "string" ? text : "", 40) };
    } catch (e) {
      setNotice(`读取材料标题失败，本次只把文件名作为弱提示：${e instanceof Error ? e.message : String(e)}`);
      return { names, headings: [] };
    }
  }

  async function handleGeneratePrior() {
    if (!course) {
      setError("课程信息还没加载完成，请稍后再试。");
      return;
    }
    setGenBusy(true);
    setError(null);
    setNotice(null);
    setDrafts(null);
    setGenRaw(null);
    setGenMsg("正在整理课程信息…");
    try {
      const hints = await collectMaterialHints();
      setGenMsg("正在整理知识点…（模型正在回答）");
      const r = await generatePriorSkeleton(s.ai, {
        courseName: course.name,
        intro: course.intro ?? null,
        materials: hints,
        onProgress: (n) => setGenMsg(`正在整理知识点…已收到 ${n} 字`),
      });
      setGenRaw(r.raw.trim() ? r.raw : null);
      if (!r.ok) {
        setGenMsg(null);
        setError(`AI 生成失败：${r.error}`);
        return;
      }
      setDrafts(r.items.map((it, i) => ({ ...it, key: `d${i}`, checked: true })));
      setGenMsg(
        `已整理出 ${r.items.length} 条：核对一下（名称和说明都能改，也能取消勾选），然后点「确认保存」——不点就不会存进去。`,
      );
    } catch (e) {
      setGenMsg(null);
      setError(`AI 生成失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGenBusy(false);
    }
  }

  /** 单条入库：source 必填、confidence 0.5、不传 verified（默认 0 = 待核对） */
  async function addPrior(row: PriorDraft, parentId: number | null): Promise<number> {
    const topic = row.topic.trim();
    const summary = row.summary.trim() || null;
    const detail = row.detail.trim() || null;
    if (isTauri()) {
      return await invokeStrict<number>("prior_add", {
        courseId,
        parentId,
        topic,
        summary,
        detail,
        source: PRIOR_SOURCE,
        sourceRef: PRIOR_SOURCE_REF,
        confidence: PRIOR_CONFIDENCE,
      });
    }
    const db = loadSampleDb();
    const id = allocId(db);
    db.prior.push({
      id,
      course_id: courseId,
      parent_id: parentId,
      topic,
      summary,
      detail,
      source: PRIOR_SOURCE,
      source_ref: PRIOR_SOURCE_REF,
      confidence: PRIOR_CONFIDENCE,
      verified: 0,
      created_at: new Date().toLocaleString("zh-CN", { hour12: false }).slice(0, 16),
    });
    saveSampleDb(db);
    return id;
  }

  async function handleCommitDrafts() {
    if (!drafts || drafts.length === 0) return;
    const picked = drafts.filter((d) => d.checked && d.topic.trim().length > 0);
    if (picked.length === 0) {
      setError("没有勾选任何有效条目（知识点名称不能为空），未写入任何内容。");
      return;
    }
    setCommitting(true);
    setError(null);
    setNotice(null);
    try {
      // 先章节、后子项：这样 parentId 一定能匹配到"本次已入库"的条目 id
      const tops = picked.filter((d) => !d.parent_topic);
      const subs = picked.filter((d) => d.parent_topic);
      const idByTopic = new Map<string, number>();
      let added = 0;
      for (const row of [...tops, ...subs]) {
        const parentId = row.parent_topic ? (idByTopic.get(row.parent_topic) ?? null) : null;
        const id = await addPrior(row, parentId);
        idByTopic.set(row.topic, id);
        added += 1;
      }
      setDrafts(null);
      setGenRaw(null);
      setGenMsg(null);
      setNotice(
        `已保存 ${added} 条，标为「AI 生成 · 待核对」：只是新增，没有删掉任何原有条目。请逐条核对后再点「标记已核对」。`,
      );
      await load();
    } catch (e) {
      setError(
        `保存失败（已经存下的会保留，可以重试；没存下的还在上面的预览里）：${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setCommitting(false);
    }
  }

  function patchDraft(key: string, patch: Partial<DraftRow>) {
    setDrafts((prev) => (prev ? prev.map((d) => (d.key === key ? { ...d, ...patch } : d)) : prev));
  }

  function cancelDrafts() {
    setDrafts(null);
    setGenRaw(null);
    setGenMsg(null);
  }

  const draftRows = drafts ? orderDrafts(drafts) : [];
  const selectedCount = drafts ? drafts.filter((d) => d.checked).length : 0;

  if (!Number.isFinite(courseId)) {
    return <p className="empty">课程编号不对。<Link to="/courses">返回课程列表</Link></p>;
  }

  return (
    <div className="page-stack">
      <div className="section-head">
        <div>
          <h2 style={{ marginBottom: 4 }}>{course ? course.name : coursesLoading ? "加载中…" : "课程不存在"}</h2>
          <span className="muted">
            {course
              ? [course.term, course.teacher].filter(Boolean).join(" · ") || "未填学期 / 教师"
              : "该课程可能已被删除"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {/* R1：进入**该课程上下文**的对话页（并把"最近使用的课程"记上，供后续显式带入） */}
          <Link
            to={assistantPath(courseId)}
            className="primary small"
            style={{ textDecoration: "none" }}
            onClick={() => rememberLastCourseId(courseId)}
          >
            与该课程对话
          </Link>
          <Link to="/courses" className="ghost-btn" style={{ textDecoration: "none" }}>
            返回课程列表
          </Link>
        </div>
      </div>

      {course?.intro && <p className="muted">{course.intro}</p>}

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

      <div className="tab-bar">
        <button className={"tab" + (tab === "prior" ? " active" : "")} onClick={() => setTab("prior")}>
          先验知识（{prior.length}）
        </button>
        <button className={"tab" + (tab === "materials" ? " active" : "")} onClick={() => setTab("materials")}>
          材料（{materials.length}）
        </button>
      </div>

      {loading ? (
        <p className="loading-line">加载中…</p>
      ) : tab === "prior" ? (
        <>
        <section className="card">
          <div className="section-head">
            <h3 style={{ margin: 0 }}>先验知识</h3>
            {/* R9：一键核对（只在真有「待核对」条目时出现 —— 没得核对就不摆一个灰按钮） */}
            {(() => {
              const pendingCount = prior.filter((p) => !p.verified).length;
              return pendingCount > 0 ? (
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={verifyingAll || courseId == null}
                  title="把这门课所有「待核对」条目一次标为已核对"
                  onClick={() => void handleVerifyAll()}
                >
                  {verifyingAll ? "核对中…" : `一键核对（${pendingCount} 条）`}
                </button>
              ) : null;
            })()}
          </div>

          {/* M2：AI 生成知识骨架 —— 只生成到预览，必须用户点「确认入库」才写库 */}
          <div className="prior-gen-bar">
            <button
              className="primary small"
              disabled={!hasKey || genBusy || committing}
              title={
                hasKey
                  ? "按课程名和已导入材料的标题整理一版知识点；生成后需要你确认才会保存"
                  : "还没填模型 Key，没法让模型生成"
              }
              onClick={() => void handleGeneratePrior()}
            >
              {genBusy ? (
                "生成中…"
              ) : (
                <>
                  <Icon name="sparkles" />
                  AI 生成知识骨架
                </>
              )}
            </button>
            {!hasKey && (
              <span className="muted" style={{ fontSize: 12 }}>
                还没填模型 Key，暂时不能生成（我们不会用模板假造一份冒充 AI 生成的内容）。
              </span>
            )}
            {!hasKey && (
              <Link to="/settings" className="ghost-btn" style={{ textDecoration: "none" }}>
                去「数据设置」配置 →
              </Link>
            )}
          </div>
          {genMsg && <div className="prior-gen-msg">{genMsg}</div>}
          {genRaw && (
            <details className="prior-raw">
              <summary>查看模型原始输出（AI 生成、未核对；解析失败时用来排障）</summary>
              <pre>{genRaw}</pre>
            </details>
          )}

          {drafts && (
            <div className="prior-drafts">
              <div className="prior-drafts-head">
                <b>生成结果预览（还没保存）</b>
                <span className="src-badge src-ai">AI 生成 · 待核对</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  共 {drafts.length} 条 · 已选 {selectedCount} 条
                </span>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
                知识点名称与一句话说明都能直接改；保存只是<b>新增</b>，不会删掉原有条目。
              </p>
              <ul className="prior-draft-list">
                {draftRows.map(({ row, depth }) => {
                  const parentMissing =
                    depth > 0 &&
                    !!row.parent_topic &&
                    !drafts.some((t) => t.topic === row.parent_topic && t.checked);
                  return (
                    <li
                      key={row.key}
                      className={
                        "prior-draft-item" + (depth > 0 ? " child" : "") + (row.checked ? "" : " off")
                      }
                    >
                      <label className="prior-draft-check">
                        <input
                          type="checkbox"
                          checked={row.checked}
                          onChange={(e) => patchDraft(row.key, { checked: e.target.checked })}
                        />
                      </label>
                      <div className="prior-draft-body">
                        <div className="prior-draft-head">
                          <span className="tag">{depth > 0 ? "子项" : "章节"}</span>
                          {depth > 0 && row.parent_topic && <span className="tag">所属：{row.parent_topic}</span>}
                          {parentMissing && (
                            <span className="tag tag-warn">所属章节没勾 → 保存后会变成最外层的一条</span>
                          )}
                        </div>
                        <input
                          className="prior-draft-input"
                          value={row.topic}
                          placeholder="知识点名称（必填）"
                          onChange={(e) => patchDraft(row.key, { topic: e.target.value })}
                        />
                        <textarea
                          className="prior-draft-input"
                          rows={2}
                          value={row.summary}
                          placeholder="一句话说明"
                          onChange={(e) => patchDraft(row.key, { summary: e.target.value })}
                        />
                        {row.detail && <div className="prior-draft-detail">详情：{row.detail}</div>}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="prior-gen-actions">
                <button
                  className="ghost-btn"
                  disabled={committing}
                  onClick={() => setDrafts((prev) => (prev ? prev.map((d) => ({ ...d, checked: true })) : prev))}
                >
                  全选
                </button>
                <button
                  className="ghost-btn"
                  disabled={committing}
                  onClick={() => setDrafts((prev) => (prev ? prev.map((d) => ({ ...d, checked: false })) : prev))}
                >
                  全不选
                </button>
                <button
                  className="primary small"
                  disabled={committing || selectedCount === 0}
                  onClick={() => void handleCommitDrafts()}
                >
                  {committing ? "保存中…" : `确认保存（${selectedCount} 条）`}
                </button>
                <button className="ghost-btn" disabled={committing} onClick={cancelDrafts}>
                  取消
                </button>
              </div>
            </div>
          )}

          {prior.length === 0 ? (
            <p className="empty">这门课还没有知识点。</p>
          ) : (
            <ul className="prior-list">
              {prior.map((p) => {
                const info = sourceInfo(p);
                return (
                  <li key={p.id} className={"prior-item" + (info.needsCheck ? " unverified" : "")}>
                    <div className="prior-head">
                      <span className="prior-topic">{p.topic}</span>
                      <span className={info.cls}>{info.text}</span>
                      {p.source_ref && <span className="tag">出处：{p.source_ref}</span>}
                    </div>
                    {p.summary && <div className="prior-summary">{p.summary}</div>}
                    {p.detail && <div className="prior-detail">{p.detail}</div>}
                    {info.needsCheck && (
                      <div className="prior-actions">
                        <button
                          className="primary small"
                          disabled={pendingId === p.id}
                          onClick={() => void handleVerify(p)}
                        >
                          {pendingId === p.id ? "保存中…" : "标记已核对"}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {/* R1：与本课对话提炼先验知识（生成 → 预览可勾选可编辑 → 确认才入库） */}
        {course && <PriorFromChatCard courseId={courseId} courseName={course.name} />}
        </>
      ) : (
        <section className="card">
          <div className="section-head">
            <h3 style={{ margin: 0 }}>材料</h3>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={IMPORT_ACCEPT}
                style={{ display: "none" }}
                onChange={(e) => {
                  // 先把 FileList 复制成数组，再清空 input.value：
                  // 清空会让浏览器把 files 置空，直接拿着 FileList 异步读会读不到文件。
                  const picked = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  void handleImport(picked);
                }}
              />
              <button
                className="primary small"
                disabled={importing}
                onClick={() => fileRef.current?.click()}
              >
                {importing ? (
                  "导入中…"
                ) : (
                  <>
                    <Icon name="plus" />
                    导入材料
                  </>
                )}
              </button>
            </div>
          </div>
          <p className="muted hint">
            只导入你有权使用的材料。材料只存在这台电脑上，不会上传。
            {hasKey
              ? "PDF / 图片读不出正文时会交给能看图的模型转写，并标明「这是模型转写的，不是原文」。"
              : "PDF / 图片要先配好能看图的模型才能读到正文。"}
          </p>

          {!isTauri() && (
            <div className="demo-banner">
              <span>
                <b>正式的材料导入只在桌面版可用</b>（桌面版会存到本机并分好小段，方便以后查找引用）。
                现在是网页预览：导入只会存到浏览器里，仅用来试界面
                {hasKey ? "；模型转写仍会真实调用你配置的模型（Key 只存在这台电脑上）" : ""}。
              </span>
            </div>
          )}

          {progress && <div className="import-progress">{progress}</div>}

          {report && (
            <div className={"import-report" + (report.failed.length > 0 ? " has-fail" : "")}>
              <div className="import-report-head">
                这次导入：本机读出 {report.counts.local} 个 / 模型读出 {report.counts.model} 个 / 需要能看图的模型但还没配{" "}
                {report.counts.need_vision} 个
                {report.counts.model_failed > 0 ? ` / ${BUCKET_LABEL.model_failed} ${report.counts.model_failed} 个` : ""}
                {report.counts.no_text > 0 ? ` / ${BUCKET_LABEL.no_text} ${report.counts.no_text} 个` : ""}
                {report.failed.length > 0 ? ` / 失败 ${report.failed.length} 个` : ""}
                <button className="ghost-btn" style={{ marginLeft: 10 }} onClick={() => setReport(null)}>
                  知道了
                </button>
              </div>
              {report.failed.length > 0 && (
                <ul className="import-report-list">
                  {report.failed.map((f, i) => (
                    <li key={`f${i}`}>
                      <b>{f.name}</b>：{f.reason}
                    </li>
                  ))}
                </ul>
              )}
              {report.notes.length > 0 && (
                <ul className="import-report-list">
                  {report.notes.map((n, i) => (
                    <li key={`n${i}`}>
                      <b>{n.name}</b>：{n.note}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {materials.length === 0 ? (
            <p className="empty">还没有材料。</p>
          ) : (
            <ul className="material-list">
              {materials.map((m) => (
                <li key={m.id} className="material-item">
                  <div className="material-head">
                    <span className="material-name">{m.file_name}</span>
                    {m.kind && <span className="tag">.{m.kind}</span>}
                    <span className="tag">
                      {m.extracted_by === "model" ? "模型转写" : "本机直接读出"}
                    </span>
                    {typeof m.chunk_count === "number" && (
                      <span className={"tag" + (m.chunk_count > 0 ? "" : " tag-warn")}>
                        已分成 {m.chunk_count} 段
                      </span>
                    )}
                    {m.truncated ? <span className="tag tag-warn">只保留了一部分</span> : null}
                    <div className="material-actions">
                      {m.file_path ? (
                        <button
                          className="ghost-btn"
                          title="在文件管理器里定位这个文件"
                          onClick={() => void handleReveal(m)}
                        >
                          在文件夹中打开
                        </button>
                      ) : null}
                      <button
                        className="danger-btn"
                        disabled={pendingId === m.id}
                        onClick={() => void handleDeleteMaterial(m)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  {/* M2 契约 §2.3：模型转录必须显式标注「模型解析，非原文」 */}
                  {m.extracted_by === "model" && (
                    <div className="material-note-warn">
                      这是模型转写的，不是原文：可能有错，请对着原文件核对后再当依据用。
                    </div>
                  )}
                  {m.note && <div className="material-meta material-note">提示：{m.note}</div>}
                  <div className="material-meta">
                    {fmtSize(m.size_bytes)}
                    {` · 正文 ${m.text_len ?? 0} 字`}
                    {m.file_path ? "" : " · 只导入过内容，没有原文件位置"}
                    {` · ${m.created_at}`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/** 来源徽标：本项目的核心诚实口径 —— source 必填，AI 生成默认标「待核对」 */
function sourceInfo(p: PriorItem): { text: string; cls: string; needsCheck: boolean } {
  if (p.source === "ai") {
    return p.verified
      ? { text: "AI 生成 · 已核对", cls: "src-badge src-ok", needsCheck: false }
      : { text: "AI 生成 · 待核对", cls: "src-badge src-ai", needsCheck: true };
  }
  const named: Record<string, string> = {
    textbook: "教材",
    web: "网络",
    user: "我自己的笔记",
  };
  return {
    text: `来源：${named[p.source] ?? p.source}`,
    cls: "src-badge" + (p.source === "user" ? " src-user" : ""),
    needsCheck: false,
  };
}

