// Theme tokens shared by Splash & Login so the two screens stay in sync.
// 工作台 UI（消息/客户）的颜色由 index.css 的 CSS 变量 + tailwind.config.js
// 暴露的 workbench-* class 提供，不在此处定义。

export const FONT_BODY =
  "'Inter', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif";

export const COLOR_TITLE = "#1F2937";
export const COLOR_SUBTITLE = "#7d828b";

export const BLUE_GRADIENT = "linear-gradient(135deg, #5BAEFF 0%, #2196FA 55%, #0F6FE0 100%)";
export const BLUE_GRADIENT_HOVER = "linear-gradient(135deg, #6FBAFF 0%, #1F8AE5 55%, #0E66CF 100%)";

// Sidebar 选中态使用的强调色，不复用 --wb-accent —— 该值视觉对比已校准。
export const WORKBENCH_BLUE = "#348fe9";
export const WORKBENCH_NAV_TEXT = "#2F4566";

// Primary action surface — pastel-leaning blue tuned to sit alongside the
// soft chat bubble palette without screaming. Earlier tokens used Tailwind
// blue-500/700 (high saturation) and clashed with the surrounding pastel
// theme; this gradient stays in the same hue family but at lower saturation
// and lighter values so the button reads as primary without overpowering
// the conversation.
export const WORKBENCH_ACTION_GRADIENT = "linear-gradient(135deg, #B7D2EA 0%, #97B7D7 100%)";
export const WORKBENCH_ACTION_GRADIENT_HOVER = "linear-gradient(135deg, #A6C4E1 0%, #82A6CB 100%)";

// Wave palette (matches the splash bottom scene, lighter mix).
export const WAVE_FILLS = {
  back: "#E0E7FF",
  warm: "#FCE7B8",
  mint: "#DCEFE2",
};

/** 标题栏与侧边栏共用的"毛玻璃"样式。三者必须像素级一致，否则交界处会出现
 *  色差带（参见 plans 里"圆角恢复"的色差排查）。统一在此处维护，调用方 spread。 */
export const FROSTED_GLASS_STYLE = {
  background: "rgba(220,234,248,0.72)",
  backdropFilter: "saturate(160%) blur(20px)",
  WebkitBackdropFilter: "saturate(160%) blur(20px)",
} as const;

// ─── 动效约定 ────────────────────────────────────────────────────────────
//
// 全局过渡时长约定。新加动效请优先复用这些常量,避免散落的 magic number
// 造成时长不统一(用户感知"有的快有的慢")。
//
//   - quick(150ms):微交互(hover/active 按钮、checkbox)
//   - normal(200ms):状态切换(loading↔data↔empty、面板出入场)
//   - slow(300ms):页面级切换(Workbench section、Login↔Workbench)
//
// framer-motion 用 seconds,使用时除以 1000:`duration: TRANSITION_DURATIONS.normal / 1000`。

export const TRANSITION_DURATIONS = {
  quick: 256,
  normal: 384,
  slow: 512,
} as const;

/** framer-motion 用的"标准 easing"(ease-out 风格,出入场都收敛快)。 */
export const TRANSITION_EASE = [0.2, 0.7, 0.2, 1] as const;
