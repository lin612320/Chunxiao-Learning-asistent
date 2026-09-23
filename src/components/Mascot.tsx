import mascotUrl from "../assets/mascot.svg";

/**
 * 春晓的形象 —— 「晨光云朵」：一朵云托着初升的朝阳，眯眼笑，云顶左侧一株嫩芽。
 *
 * ⚠ **不要在这里重画形象**：`src/assets/mascot.svg` 是**唯一母版**，
 *   App 图标（`scripts/make-icons.ps1`）也从同一份母版产出 —— 因此
 *   "界面里看到的形象"与"exe / 任务栏 / favicon 上的形象"永远一致。
 *   用 `<img>` 引用而不是把 SVG 抄成 JSX，正是为了根除两份实现慢慢漂移的老问题；
 *   矢量本身在任意尺寸都清晰，不需要多套位图。
 *
 * 形象自带的配色（白云 / 暖橙朝阳 / 春绿嫩芽）在亮色与暗色底上都成立，
 * 所以不需要走 `currentColor`，也就不受主题切换影响。
 */
export interface MascotProps {
  /** 显示边长（px）。宽高一致，避免变形。 */
  size?: number;
  className?: string;
  /**
   * 无障碍文本。默认空字符串 —— 形象属于**装饰性**图像，读屏软件不该念它；
   * 只有把它当"内容"用（例如空状态的主视觉）时才需要传。
   */
  alt?: string;
}

export default function Mascot({ size = 96, className, alt = "" }: MascotProps) {
  return (
    <img
      src={mascotUrl}
      width={size}
      height={size}
      alt={alt}
      className={className}
      draggable={false}
      // 形象只用于装饰与氛围，不参与布局度量，避免拖慢首屏
      decoding="async"
    />
  );
}
