import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, Eye, EyeOff, Lock, Smartphone, UserRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  BLUE_GRADIENT,
  BLUE_GRADIENT_HOVER,
  COLOR_SUBTITLE,
  COLOR_TITLE,
  FONT_BODY,
  WAVE_FILLS,
} from "@/lib/theme";

type Tab = "account" | "phone";

interface LoginProps {
  onSuccess?: (payload: { tab: Tab; identifier: string }) => void;
}

export function Login({ onSuccess }: LoginProps) {
  const [tab, setTab] = useState<Tab>("account");
  const [account, setAccount] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);

  const identifier = tab === "account" ? account : phone;
  const canSubmit = identifier.trim().length > 0 && password.trim().length > 0;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSuccess?.({ tab, identifier });
  };

  return (
    <div
      className="absolute inset-0 select-none overflow-hidden bg-white"
      style={{ fontFamily: FONT_BODY }}
    >
      <style>{KEYFRAMES}</style>

      <Backdrop />

      <main className="relative flex h-full w-full items-center justify-center px-12">
        <div className="grid w-full max-w-[1080px] grid-cols-1 items-center gap-16 lg:grid-cols-[1fr_460px]">
          <BrandPanel />
          <FormCard
            tab={tab}
            setTab={setTab}
            account={account}
            setAccount={setAccount}
            phone={phone}
            setPhone={setPhone}
            password={password}
            setPassword={setPassword}
            remember={remember}
            setRemember={setRemember}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
            canSubmit={canSubmit}
            onSubmit={handleSubmit}
          />
        </div>
      </main>

      <BottomWaves />
    </div>
  );
}

// ─── Backdrop (ambient halos) ─────────────────────────────────────────────

function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div
        className="absolute -left-40 -top-40 h-[520px] w-[520px] rounded-full opacity-60"
        style={{
          background: "radial-gradient(closest-side, #DCE6FF 0%, rgba(220,230,255,0) 70%)",
        }}
      />
      <div
        className="absolute -right-32 -top-24 h-[420px] w-[420px] rounded-full opacity-55"
        style={{
          background: "radial-gradient(closest-side, #FFE2C7 0%, rgba(255,226,199,0) 70%)",
        }}
      />
      <div
        className="absolute -bottom-24 left-1/4 h-[300px] w-[480px] rounded-full opacity-50"
        style={{
          background: "radial-gradient(closest-side, #DCEFE2 0%, rgba(220,239,226,0) 70%)",
        }}
      />
    </div>
  );
}

// ─── Brand Panel (left) ───────────────────────────────────────────────────

function BrandPanel() {
  return (
    <div
      className="relative hidden flex-col gap-8 lg:flex"
      style={{ animation: "loginFade 800ms 200ms backwards ease-out" }}
    >
      <div className="flex flex-col gap-3">
        <h1
          className="text-[40px] font-semibold leading-tight"
          style={{ color: COLOR_TITLE, letterSpacing: "0.04em" }}
        >
          智能聚合 · 多元协作
        </h1>
        <p
          className="text-[15px] leading-relaxed"
          style={{ color: COLOR_SUBTITLE, letterSpacing: "0.06em" }}
        >
          让每一次团队对话都更高效，让每一个工作流都更顺畅。
        </p>
      </div>

      <BrandIllustration />

      <div
        className="mt-2 inline-flex w-fit items-center gap-2 rounded-full bg-[#F5F8FF] px-4 py-2"
        style={{ animation: "loginFade 800ms 600ms backwards ease-out" }}
      >
        <span className="size-1.5 rounded-full" style={{ background: "#3B82F6" }} />
        <span
          className="text-[12px] font-medium"
          style={{ color: "#4B6BBE", letterSpacing: "0.08em" }}
        >
          匠多多企微聚合平台 · v1.0
        </span>
      </div>
    </div>
  );
}

function BrandIllustration() {
  // Three-bubble cluster mirroring the splash composition (blue on top).
  return (
    <div
      className="relative h-[290px] w-full max-w-[460px]"
      style={{ animation: "loginIllustrationIn 900ms 300ms backwards ease-out" }}
    >
      <IllustrationHalos />

      {DECOR_DOTS.map((d, i) => (
        <span
          key={i}
          aria-hidden
          className="absolute rounded-full"
          style={{
            left: d.x,
            top: d.y,
            width: d.size,
            height: d.size,
            background: d.color,
            opacity: d.opacity,
            animation: "loginDotFloat 5s ease-in-out infinite",
          }}
        />
      ))}

      {/* Stacking order — blue is on top, matching splash */}
      <BrandBubbleWhite />
      <BrandBubbleGreen />
      <BrandBubbleBlue />
    </div>
  );
}

