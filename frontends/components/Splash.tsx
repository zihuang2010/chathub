import { useEffect, type CSSProperties, type ReactNode } from "react";
import { ShieldCheck, Zap, Share2 } from "lucide-react";

interface SplashProps {
  onReady?: () => void;
  durationMs?: number;
}

const FONT_BODY =
  "'Inter', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif";

// ─── Data ─────────────────────────────────────────────────────────────────

type DotSpec = { x: number; y: number; size: number; color: string; opacity?: number };

// Decorative dots scattered around the illustration halo
const HALO_DOTS: DotSpec[] = [
  { x: 30, y: 28, size: 16, color: "#BFD0FF", opacity: 0.7 },
  { x: 88, y: 52, size: 9, color: "#DDD0FF", opacity: 0.65 },
  { x: 466, y: 32, size: 20, color: "#FFE2C7", opacity: 0.6 },
  { x: 14, y: 166, size: 14, color: "#C8E6D2", opacity: 0.65 },
  { x: 486, y: 160, size: 18, color: "#FFD2DF", opacity: 0.55 },
  { x: 445, y: 198, size: 10, color: "#C7EFEF", opacity: 0.65 },
  { x: 24, y: 278, size: 18, color: "#FCE7B8", opacity: 0.6 },
  { x: 466, y: 280, size: 14, color: "#DBE5FF", opacity: 0.6 },
  { x: 62, y: 298, size: 8, color: "#BFD0FF", opacity: 0.55 },
  { x: 428, y: 108, size: 12, color: "#E0D6FF", opacity: 0.55 },
];

// 8-dot rotating spinner (parent rotates; per-dot opacity creates the comet trail)
const SPINNER_DOTS: DotSpec[] = [
  { x: 20, y: 0, size: 8, color: "#3D7BFF", opacity: 1 },
  { x: 34, y: 6, size: 7, color: "#60A5FA", opacity: 0.9 },
  { x: 42, y: 20, size: 7, color: "#FCD34D", opacity: 0.85 },
  { x: 36, y: 34, size: 7, color: "#F59E0B", opacity: 0.8 },
  { x: 20, y: 40, size: 7, color: "#10B981", opacity: 0.75 },
  { x: 6, y: 34, size: 7, color: "#34D399", opacity: 0.7 },
  { x: 0, y: 20, size: 7, color: "#A78BFA", opacity: 0.6 },
  { x: 6, y: 6, size: 7, color: "#C4B5FD", opacity: 0.5 },
];

// Skyline rectangles in the bottom scene
const BUILDINGS = [
  { x: 0, y: 82, w: 28, h: 38, color: "#C7D2FE" },
  { x: 28, y: 48, w: 38, h: 72, color: "#DBE5FF" },
  { x: 66, y: 15, w: 32, h: 105, color: "#C7D2FE" },
  { x: 98, y: 70, w: 26, h: 50, color: "#DBE5FF" },
  { x: 124, y: 32, w: 44, h: 88, color: "#C7D2FE" },
  { x: 168, y: 60, w: 30, h: 60, color: "#DBE5FF" },
  { x: 198, y: 5, w: 40, h: 115, color: "#C7D2FE" },
  { x: 238, y: 78, w: 32, h: 42, color: "#DBE5FF" },
  { x: 270, y: 42, w: 48, h: 78, color: "#C7D2FE" },
  { x: 318, y: 65, w: 30, h: 55, color: "#DBE5FF" },
  { x: 348, y: 25, w: 36, h: 95, color: "#C7D2FE" },
  { x: 384, y: 64, w: 38, h: 56, color: "#DBE5FF" },
];

// Feature pills under the loading section
const FEATURES = [
  { color: "#10B981", bg: "#D1FAE5", stroke: "#6EE7B7", label: "安全可靠", Icon: ShieldCheck },
  { color: "#3B82F6", bg: "#DBEAFE", stroke: "#93C5FD", label: "高效聚合", Icon: Zap },
  { color: "#FB923C", bg: "#FFEDD5", stroke: "#FDBA74", label: "轻量便捷", Icon: Share2 },
];

// Satellite "twinkling" mini-bubbles that drift around each main bubble.
// Coordinates are local to the parent bubble's container.
type Satellite = {
  x: number;
  y: number;
  size: number;
  color: string;
  dx: number; // drift X (px) at the midpoint of the loop
  dy: number; // drift Y (px) at the midpoint of the loop
  delay: number; // ms
  duration: number; // ms — varied so satellites twinkle out of sync
};

