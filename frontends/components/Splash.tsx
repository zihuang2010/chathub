import { useEffect, type ComponentType } from "react";
import { ShieldCheck, Zap, Share2, Sparkles, type LucideProps } from "lucide-react";

import {
  BubbleBlue,
  BubbleGreen,
  BubblePurple,
  BubbleWhite,
  DriftingWave,
  buildWavePath,
  type Satellite,
} from "@/components/illustrations";

interface SplashProps {
  onReady?: () => void;
  durationMs?: number;
}

const FONT_BODY =
  "'Inter', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif";

// ─── Data ─────────────────────────────────────────────────────────────────

interface DotSpec {
  x: number;
  y: number;
  size: number;
  color: string;
  opacity?: number;
}

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
interface BuildingSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

const BUILDINGS: BuildingSpec[] = [
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
interface FeatureSpec {
  color: string;
  bg: string;
  stroke: string;
  label: string;
  Icon: ComponentType<LucideProps>;
}

const FEATURES: FeatureSpec[] = [
  { color: "#10B981", bg: "#D1FAE5", stroke: "#6EE7B7", label: "安全可靠", Icon: ShieldCheck },
  { color: "#3B82F6", bg: "#DBEAFE", stroke: "#93C5FD", label: "高效聚合", Icon: Zap },
  { color: "#FB923C", bg: "#FFEDD5", stroke: "#FDBA74", label: "轻量便捷", Icon: Share2 },
  { color: "#A855F7", bg: "#F3E8FF", stroke: "#D8B4FE", label: "智能助手", Icon: Sparkles },
];

// Twinkling satellites around each main bubble
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

const SATELLITES_PURPLE: Satellite[] = [
  { x: -10, y: 24, size: 5, color: "#D8B4FE", dx: 2, dy: -2, delay: 0, duration: 2400 },
  { x: -6, y: 64, size: 4, color: "#E9D5FF", dx: -2, dy: 3, delay: 700, duration: 2800 },
  { x: 18, y: -8, size: 4, color: "#C084FC", dx: 2, dy: -2, delay: 300, duration: 2600 },
  { x: 96, y: 30, size: 5, color: "#C084FC", dx: -3, dy: 2, delay: 1100, duration: 3000 },
  { x: 92, y: 70, size: 4, color: "#D8B4FE", dx: -2, dy: 3, delay: 500, duration: 2500 },
];

// Pre-built wave paths for the bottom scene
const SPLASH_WAVE_BOTTOM = 260;
const SPLASH_WAVES = [
  { d: buildWavePath(70, 50, SPLASH_WAVE_BOTTOM), fill: "#E0E7FF", opacity: 0.28, dur: "26s" },
  { d: buildWavePath(130, 50, SPLASH_WAVE_BOTTOM), fill: "#D6E4FF", opacity: 0.7, dur: "20s" },
  { d: buildWavePath(180, 30, SPLASH_WAVE_BOTTOM), fill: "#FCE7B8", opacity: 1, dur: "14s" },
  { d: buildWavePath(220, 25, SPLASH_WAVE_BOTTOM), fill: "#DCEFE2", opacity: 0.78, dur: "10s" },
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
      <VersionBadge />

      <main className="relative flex h-full w-full flex-col items-center pt-14">
        <Illustration />

        <h1
          className="mt-[18px] text-[32px] font-semibold text-[#1F2937]"
          style={{
            letterSpacing: "0.06em",
            paddingLeft: "0.06em",
            animation: "chFadeUp 700ms 200ms backwards ease-out",
          }}
        >
          匠多多企微聚合平台
        </h1>

        <p
          className="mt-[18px] text-[13px] text-[#7d828b]"
          style={{
            letterSpacing: "0.12em",
            paddingLeft: "0.18em",
            animation: "chFadeUp 700ms 360ms backwards ease-out",
          }}
        >
          聚合多聊 · 高效沟通 · 一处掌控
        </p>

        <div className="mt-7" style={{ animation: "chFadeUp 700ms 540ms backwards ease-out" }}>
          <Spinner />
        </div>

        <div className="mt-8" style={{ animation: "chFadeUp 700ms 720ms backwards ease-out" }}>
          <Features />
        </div>

        <div
          className="mt-[18px]"
          style={{ animation: "chFadeUp 700ms 900ms backwards ease-out" }}
        ></div>
      </main>

      <BottomScene />
      <BrandStrip />
    </div>
  );
}

// ─── Illustration ─────────────────────────────────────────────────────────