function IllustrationHalos() {
  return (
    <>
      <div
        aria-hidden
        className="absolute h-[280px] w-[440px] opacity-70"
        style={{
          left: 8,
          top: -8,
          background: "radial-gradient(ellipse at center, #EEF2FF 0%, rgba(255,255,255,0) 90%)",
        }}
      />
      <div
        aria-hidden
        className="absolute h-[260px] w-[360px]"
        style={{
          left: 50,
          background:
            "radial-gradient(ellipse 50% 47.5% at 45% 50%, #E5EBFF 0%, #EFF2FF 50%, rgba(255,255,255,0) 100%)",
        }}
      />
    </>
  );
}

function BrandBubbleBlue() {
  return (
    <div
      className="absolute"
      style={{
        left: 100,
        top: 50,
        width: 240,
        height: 200,
        animation: "loginBubblePop 800ms 380ms backwards cubic-bezier(.2,.7,.2,1)",
      }}
    >
      <svg
        width="240"
        height="200"
        viewBox="0 0 280 240"
        style={{
          overflow: "visible",
          filter:
            "drop-shadow(0 12px 36px rgba(33,150,250,.28)) drop-shadow(0 1px 2px rgba(21,24,42,.06))",
        }}
      >
        <defs>
          <linearGradient id="loginBlueGrad" x1="0%" y1="0%" x2="60%" y2="100%">
            <stop offset="0%" stopColor="#5BAEFF" />
            <stop offset="55%" stopColor="#2196FA" />
            <stop offset="100%" stopColor="#0F6FE0" />
          </linearGradient>
        </defs>
        <path
          d="M 140 0 A 140 100 0 1 1 106 197 L 68 218 L 62 183 A 140 100 0 0 1 140 0 Z"
          fill="url(#loginBlueGrad)"
        />
        {/* gloss highlight */}
        <ellipse cx="140" cy="32" rx="55" ry="9" fill="white" opacity="0.22" filter="blur(2px)" />
        {/* typing dots */}
        {[0, 160, 320].map((delay, i) => (
          <circle
            key={i}
            cx={108 + i * 32}
            cy={100}
            r={10}
            fill="white"
            style={{ animation: `loginTyping 1.2s ${delay}ms ease-in-out infinite` }}
          />
        ))}
      </svg>
    </div>
  );
}

function BrandBubbleGreen() {
  return (
    <div
      className="absolute"
      style={{
        left: 60,
        top: 165,
        width: 92,
        height: 84,
        animation: "loginBubblePop 800ms 540ms backwards cubic-bezier(.2,.7,.2,1)",
      }}
    >
      <svg
        width="92"
        height="84"
        viewBox="0 0 110 100"
        style={{
          overflow: "visible",
          filter:
            "drop-shadow(0 8px 22px rgba(21,24,42,.10)) drop-shadow(0 1px 2px rgba(21,24,42,.06))",
        }}
      >
        <defs>
          <linearGradient id="loginGreenGrad" x1="0%" y1="0%" x2="60%" y2="100%">
            <stop offset="0%" stopColor="#86EBB7" />
            <stop offset="100%" stopColor="#3DCB8A" />
          </linearGradient>
        </defs>
        <path
          d="M 55 0 A 55 40 0 0 1 59 80 L 45 92 L 40 78 A 55 40 0 0 1 55 0 Z"
          fill="url(#loginGreenGrad)"
        />
        {/* group-of-people glyph */}
        <g transform="translate(36 18)" fill="#FFFFFF">
          <circle cx="14" cy="10" r="5" />
          <path d="M5 35 q0 -12 9 -12 q9 0 9 12 z" />
          <circle cx="28" cy="14" r="4" />
          <path d="M21 35 q0 -10 7 -10 q7 0 7 10 z" />
        </g>
      </svg>
    </div>
  );
}

