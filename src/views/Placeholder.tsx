interface PlaceholderProps {
  badge: string;
  title: string;
  desc: string;
  modules: string[];
}

/** M1+ 版块占位页：写明规划内容，明确"尚未实现"，不假装已落地 */
export default function Placeholder({ badge, title, desc, modules }: PlaceholderProps) {
  return (
    <div className="placeholder">
      <span className="badge">{badge}</span>
      <h2 style={{ margin: 0 }}>{title}</h2>
      <p className="muted" style={{ marginTop: 4 }}>{desc}</p>
      <div className="card" style={{ marginTop: 8 }}>
        <h3>本版块规划（骨架已就位，功能未实现）</h3>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
          {modules.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