function Illustration() {
  return (
    <div
      className="relative h-[340px] w-[520px]"
      style={{ animation: "chIllustrationIn 900ms ease-out backwards" }}
    >
      <Halos />
      {HALO_DOTS.map((d, i) => (
        <FloatDot key={i} {...d} />
      ))}
      {/* Stacking order — blue is on top */}
      <BubblePurple left={410} top={20} width={92} height={84} satellites={SATELLITES_PURPLE} />
      <BubbleWhite left={289.5} top={180} width={150} height={130} satellites={SATELLITES_WHITE} />
      <BubbleGreen left={75} top={195} width={110} height={100} satellites={SATELLITES_GREEN} />
      <BubbleBlue left={120} top={65} width={280} height={240} satellites={SATELLITES_BLUE} />
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
          animation: "chHaloPulse 8s ease-in-out infinite",
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

// ─── Spinner ──────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div
      aria-hidden
      className="relative size-12"
      style={{ animation: "chSpin 1.4s linear infinite" }}
    >
      {SPINNER_DOTS.map((d, i) => (
        <PlainDot key={i} {...d} />
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

// ─── Version badge (top-right) ────────────────────────────────────────────

function VersionBadge() {
  return (
    <div
      className="absolute right-6 top-5 z-10 flex items-center gap-2"
      style={{ animation: "chFadeUp 700ms 100ms backwards ease-out" }}
    >
      <span
        className="rounded-full bg-gradient-to-r from-[#A855F7] to-[#3B82F6] px-2 py-[2px] text-[10px] font-semibold text-white shadow-sm"
        style={{ letterSpacing: "0.08em" }}
      >
        BETA
      </span>
      <span
        className="font-numeric text-[11px] tabular-nums text-[#9CA3AF]"
        style={{ letterSpacing: "0.05em" }}
      >
        v0.1.0
      </span>
    </div>
  );
}

// ─── Brand strip (bottom) ─────────────────────────────────────────────────

function BrandStrip() {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex items-center justify-center gap-2 text-[11px] text-[#9CA3AF]"
      style={{
        letterSpacing: "0.06em",
        animation: "chFadeUp 700ms 1100ms backwards ease-out",
      }}
    >
      <span>© 2026 匠多多</span>
      <span aria-hidden className="size-1 rounded-full bg-[#D1D5DB]" />
      <span>企微合规接入</span>
      <span aria-hidden className="size-1 rounded-full bg-[#D1D5DB]" />
      <span>数据本地化</span>
    </div>
  );
}

function Hexagon({
  color,
  stroke,
  children,
}: {
  color: string;
  stroke: string;
  children: React.ReactNode;
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

// ─── Bottom scene (city / waves / paper plane) ────────────────────────────

function BottomScene() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[260px]"
      style={{ animation: "chFadeUp 900ms 700ms backwards ease-out" }}
    >
      <Waves />
      {/* Plane + city skyline anchored to a centered container so they
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
  return (
    <svg
      className="absolute bottom-0 left-0 block h-[260px] w-full"
      viewBox={`0 0 1280 ${SPLASH_WAVE_BOTTOM}`}
      preserveAspectRatio="none"
    >
      {SPLASH_WAVES.map((w, i) => (
        <DriftingWave key={i} {...w} />
      ))}
    </svg>
  );
}

/**
 * Soft enterprise-illustration paper plane.
 * Single self-contained SVG: low-saturation stroke, transparent gradient body,
 * integrated dashed trail (animated via stroke-dashoffset), gentle -12° tilt,
 * and a subtle float. No icon library.
 */
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
        animation: "chPlaneFloat 5.5s ease-in-out infinite",
      }}
    >
      <defs>
        <linearGradient id="chPlaneFill" x1="0%" y1="0%" x2="100%" y2="100%">
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
        <path
          d="M -10 76 C 4 70, 14 60, 24 52"
          strokeDasharray="3 8"
          opacity="0.25"
          style={{ animation: "chPlaneTrailFlow 1.4s linear infinite" }}
        />
        <path d="M 84 6 L 30 64 L 38 36 L 4 22 Z" fill="url(#chPlaneFill)" />
        <path d="M 84 6 L 38 36" />
      </g>
    </svg>
  );
}

// ─── Local primitives (only used inside Splash) ──────────────────────────

function FloatDot(p: DotSpec) {
  return (
    <span
      aria-hidden
      className="absolute rounded-full"
      style={{
        left: p.x,
        top: p.y,
        width: p.size,
        height: p.size,
        background: p.color,
        opacity: p.opacity,
        animation: "chDotFloat 5s ease-in-out infinite",
      }}
    />
  );
}

function PlainDot(p: DotSpec) {
  return (
    <span
      aria-hidden
      className="absolute rounded-full"
      style={{
        left: p.x,
        top: p.y,
        width: p.size,
        height: p.size,
        background: p.color,
        opacity: p.opacity,
      }}
    />
  );
}