function BrandBubbleWhite() {
  return (
    <div
      className="absolute"
      style={{
        left: 250,
        top: 150,
        width: 130,
        height: 112,
        animation: "loginBubblePop 800ms 700ms backwards cubic-bezier(.2,.7,.2,1)",
      }}
    >
      <svg
        width="130"
        height="112"
        viewBox="0 0 150 130"
        style={{
          overflow: "visible",
          filter:
            "drop-shadow(0 4px 10px rgba(21,24,42,.06)) drop-shadow(0 1px 2px rgba(21,24,42,.04))",
        }}
      >
        <path
          d="M 75 0 A 75 55 0 0 1 78 110 L 50 121 L 52 107 A 75 55 0 0 1 75 0 Z"
          fill="#FFFFFF"
          stroke="#B8C5DD"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        {[0, 160, 320].map((delay, i) => (
          <circle
            key={i}
            cx={58 + i * 15}
            cy={55}
            r={4.5}
            fill="#A2B5D4"
            style={{ animation: `loginTyping 1.2s ${delay}ms ease-in-out infinite` }}
          />
        ))}
      </svg>
    </div>
  );
}

const DECOR_DOTS = [
  { x: 8, y: 18, size: 12, color: "#BFD0FF", opacity: 0.7 },
  { x: 50, y: 4, size: 7, color: "#DDD0FF", opacity: 0.65 },
  { x: 420, y: 14, size: 14, color: "#FFE2C7", opacity: 0.6 },
  { x: 4, y: 200, size: 10, color: "#C8E6D2", opacity: 0.65 },
  { x: 438, y: 200, size: 12, color: "#FFD2DF", opacity: 0.55 },
  { x: 0, y: 110, size: 6, color: "#BFD0FF", opacity: 0.55 },
  { x: 424, y: 100, size: 8, color: "#E0D6FF", opacity: 0.55 },
  { x: 220, y: 268, size: 10, color: "#FCE7B8", opacity: 0.6 },
];

// ─── Form Card (right) ────────────────────────────────────────────────────

interface FormCardProps {
  tab: Tab;
  setTab: (t: Tab) => void;
  account: string;
  setAccount: (v: string) => void;
  phone: string;
  setPhone: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  remember: boolean;
  setRemember: (v: boolean) => void;
  showPassword: boolean;
  setShowPassword: (v: boolean) => void;
  canSubmit: boolean;
  onSubmit: (e: FormEvent) => void;
}