const SATELLITES_BLUE: Satellite[] = [
  { x: -18, y: 50, size: 9, color: "#A8CFFF", dx: 4, dy: -3, delay: 0, duration: 2800 },
  { x: -24, y: 130, size: 7, color: "#BFD9FF", dx: -3, dy: 4, delay: 600, duration: 2400 },
  { x: 60, y: -16, size: 6, color: "#7BB6FF", dx: 3, dy: -2, delay: 200, duration: 2600 },
  { x: 200, y: -10, size: 5, color: "#A8CFFF", dx: -2, dy: -3, delay: 1100, duration: 2900 },
  { x: 290, y: 70, size: 8, color: "#BFD9FF", dx: -3, dy: 3, delay: 400, duration: 3200 },
  { x: 296, y: 150, size: 6, color: "#7BB6FF", dx: -2, dy: -2, delay: 1300, duration: 2500 },
  { x: 230, y: 218, size: 5, color: "#A8CFFF", dx: 2, dy: 3, delay: 800, duration: 2700 },
];

const SATELLITES_GREEN: Satellite[] = [
  { x: -14, y: 28, size: 6, color: "#7CE3A8", dx: 3, dy: -2, delay: 0, duration: 2400 },
  { x: -10, y: 70, size: 5, color: "#C8F0DC", dx: -2, dy: 3, delay: 700, duration: 2800 },
  { x: 16, y: -10, size: 4, color: "#A8F0C5", dx: 2, dy: -2, delay: 300, duration: 2600 },
  { x: 116, y: 30, size: 6, color: "#7CE3A8", dx: -3, dy: 2, delay: 1100, duration: 3000 },
  { x: 110, y: 78, size: 5, color: "#A8F0C5", dx: -2, dy: 3, delay: 500, duration: 2500 },
];

const SATELLITES_WHITE: Satellite[] = [
  { x: -16, y: 40, size: 7, color: "#D6DEE9", dx: 3, dy: -3, delay: 0, duration: 2600 },
  { x: -10, y: 90, size: 5, color: "#E8EDF4", dx: -2, dy: 3, delay: 800, duration: 2400 },
  { x: 30, y: -12, size: 5, color: "#C5CFE0", dx: 2, dy: -2, delay: 400, duration: 2700 },
  { x: 156, y: 28, size: 6, color: "#D6DEE9", dx: -3, dy: 2, delay: 1100, duration: 3200 },
  { x: 156, y: 80, size: 7, color: "#E8EDF4", dx: -2, dy: 3, delay: 600, duration: 2900 },
];

// ─── Splash ───────────────────────────────────────────────────────────────

export function Splash({ onReady, durationMs = 6500 }: SplashProps) {
  useEffect(() => {
    if (!onReady) return;
    const t = window.setTimeout(onReady, durationMs);
    return () => window.clearTimeout(t);
  }, [durationMs, onReady]);

  return (
    <div
      className="absolute inset-0 select-none overflow-hidden bg-white"
      style={{ fontFamily: FONT_BODY }}
    >
      <style>{KEYFRAMES}</style>

      <main className="relative flex h-full w-full flex-col items-center pt-14">
        <Illustration />

        <h1
          className="mt-[18px] text-[32px] font-semibold text-[#1F2937]"
          style={{
            letterSpacing: "0.08em",
            paddingLeft: "0.08em",
            animation: "splashFadeUp 700ms 200ms backwards ease-out",
          }}
        >
          匠多多企微聚合平台
        </h1>

        <p
          className="mt-[18px] text-[13px] text-[#7d828b]"
          style={{
            letterSpacing: "0.12em",
            paddingLeft: "0.18em",
            animation: "splashFadeUp 700ms 360ms backwards ease-out",
          }}
        >
          聚合多聊 · 高效沟通 · 一处掌控
        </p>

        <div className="mt-7" style={{ animation: "splashFadeUp 700ms 540ms backwards ease-out" }}>
          <Spinner />
        </div>

        <div className="mt-8" style={{ animation: "splashFadeUp 700ms 720ms backwards ease-out" }}>
          <Features />
        </div>
      </main>

      <BottomScene />
    </div>
  );
}

// ─── Illustration ─────────────────────────────────────────────────────────

function Illustration() {
  return (
    <div
      className="relative h-[340px] w-[520px]"
      style={{ animation: "splashIllustrationIn 900ms ease-out backwards" }}
    >
      <Halos />
      {HALO_DOTS.map((d, i) => (
        <AbsDot key={i} {...d} animation="splashDotFloat 5s ease-in-out infinite" />
      ))}
      {/* Stacking order — blue is on top */}
      <BubbleWhite />
      <BubbleGreen />
      <BubbleBlue />
    </div>
  );
}

