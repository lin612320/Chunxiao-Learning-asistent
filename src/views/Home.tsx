import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useCourses } from "../hooks/useCourses";
import Mascot from "../components/Mascot";
import Icon from "../components/Icon";

export default function Home() {
  const { courses, loading, error } = useCourses();

  const active = useMemo(() => courses.filter((c) => !c.archived), [courses]);
  const archived = useMemo(() => courses.filter((c) => c.archived), [courses]);

  const recent = useMemo(
    () =>
      [...active]
        .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
        .slice(0, 5),
    [active],
  );

  const stats = [
    { label: "课程总数", value: courses.length },
    { label: "进行中", value: active.length },
    { label: "已归档", value: archived.length },
  ];

  return (
    <div className="home">
      {/* 欢迎区：吉祥物只作氛围、不作信息载体 → alt 留空（读屏软件不该念装饰图） */}
      <div className="home-welcome">
        <Mascot size={96} className="home-mascot" />
        <div>
          <h2>你好，同学</h2>
          <span className="muted">{todayStr()}</span>
        </div>
        <span className="tag tag-brand">数据保存在本机</span>
      </div>

      {error && <div className="settings-msg err">{error}</div>}

      {/* 统计卡 */}
      <div className="stat-row">
        {stats.map((s) => (
          <div className="card stat" key={s.label}>
            <div className="stat-value">{s.value}</div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="home-grid">
        {/* 最近课程 */}
        <section className="card home-panel">
          <div className="panel-head">
            <h3>最近课程</h3>
            <Link to="/courses" className="more-link">
              全部课程
              <Icon name="chevron-right" size={14} />
            </Link>
          </div>
          {loading ? (
            <p className="loading-line">加载中…</p>
          ) : recent.length === 0 ? (
            <div className="empty-state">
              <Icon name="book" />
              <span className="empty-title">还没有课程</span>
              <span className="empty-hint">
                先建一门课，再把课件导进来，就可以开始整理知识与提问了。
              </span>
            </div>
          ) : (
            <ul className="mini-docs">
              {recent.map((c) => (
                <li key={c.id}>
                  <div className="mini-doc-main">
                    <Link to={`/course/${c.id}`} className="mini-title">
                      {c.name}
                    </Link>
                    <span className="muted mini-path">
                      {[c.term, c.teacher].filter(Boolean).join(" · ") || "未填学期 / 教师"}
                    </span>
                    <span className="faint mini-time">{c.created_at}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 使用边界：保留诚实边界，但**只说用户需要知道的**，不写实现口径 */}
        <section className="card home-panel">
          <div className="panel-head">
            <h3>使用边界</h3>
          </div>
          <ul className="notice-list">
            <li>
              <b>面向课后理解与复习</b>：答疑、整理笔记、自测练习；<b>不面向考试场景</b>。
            </li>
            <li>
              <b>本地单机</b>：课程、材料与对话都保存在这台电脑上，不做云同步。
            </li>
            <li>
              <b>AI 说的要自己核对</b>：标了「待核对」的内容确认后再当依据用，以教材与课堂为准。
            </li>
          </ul>
        </section>
      </div>

      {/* 三个快捷入口 */}
      <section className="card">
        <div className="panel-head">
          <h3>快捷入口</h3>
        </div>
        <div className="quick-grid">
          <Link to="/courses" className="quick-item">
            <span className="quick-icon">
              <Icon name="plus" />
            </span>
            新建课程
          </Link>
          <Link to="/assistant" className="quick-item">
            <span className="quick-icon">
              <Icon name="chat" />
            </span>
            开始对话
          </Link>
          <Link to="/settings" className="quick-item">
            <span className="quick-icon">
              <Icon name="gear" />
            </span>
            数据设置
          </Link>
        </div>
      </section>
    </div>
  );
}

function todayStr(): string {
  const d = new Date();
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week}`;
}