function FormCard(p: FormCardProps) {
  return (
    <div
      className="relative w-full rounded-[20px] border border-[#EEF2F7] bg-white/95 p-10 shadow-[0_20px_60px_-20px_rgba(33,68,124,0.18)] backdrop-blur"
      style={{ animation: "loginCardIn 800ms 220ms backwards cubic-bezier(.2,.7,.2,1)" }}
    >
      <div className="mb-7 flex flex-col gap-1.5">
        <h2 className="text-[24px] font-semibold" style={{ color: COLOR_TITLE }}>
          欢迎回来
        </h2>
        <p className="text-[13px]" style={{ color: COLOR_SUBTITLE, letterSpacing: "0.04em" }}>
          登录到您的协作空间
        </p>
      </div>

      <Tabs value={p.tab} onChange={p.setTab} />

      <form onSubmit={p.onSubmit} className="mt-6 flex flex-col gap-5">
        {p.tab === "account" ? (
          <Field label="账号">
            <Input
              icon={<UserRound size={16} />}
              placeholder="请输入账号 / 邮箱"
              autoComplete="username"
              value={p.account}
              onChange={(e) => p.setAccount(e.currentTarget.value)}
            />
          </Field>
        ) : (
          <Field label="手机号">
            <Input
              icon={<Smartphone size={16} />}
              placeholder="请输入手机号"
              type="tel"
              inputMode="numeric"
              maxLength={11}
              autoComplete="tel"
              value={p.phone}
              onChange={(e) => p.setPhone(e.currentTarget.value.replace(/\D/g, ""))}
            />
          </Field>
        )}

        <Field label="密码">
          <Input
            icon={<Lock size={16} />}
            placeholder="请输入密码"
            type={p.showPassword ? "text" : "password"}
            autoComplete="current-password"
            value={p.password}
            onChange={(e) => p.setPassword(e.currentTarget.value)}
            endSlot={
              <button
                type="button"
                onClick={() => p.setShowPassword(!p.showPassword)}
                className="grid size-7 place-items-center rounded-md text-[#A0AEC0] transition-colors hover:bg-[#F5F8FF] hover:text-[#2196FA]"
                aria-label={p.showPassword ? "隐藏密码" : "显示密码"}
              >
                {p.showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            }
          />
        </Field>

        <div className="flex items-center justify-between text-[12.5px]">
          <Checkbox checked={p.remember} onChange={p.setRemember} label="7 天免登录" />
          <button
            type="button"
            className="font-medium text-[#2196FA] transition-colors hover:text-[#0F6FE0]"
          >
            忘记密码？
          </button>
        </div>

        <SubmitButton disabled={!p.canSubmit} />

        <div className="mt-1 text-center text-[12.5px]" style={{ color: COLOR_SUBTITLE }}>
          还没有账号？
          <button
            type="button"
            className="ml-1 font-medium text-[#2196FA] transition-colors hover:text-[#0F6FE0]"
          >
            联系管理员开通
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Form primitives ──────────────────────────────────────────────────────

function Tabs({ value, onChange }: { value: Tab; onChange: (t: Tab) => void }) {
  const items: { value: Tab; label: string }[] = [
    { value: "account", label: "账号登录" },
    { value: "phone", label: "手机号登录" },
  ];
  return (
    <div className="relative grid grid-cols-2 rounded-lg bg-[#F5F8FF] p-1">
      <span
        aria-hidden
        className="absolute bottom-1 top-1 w-[calc(50%-4px)] rounded-md bg-white shadow-[0_2px_8px_-2px_rgba(33,68,124,0.18)] transition-transform duration-300 ease-out"
        style={{
          transform: value === "account" ? "translateX(4px)" : "translateX(calc(100% + 4px))",
        }}
      />
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          onClick={() => onChange(it.value)}
          className={cn(
            "relative z-10 h-9 text-[13px] font-medium transition-colors",
            value === it.value ? "text-[#1F2937]" : "text-[#7d828b] hover:text-[#1F2937]",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span
        className="text-[12.5px] font-medium"
        style={{ color: "#4B5563", letterSpacing: "0.04em" }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "grid size-4 place-items-center rounded border transition-colors",
          checked
            ? "border-transparent bg-[#2196FA]"
            : "border-[#D6DDE7] bg-white hover:border-[#2196FA]",
        )}
      >
        {checked && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path
              d="M2 5.2 L4 7.2 L8 2.8"
              stroke="white"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
      <span style={{ color: COLOR_SUBTITLE }}>{label}</span>
    </label>
  );
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <Button
      type="submit"
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="group h-11 w-full rounded-lg text-[14px] font-medium text-white shadow-[0_10px_24px_-10px_rgba(33,150,250,0.6)] transition-all hover:shadow-[0_14px_28px_-10px_rgba(33,150,250,0.7)] disabled:shadow-none"
      style={{
        background: hover && !disabled ? BLUE_GRADIENT_HOVER : BLUE_GRADIENT,
      }}
    >
      <span className="flex items-center justify-center gap-1.5">
        登&nbsp;录
        <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
      </span>
    </Button>
  );
}

// ─── Bottom waves ─────────────────────────────────────────────────────────

function BottomWaves() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute bottom-0 left-0 block h-[320px] w-full"
      viewBox="0 0 1280 320"
      preserveAspectRatio="none"
      style={{ animation: "loginFade 900ms 500ms backwards ease-out" }}
    >
      <path
        d="M0,120 C220,20 460,280 700,140 C940,20 1100,280 1280,160 L1280,320 L0,320 Z"
        fill={WAVE_FILLS.back}
        opacity="0.45"
      />
      <path
        d="M0,200 C240,110 480,300 720,220 C960,150 1120,300 1280,220 L1280,320 L0,320 Z"
        fill={WAVE_FILLS.warm}
        opacity="0.85"
      />
      <path
        d="M0,260 C260,190 540,310 800,270 C1020,230 1160,310 1280,270 L1280,320 L0,320 Z"
        fill={WAVE_FILLS.mint}
        opacity="0.85"
      />
    </svg>
  );
}

// ─── Animations ───────────────────────────────────────────────────────────

const KEYFRAMES = `
@keyframes loginFade {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes loginCardIn {
  from { opacity: 0; transform: translateY(20px) scale(0.985); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes loginIllustrationIn {
  from { opacity: 0; transform: translateY(-10px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes loginBubblePop {
  from { opacity: 0; transform: scale(0.6); }
  to   { opacity: 1; transform: scale(1); }
}
@keyframes loginTyping {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.55; }
  30%           { transform: translateY(-3px); opacity: 1; }
}
@keyframes loginDotFloat {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-3px); }
}
`;