function Halos() {
  return (
    <>
      <div
        aria-hidden
        className="absolute h-[360px] w-[500px]"
        style={{
          left: 10,
          top: -10,
          background: "radial-gradient(ellipse at center, #EEF2FF 0%, rgba(255,255,255,0) 90%)",
          animation: "splashHaloPulse 8s ease-in-out infinite",
          transformOrigin: "center",
        }}
      />
      <div
        aria-hidden
        className="absolute h-[340px] w-[420px]"
        style={{
          left: 50,
          background:
            "radial-gradient(ellipse 50% 47.5% at 45% 50%, #E5EBFF 0%, #EFF2FF 50%, rgba(255,255,255,0) 100%)",
        }}
      />
      <div
        aria-hidden
        className="absolute h-[280px] w-[320px] opacity-45"
        style={{
          left: 100,
          top: 30,
          background:
            "radial-gradient(ellipse at center, #D4DEFF 0%, #E8EDFF 60%, rgba(242,245,255,0) 100%)",
        }}
      />
    </>
  );
}

// ─── Bubbles ──────────────────────────────────────────────────────────────

function BubbleBlue() {
  const pop = "splashBubblePop 800ms 180ms backwards cubic-bezier(.2,.7,.2,1)";
  return (
    <div className="absolute h-[240px] w-[280px]" style={{ left: 120, top: 65, animation: pop }}>
      <svg width="280" height="240" viewBox="0 0 280 240" style={dropShadow("#1989FA55", 42, 8)}>
        <defs>
          <linearGradient id="splashBlueGrad" x1="0%" y1="0%" x2="60%" y2="100%">
            <stop offset="0%" stopColor="#5BAEFF" />
            <stop offset="55%" stopColor="#2196FA" />
            <stop offset="100%" stopColor="#0F6FE0" />
          </linearGradient>
        </defs>
        <path
          d="M 140 0 A 140 100 0 1 1 106 197 L 68 218 L 62 183 A 140 100 0 0 1 140 0 Z"
          fill="url(#splashBlueGrad)"
        />
      </svg>
      {/* gloss highlight */}
      <span
        aria-hidden
        className="absolute h-[18px] w-[110px] rounded-full bg-white"
        style={{ left: 85, top: 23, opacity: 0.22, filter: "blur(2px)" }}
      />
      {[0, 160, 320].map((delay, i) => (
        <AbsDot
          key={i}
          x={98 + i * 32}
          y={90}
          size={20}
          color="#FFFFFF"
          glow="0 1px 2px rgba(15,115,224,.25)"
          animation={`splashTyping 1.2s ${delay}ms ease-in-out infinite`}
        />
      ))}
      <SatelliteRing items={SATELLITES_BLUE} />
    </div>
  );
}

function BubbleGreen() {
  const pop = "splashBubblePop 800ms 360ms backwards cubic-bezier(.2,.7,.2,1)";
  return (
    <div className="absolute h-[100px] w-[110px]" style={{ left: 75, top: 195, animation: pop }}>
      <svg width="110" height="100" viewBox="0 0 110 100" style={dropShadow("#15182A18", 22, 8)}>
        <defs>
          <linearGradient id="splashGreenGrad" x1="0%" y1="0%" x2="60%" y2="100%">
            <stop offset="0%" stopColor="#86EBB7" />
            <stop offset="100%" stopColor="#3DCB8A" />
          </linearGradient>
        </defs>
        <path
          d="M 55 0 A 55 40 0 0 1 59 80 L 45 92 L 40 78 A 55 40 0 0 1 55 0 Z"
          fill="url(#splashGreenGrad)"
        />
        {/* group-of-people glyph */}
        <g transform="translate(36 18)" fill="#FFFFFF">
          <circle cx="14" cy="10" r="5" />
          <path d="M5 35 q0 -12 9 -12 q9 0 9 12 z" />
          <circle cx="28" cy="14" r="4" />
          <path d="M21 35 q0 -10 7 -10 q7 0 7 10 z" />
        </g>
      </svg>
      <SatelliteRing items={SATELLITES_GREEN} />
    </div>
  );
}

