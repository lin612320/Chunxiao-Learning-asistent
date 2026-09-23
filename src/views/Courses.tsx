import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCourses } from "../hooks/useCourses";
import Icon from "../components/Icon";

type Filter = "active" | "archived" | "all";

export default function Courses() {
  const nav = useNavigate();
  const { courses, loading, error, create, archive, remove, setError } = useCourses();

  const [filter, setFilter] = useState<Filter>("active");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", term: "", teacher: "", intro: "" });
  const [busy, setBusy] = useState(false);

  const shown = useMemo(() => {
    if (filter === "active") return courses.filter((c) => !c.archived);
    if (filter === "archived") return courses.filter((c) => c.archived);
    return courses;
  }, [courses, filter]);

  async function handleCreate() {
    if (!form.name.trim()) {
      setError("课程名称不能为空。");
      return;
    }
    setBusy(true);
    const id = await create(form);
    setBusy(false);
    if (id !== null) {
      setForm({ name: "", term: "", teacher: "", intro: "" });
      setShowForm(false);
      nav(`/course/${id}`);
    }
  }

  async function handleArchive(id: number, archived: boolean) {
    await archive(id, archived);
  }

  async function handleDelete(id: number, name: string) {
    const ok = window.confirm(
      `确定删除课程「${name}」吗？\n该课程的先验知识与材料会一并删除，且无法撤销。`,
    );
    if (ok) await remove(id);
  }

  return (
    <div className="page-stack">
      <div className="section-head">
        <h2>课程</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="ghost-btn" onClick={() => setShowForm((v) => !v)}>
            {showForm ? (
              "收起表单"
            ) : (
              <>
                <Icon name="plus" />
                新建课程
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="settings-msg err" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {showForm && (
        <section className="card">
          <h3>新建课程</h3>
          <p className="muted hint">只有课程名称是必填；其余可以之后再补。</p>
          <div className="form-grid">
            <label>
              <span>课程名称 *</span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：数据结构与算法"
                autoFocus
              />
            </label>
            <label>
              <span>学期（选填）</span>
              <input
                value={form.term}
                onChange={(e) => setForm({ ...form, term: e.target.value })}
                placeholder="例如：2026-秋"
              />
            </label>
            <label>
              <span>授课教师（选填）</span>
              <input
                value={form.teacher}
                onChange={(e) => setForm({ ...form, teacher: e.target.value })}
                placeholder="例如：王老师"
              />
            </label>
            <label className="wide">
              <span>课程简介（选填）</span>
              <input
                value={form.intro}
                onChange={(e) => setForm({ ...form, intro: e.target.value })}
                placeholder="一句话说明这门课讲什么"
              />
            </label>
          </div>
          <button className="primary" disabled={busy || !form.name.trim()} onClick={() => void handleCreate()}>
            {busy ? "创建中…" : "创建课程"}
          </button>
        </section>
      )}

      <div className="todo-list-bar">
        {(
          [
            ["active", "进行中"],
            ["archived", "已归档"],
            ["all", "全部"],
          ] as Array<[Filter, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            className={"chip" + (filter === key ? " chip-active" : "")}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="loading-line">加载中…</p>
      ) : shown.length === 0 ? (
        <p className="empty">
          {courses.length === 0
            ? "还没有课程。点右上角「＋ 新建课程」开始。"
            : "这个筛选下没有课程。"}
        </p>
      ) : (
        <div className="course-grid">
          {shown.map((c) => (
            <div
              key={c.id}
              className={"course-card" + (c.archived ? " archived" : "")}
              role="button"
              tabIndex={0}
              onClick={() => nav(`/course/${c.id}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") nav(`/course/${c.id}`);
              }}
            >
              <div className="course-name">{c.name}</div>
              <div className="course-meta">
                {c.term && <span className="tag">{c.term}</span>}
                {c.teacher && <span className="tag">{c.teacher}</span>}
                {c.archived ? <span className="tag tag-warn">已归档</span> : null}
              </div>
              {c.intro && <div className="course-intro">{c.intro}</div>}
              <div className="course-card-actions">
                <button
                  className="ghost-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleArchive(c.id, !c.archived);
                  }}
                >
                  {c.archived ? "取消归档" : "归档"}
                </button>
                <button
                  className="danger-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDelete(c.id, c.name);
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
