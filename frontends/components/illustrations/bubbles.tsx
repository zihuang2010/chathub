import { memo, type CSSProperties } from "react";

import { SatelliteRing, type Satellite } from "./satellites";

// ─── Shared types ───────────────────────────────────────────────────────────

interface BubbleProps {
  /** Absolute-position offset within the parent. */
  left: number;
  top: number;
  /** Rendered size. The internal viewBox is fixed, so changing this scales the bubble. */
  width: number;
  height: number;
  /** Pop-in animation delay, in ms. */
  delay?: number;
  /** Optional satellite ring. */
  satellites?: Satellite[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const popIn = (delay: number): string =>
  `chBubblePop 800ms ${delay}ms backwards cubic-bezier(.2,.7,.2,1)`;

const dropShadow = (color: string, blur: number, y: number): CSSProperties => ({
  overflow: "visible",
  filter: `drop-shadow(0 ${y}px ${blur}px ${color}) drop-shadow(0 1px 2px rgba(21,24,42,.06))`,
});

const typingDot = (delay: number): CSSProperties => ({
  animation: `chTyping 1.2s ${delay}ms ease-in-out infinite`,
});

const TYPING_DELAYS = [0, 160, 320];

// ─── Bubble: blue (with typing dots) ────────────────────────────────────────

export const BubbleBlue = memo(function BubbleBlue({
  left,
  top,
  width,
  height,
  delay = 180,
  satellites,
}: BubbleProps) {
  return (
    <div className="absolute" style={{ left, top, width, height, animation: popIn(delay) }}>
      <svg
        width={width}
        height={height}
        viewBox="0 0 280 240"
        style={dropShadow("#1989FA55", 42, 8)}
      >
        <defs>
          <linearGradient id="chBubbleBlueGrad" x1="0%" y1="0%" x2="60%" y2="100%">
            <stop offset="0%" stopColor="#5BAEFF" />
            <stop offset="55%" stopColor="#2196FA" />
            <stop offset="100%" stopColor="#0F6FE0" />
          </linearGradient>
        </defs>
        <path
          d="M 140 0 A 140 100 0 1 1 106 197 L 68 218 L 62 183 A 140 100 0 0 1 140 0 Z"
          fill="url(#chBubbleBlueGrad)"
        />
        {/* gloss highlight */}
        <ellipse cx="140" cy="32" rx="55" ry="9" fill="white" opacity="0.22" filter="blur(2px)" />
        {/* typing dots */}
        {TYPING_DELAYS.map((d, i) => (
          <circle key={i} cx={108 + i * 32} cy={100} r={10} fill="white" style={typingDot(d)} />
        ))}
      </svg>
      {satellites && <SatelliteRing items={satellites} />}
    </div>
  );
});

// ─── Bubble: green (with connected people glyph) ────────────────────────────

export const BubbleGreen = memo(function BubbleGreen({
  left,
  top,
  width,
  height,
  delay = 360,
  satellites,
}: BubbleProps) {
  return (
    <div className="absolute" style={{ left, top, width, height, animation: popIn(delay) }}>
      <svg
        width={width}
        height={height}
        viewBox="0 0 110 100"
        style={dropShadow("#15182A18", 22, 8)}
      >
        <defs>
          <linearGradient id="chBubbleGreenGrad" x1="0%" y1="0%" x2="60%" y2="100%">
            <stop offset="0%" stopColor="#86EBB7" />
            <stop offset="100%" stopColor="#3DCB8A" />
          </linearGradient>
        </defs>
        <path
          d="M 55 0 A 55 40 0 0 1 59 80 L 45 92 L 40 78 A 55 40 0 0 1 55 0 Z"
          fill="url(#chBubbleGreenGrad)"
        />
        <g fill="#FFFFFF">
          <circle cx="47" cy="31" r="5" />
          <path d="M38 48 q0 -14 9 -14 q9 0 9 14 z" />
          <circle cx="64" cy="35" r="4.5" />
          <path d="M56 48 q0 -11 8 -11 q8 0 8 11 z" />
        </g>
      </svg>
      {satellites && <SatelliteRing items={satellites} />}
    </div>
  );
});

// ─── Bubble: purple (with sparkle glyph for AI) ─────────────────────────────

export const BubblePurple = memo(function BubblePurple({
  left,
  top,
  width,
  height,
  delay = 720,
  satellites,
}: BubbleProps) {
  return (
    <div className="absolute" style={{ left, top, width, height, animation: popIn(delay) }}>
      <svg
        width={width}
        height={height}
        viewBox="0 0 110 100"
        style={dropShadow("#A855F733", 22, 8)}
      >
        <defs>
          <linearGradient id="chBubblePurpleGrad" x1="0%" y1="0%" x2="60%" y2="100%">
            <stop offset="0%" stopColor="#D8B4FE" />
            <stop offset="100%" stopColor="#A855F7" />
          </linearGradient>
        </defs>
        <path
          d="M 55 0 A 55 40 0 0 1 59 80 L 45 92 L 40 78 A 55 40 0 0 1 55 0 Z"
          fill="url(#chBubblePurpleGrad)"
        />
        {/* gloss highlight */}
        <ellipse cx="55" cy="14" rx="22" ry="4" fill="white" opacity="0.28" filter="blur(1px)" />
        {/* sparkle glyphs */}
        <path
          d="M 50 22 L 54 34 L 66 38 L 54 42 L 50 54 L 46 42 L 34 38 L 46 34 Z"
          fill="#FFFFFF"
          opacity="0.95"
        >
          <animate attributeName="opacity" values="0.6;1;0.6" dur="2.4s" repeatCount="indefinite" />
        </path>
        <path
          d="M 78 18 L 80 24 L 86 26 L 80 28 L 78 34 L 76 28 L 70 26 L 76 24 Z"
          fill="#FFFFFF"
          opacity="0.7"
        >
          <animate
            attributeName="opacity"
            values="0.3;0.85;0.3"
            dur="1.8s"
            begin="0.4s"
            repeatCount="indefinite"
          />
        </path>
        <path
          d="M 26 58 L 28 62 L 32 64 L 28 66 L 26 70 L 24 66 L 20 64 L 24 62 Z"
          fill="#FFFFFF"
          opacity="0.6"
        >
          <animate
            attributeName="opacity"
            values="0.25;0.8;0.25"
            dur="2.1s"
            begin="0.9s"
            repeatCount="indefinite"
          />
        </path>
      </svg>
      {satellites && <SatelliteRing items={satellites} />}
    </div>
  );
});

// ─── Bubble: white (with typing dots) ───────────────────────────────────────

export const BubbleWhite = memo(function BubbleWhite({
  left,
  top,
  width,
  height,
  delay = 540,
  satellites,
}: BubbleProps) {
  return (
    <div className="absolute" style={{ left, top, width, height, animation: popIn(delay) }}>
      <svg
        width={width}
        height={height}
        viewBox="0 0 150 130"
        style={dropShadow("#15182A14", 2, 1)}
      >
        <path
          d="M 75 0 A 75 55 0 0 1 78 110 L 50 121 L 52 107 A 75 55 0 0 1 75 0 Z"
          fill="#FFFFFF"
          stroke="#B8C5DD"
          strokeWidth="0.5"
          strokeLinejoin="round"
        />
        {TYPING_DELAYS.map((d, i) => (
          <circle key={i} cx={58 + i * 15} cy={55} r={4.5} fill="#A2B5D4" style={typingDot(d)} />
        ))}
      </svg>
      {satellites && <SatelliteRing items={satellites} />}
    </div>
  );
});
