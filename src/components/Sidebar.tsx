import { NavLink } from "react-router-dom";
import { NAV_ITEMS, type NavItem } from "../nav";
import Mascot from "./Mascot";
import Icon from "./Icon";

/** 按 `group` 把导航项切成有序分组（保持 NAV_ITEMS 里的原始顺序） */
function groupItems(): Array<{ name: string; items: NavItem[] }> {
  const out: Array<{ name: string; items: NavItem[] }> = [];
  for (const item of NAV_ITEMS) {
    const last = out[out.length - 1];
    if (last && last.name === item.group) last.items.push(item);
    else out.push({ name: item.group, items: [item] });
  }
  return out;
}

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        {/* 品牌标记 = **迷你 App 图标**：装的就是吉祥物母版，与 exe / favicon 同一形象 */}
        <span className="brand-mark">
          <Mascot size={32} />
        </span>
        <span>
          <span className="brand-name">春晓</span>
          <span className="brand-sub">学习助手</span>
        </span>
      </div>
      <nav className="nav">
        {groupItems().map((g) => (
          <div key={g.name}>
            <div className="nav-group">{g.name}</div>
            {g.items.map((item) => (
              <NavLink
                key={item.key}
                to={item.path}
                title={item.planned ? "该板块尚未开放" : item.label}
                className={({ isActive }) =>
                  "nav-item" + (isActive ? " active" : "") + (item.planned ? " planned" : "")
                }
              >
                <Icon name={item.icon} className="nav-icon" />
                <span className="nav-label">{item.label}</span>
                {item.planned && <span className="nav-flag">未开放</span>}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        <Icon name="lock" />
        <span>本地单机 · 数据保存在本机</span>
      </div>
    </aside>
  );
}
