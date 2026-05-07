// Theme tokens shared by Splash & Login so the two screens stay in sync.

export const FONT_BODY =
  "'Inter', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif";
export const WORKBENCH_NUMERIC_FONT =
  "'SFMono-Regular', 'SF Mono', 'Roboto Mono', Menlo, Consolas, monospace";

export const COLOR_TITLE = "#1F2937";
export const COLOR_SUBTITLE = "#7d828b";
export const COLOR_HINT = "#7e8693";
export const COLOR_MUTED = "#A0AEC0";

export const BLUE_GRADIENT = "linear-gradient(135deg, #5BAEFF 0%, #2196FA 55%, #0F6FE0 100%)";
export const BLUE_GRADIENT_HOVER = "linear-gradient(135deg, #6FBAFF 0%, #1F8AE5 55%, #0E66CF 100%)";
export const WORKBENCH_ACTIVE_BG = "#EAF2FF";
export const WORKBENCH_HOVER_BG = "#F7FAFD";
export const WORKBENCH_SOFT_BG = "#F4F8FE";
export const WORKBENCH_SURFACE = "#FFFFFF";
export const WORKBENCH_SURFACE_SUBTLE = "#F7FAFD";
export const WORKBENCH_BLUE = "#348fe9";
export const WORKBENCH_BLUE_HOVER = "#1D4ED8";
export const WORKBENCH_BORDER = "#D8E3F0";
export const WORKBENCH_LINE_SUBTLE = "#E8EEF6";
export const WORKBENCH_LINE_STRONG = "#BFD0E7";
export const WORKBENCH_TEXT_PRIMARY = "#1F2937";
export const WORKBENCH_TEXT_SECONDARY = "#5F6F86";
export const WORKBENCH_TEXT_MUTED = "#8A96A8";
export const WORKBENCH_MUTED_TEXT = "#8A96A8";
export const WORKBENCH_NAV_TEXT = "#2F4566";
export const WORKBENCH_OUT_BUBBLE = "#E7F1FC";
export const WORKBENCH_OUT_BUBBLE_BORDER = "#C7DBF2";
// Primary action surface — pastel-leaning blue tuned to sit alongside the
// soft chat bubble palette without screaming. Earlier tokens used Tailwind
// blue-500/700 (high saturation) and clashed with the surrounding pastel
// theme; this gradient stays in the same hue family but at lower saturation
// and lighter values so the button reads as primary without overpowering
// the conversation.
export const WORKBENCH_ACTION_GRADIENT = "linear-gradient(135deg, #B7D2EA 0%, #97B7D7 100%)";
export const WORKBENCH_ACTION_GRADIENT_HOVER = "linear-gradient(135deg, #A6C4E1 0%, #82A6CB 100%)";

// Pastel halo colors used as ambient backdrops.
export const HALO_BLUE = "#EEF2FF";
export const HALO_PEACH = "#FFE2C7";
export const HALO_MINT = "#DCEFE2";

// Wave palette (matches the splash bottom scene, lighter mix).
export const WAVE_FILLS = {
  back: "#E0E7FF",
  mid: "#D6E4FF",
  warm: "#FCE7B8",
  mint: "#DCEFE2",
};