function BubbleWhite() {
  const pop = "splashBubblePop 800ms 540ms backwards cubic-bezier(.2,.7,.2,1)";
  return (
    <div className="absolute h-[130px] w-[150px]" style={{ left: 289.5, top: 180, animation: pop }}>
      <svg width="150" height="130" viewBox="0 0 150 130" style={dropShadow("#15182A14", 2, 1)}>
        <path
          d="M 75 0 A 75 55 0 0 1 78 110 L 50 121 L 52 107 A 75 55 0 0 1 75 0 Z"
          fill="#FFFFFF"
          stroke="#B8C5DD"
          strokeWidth="0.5"
          strokeLinejoin="round"
        />
      </svg>
      {[0, 160, 320].map((delay, i) => (
        <AbsDot
          key={i}
          x={53.5 + i * 15}
          y={50}
          size={9}
          color="#A2B5D4"
          animation={`splashTyping 1.2s ${delay}ms ease-in-out infinite`}
        />
      ))}
      <SatelliteRing items={SATELLITES_WHITE} />
    </div>
  );
}

// ─── Spinner ──────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div
      aria-hidden
      className="relative size-12"
      style={{ animation: "splashSpin 1.4s linear infinite" }}
    >
      {SPINNER_DOTS.map((d, i) => (
        <AbsDot key={i} {...d} />
      ))}
    </div>
  );
}

// ─── Features ─────────────────────────────────────────────────────────────

function Features() {
  return (
    <div className="flex items-start justify-center gap-[72px]">
      {FEATURES.map(({ color, bg, stroke, label, Icon }) => (
        <div key={label} className="flex flex-col items-center gap-[10px]">
          <Hexagon color={bg} stroke={stroke}>
            <Icon size={22} color={color} strokeWidth={2} />
          </Hexagon>
          <span
            className="text-[13px] font-medium text-[#6B7280]"
            style={{ letterSpacing: "0.03em", paddingLeft: "0.03em" }}
          >
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Bottom Scene (city / waves / paper plane) ────────────────────────────

function BottomScene() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[260px]"
      style={{ animation: "splashFadeUp 900ms 700ms backwards ease-out" }}
    >
      {/* Waves stretch full-width */}
      <Waves />
      {/* Plane + city skyline are anchored to a centered container so they
          slide inward instead of pinning to the right edge on narrow viewports. */}
      <div className="relative mx-auto h-full w-full max-w-[1280px]">
        <CityBuildings />
        <PaperPlane />
      </div>
    </div>
  );
}

function CityBuildings() {
  return (
    <div className="absolute h-[120px] w-[440px] opacity-50" style={{ right: 50, top: 41 }}>
      {BUILDINGS.map((b, i) => (
        <span
          key={i}
          className="absolute"
          style={{ left: b.x, top: b.y, width: b.w, height: b.h, background: b.color }}
        />
      ))}
    </div>
  );
}

function Waves() {
  // Each path is 2× viewBox-wide (period 640) so the SMIL animateTransform
  // can drift it by -1280 SVG units in a seamless loop. Different durations
  // per layer create a parallax-water feel.
  return (
    <svg
      className="absolute bottom-0 left-0 block h-[260px] w-full"
      viewBox="0 0 1280 260"
      preserveAspectRatio="none"
    >
      <DriftingWave
        d="M0,70 Q160,20 320,70 T640,70 T960,70 T1280,70 T1600,70 T1920,70 T2240,70 T2560,70 L2560,260 L0,260 Z"
        fill="#E0E7FF"
        opacity={0.28}
        dur="26s"
      />
      <DriftingWave
        d="M0,130 Q160,80 320,130 T640,130 T960,130 T1280,130 T1600,130 T1920,130 T2240,130 T2560,130 L2560,260 L0,260 Z"
        fill="#D6E4FF"
        opacity={0.7}
        dur="20s"
      />
      <DriftingWave
        d="M0,180 Q160,150 320,180 T640,180 T960,180 T1280,180 T1600,180 T1920,180 T2240,180 T2560,180 L2560,260 L0,260 Z"
        fill="#FCE7B8"
        opacity={1}
        dur="14s"
      />
      <DriftingWave
        d="M0,220 Q160,195 320,220 T640,220 T960,220 T1280,220 T1600,220 T1920,220 T2240,220 T2560,220 L2560,260 L0,260 Z"
        fill="#DCEFE2"
        opacity={0.78}
        dur="10s"
      />
    </svg>
  );
}

function DriftingWave({
  d,
  fill,
  opacity,
  dur,
}: {
  d: string;
  fill: string;
  opacity: number;
  dur: string;
}) {
  return (
    <path d={d} fill={fill} opacity={opacity}>
      <animateTransform
        attributeName="transform"
        type="translate"
        from="0 0"
        to="-1280 0"
        dur={dur}
        repeatCount="indefinite"
      />
    </path>
  );
}

// Soft enterprise-illustration paper plane.
// Single self-contained SVG: low-saturation stroke, transparent gradient body,
// integrated dashed trail, gentle -12° upward tilt. No icon library.
function PaperPlane() {
  return (
    <svg
      aria-hidden
      className="absolute"
      width="48"
      height="38"
      viewBox="0 0 90 70"
      style={{
        right: 100,
        top: 28,
        overflow: "visible",
        filter: "drop-shadow(0 4px 10px rgba(120, 180, 255, 0.16))",
        pointerEvents: "none",
        animation: "splashPlaneFloat 5.5s ease-in-out infinite",
      }}
    >
      <defs>
        <linearGradient id="splashPlaneFill" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#78B4FF" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#78B4FF" stopOpacity="0.04" />
        </linearGradient>
      </defs>
      <g
        transform="rotate(-12 45 35)"
        fill="none"
        stroke="#9CB8DB"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* dashed trail — drawn first so the body sits on top.
            The dashoffset animation makes the dashes slide backward along the
            curve, giving the impression that the plane is moving forward. */}
        <path
          d="M -10 76 C 4 70, 14 60, 24 52"
          strokeDasharray="3 8"
          opacity="0.25"
          style={{ animation: "splashPlaneTrailFlow 1.4s linear infinite" }}
        />
        {/* body silhouette — origami arrow with V-notch on the back */}
        <path d="M 84 6 L 30 64 L 38 36 L 4 22 Z" fill="url(#splashPlaneFill)" />
        {/* inner crease — diagonal from tip to V-notch */}
        <path d="M 84 6 L 38 36" />
      </g>
    </svg>
  );
}

// ─── Primitives ───────────────────────────────────────────────────────────

interface AbsDotProps {
  x: number;
  y: number;
  size: number;
  color: string;
  opacity?: number;
  animation?: string;
  glow?: string;
}

function AbsDot({ x, y, size, color, opacity, animation, glow }: AbsDotProps) {
  return (
    <span
      aria-hidden
      className="absolute rounded-full"
      style={{
        left: x,
        top: y,
        width: size,
        height: size,
        background: color,
        opacity,
        animation,
        boxShadow: glow,
      }}
    />
  );
}

function SatelliteRing({ items }: { items: Satellite[] }) {
  return (
    <>
      {items.map((s, i) => (
        <span
          key={i}
          aria-hidden
          className="absolute rounded-full"
          style={
            {
              left: s.x,
              top: s.y,
              width: s.size,
              height: s.size,
              background: s.color,
              animation: `splashSatellite ${s.duration}ms ${s.delay}ms ease-in-out infinite`,
              "--dx": `${s.dx}px`,
              "--dy": `${s.dy}px`,
            } as CSSProperties
          }
        />
      ))}
    </>
  );
}

function Hexagon({
  color,
  stroke,
  children,
}: {
  color: string;
  stroke: string;
  children: ReactNode;
}) {
  return (
    <div className="relative size-[52px]">
      <svg className="absolute inset-0" viewBox="0 0 52 52">
        <path
          d="M26 1 L48 13 V39 L26 51 L4 39 V13 Z"
          fill={color}
          stroke={stroke}
          strokeWidth="1.2"
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}

function dropShadow(color: string, blur: number, y: number) {
  return {
    overflow: "visible" as const,
    filter: `drop-shadow(0 ${y}px ${blur}px ${color}) drop-shadow(0 1px 2px rgba(21,24,42,.06))`,
  };
}

// ─── Animations ───────────────────────────────────────────────────────────

const KEYFRAMES = `
@keyframes splashFadeUp {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes splashIllustrationIn {
  from { opacity: 0; transform: translateY(-12px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes splashBubblePop {
  from { opacity: 0; transform: scale(0.6); }
  to   { opacity: 1; transform: scale(1); }
}
@keyframes splashTyping {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.55; }
  30%           { transform: translateY(-3px); opacity: 1; }
}
@keyframes splashSpin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
@keyframes splashDotFloat {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-3px); }
}
@keyframes splashSatellite {
  0%, 100% { opacity: 0.25; transform: translate(0, 0) scale(0.7); }
  50%      { opacity: 1;    transform: translate(var(--dx, 0), var(--dy, 0)) scale(1); }
}
@keyframes splashHaloPulse {
  0%, 100% { opacity: 0.62; transform: scale(1); }
  50%      { opacity: 0.78; transform: scale(1.04); }
}
@keyframes splashPlaneFloat {
  0%, 100% { transform: translate(0, 0); }
  50%      { transform: translate(-2px, -3px); }
}
@keyframes splashPlaneTrailFlow {
  from { stroke-dashoffset: 0; }
  to   { stroke-dashoffset: 11; }
}
`;
