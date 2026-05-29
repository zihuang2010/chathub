import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, Eye, EyeOff, Lock, Smartphone, UserRound } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import type { UserProfile } from "@/App";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BubbleBlue,
  BubbleGreen,
  BubbleWhite,
  DriftingWave,
  buildWavePath,
  type Satellite,
} from "@/components/illustrations";
import { cn } from "@/lib/utils";
import { encryptPassword } from "@/lib/crypto/passwordCipher";
import {
  BLUE_GRADIENT,
  BLUE_GRADIENT_HOVER,
  COLOR_SUBTITLE,
  COLOR_TITLE,
  FONT_BODY,
  WAVE_FILLS,
} from "@/lib/theme";

// ─── Types ──────────────────────────────────────────────────────────────────

type Tab = "account" | "phone";

interface LoginProps {
  /** 登录成功后回调,把 backend 返的 UserProfile 透传给上层(App.tsx 用它切 Workbench)。 */
  onSuccess?: (profile: UserProfile) => void;
  /** 来自 App.tsx 的提示文案,场景:token 失效 / 被踢导致跳回登录页。
   *  mount 时 useState initializer 一次性吸收到 errorMsg;用户重新提交时被覆盖/清空。 */
  notice?: string | null;
}

// "记住账号" 本地持久化 key —— 按 tab 分别记一份,跨重启预填。
const ACCOUNT_KEY = "chathub-login-remember-account";
const PHONE_KEY = "chathub-login-remember-phone";
const REMEMBER_KEY = "chathub-login-remember";

function readRememberAccount(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(ACCOUNT_KEY) ?? "";
}
function readRememberPhone(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(PHONE_KEY) ?? "";
}
function readRememberFlag(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(REMEMBER_KEY) !== "false"; // 缺省为 true
}

// ─── Data ───────────────────────────────────────────────────────────────────

interface DecorDot {
  x: number;
  y: number;
  size: number;
  color: string;
  opacity: number;
}

const DECOR_DOTS: DecorDot[] = [
  { x: 8, y: 18, size: 12, color: "#BFD0FF", opacity: 0.7 },
  { x: 50, y: 4, size: 7, color: "#DDD0FF", opacity: 0.65 },
  { x: 420, y: 14, size: 14, color: "#FFE2C7", opacity: 0.6 },
  { x: 4, y: 200, size: 10, color: "#C8E6D2", opacity: 0.65 },
  { x: 438, y: 200, size: 12, color: "#FFD2DF", opacity: 0.55 },
  { x: 0, y: 110, size: 6, color: "#BFD0FF", opacity: 0.55 },
  { x: 424, y: 100, size: 8, color: "#E0D6FF", opacity: 0.55 },
  { x: 220, y: 268, size: 10, color: "#FCE7B8", opacity: 0.6 },
];

const SATELLITES_BLUE: Satellite[] = [
  { x: -14, y: 30, size: 6, color: "#A8CFFF", dx: 3, dy: -2, delay: 0, duration: 2800 },
  { x: -18, y: 110, size: 5, color: "#BFD9FF", dx: -2, dy: 3, delay: 700, duration: 2400 },
  { x: 60, y: -10, size: 4, color: "#7BB6FF", dx: 2, dy: -2, delay: 300, duration: 2600 },
  { x: 250, y: 60, size: 6, color: "#BFD9FF", dx: -3, dy: 2, delay: 1100, duration: 3000 },
  { x: 252, y: 130, size: 4, color: "#7BB6FF", dx: -2, dy: 3, delay: 500, duration: 2700 },
  { x: 200, y: 188, size: 5, color: "#A8CFFF", dx: 2, dy: 2, delay: 900, duration: 2500 },
];

const SATELLITES_GREEN: Satellite[] = [
  { x: -10, y: 28, size: 5, color: "#7CE3A8", dx: 2, dy: -2, delay: 0, duration: 2400 },
  { x: 38, y: -8, size: 4, color: "#A8F0C5", dx: 2, dy: -2, delay: 600, duration: 2700 },
  { x: 96, y: 30, size: 4, color: "#C8F0DC", dx: -2, dy: 3, delay: 1100, duration: 2900 },
];

const SATELLITES_WHITE: Satellite[] = [
  { x: -14, y: 50, size: 5, color: "#D6DEE9", dx: 2, dy: -3, delay: 0, duration: 2600 },
  { x: 60, y: -10, size: 4, color: "#C5CFE0", dx: 2, dy: -2, delay: 700, duration: 2400 },
  { x: 134, y: 60, size: 5, color: "#E8EDF4", dx: -3, dy: 2, delay: 1100, duration: 3000 },
];

const LOGIN_WAVE_BOTTOM = 320;
const LOGIN_WAVES = [
  {
    d: buildWavePath(100, 80, LOGIN_WAVE_BOTTOM),
    fill: WAVE_FILLS.back,
    opacity: 0.45,
    dur: "22s",
  },
  {
    d: buildWavePath(200, 90, LOGIN_WAVE_BOTTOM),
    fill: WAVE_FILLS.warm,
    opacity: 0.85,
    dur: "16s",
  },
  {
    d: buildWavePath(270, 50, LOGIN_WAVE_BOTTOM),
    fill: WAVE_FILLS.mint,
    opacity: 0.85,
    dur: "11s",
  },
];

// ─── Login (entry) ──────────────────────────────────────────────────────────

export function Login({ onSuccess, notice }: LoginProps) {
  const [tab, setTab] = useState<Tab>("account");
  // C3: 持久化预填 — 上次"记住账号"勾选时存的 identifier 在 mount 时读回。
  const [account, setAccount] = useState<string>(readRememberAccount);
  const [phone, setPhone] = useState<string>(readRememberPhone);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState<boolean>(readRememberFlag);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  // mount 时一次性吸收 notice(父组件 logged_out 时已 set 好):后续 setErrorMsg(null) 会清掉。
  const [errorMsg, setErrorMsg] = useState<string | null>(() => notice ?? null);

  const identifier = tab === "account" ? account : phone;
  const canSubmit = identifier.trim().length > 0 && password.trim().length > 0;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || loading) return;
    setErrorMsg(null);
    setLoading(true);
    try {
      // 业务后台 /account-app/oauth2/token 要求 password 字段为 AES-CFB 密文,统一在前端入口加密。
      const profile = await invoke<UserProfile>("login", {
        username: identifier,
        password: encryptPassword(password),
      });
      // C3: 持久化 — 根据 remember 写或清(按当前 tab 分别记)
      if (typeof window !== "undefined") {
        if (remember) {
          if (tab === "account") {
            window.localStorage.setItem(ACCOUNT_KEY, account);
          } else {
            window.localStorage.setItem(PHONE_KEY, phone);
          }
          window.localStorage.setItem(REMEMBER_KEY, "true");
        } else {
          window.localStorage.removeItem(ACCOUNT_KEY);
          window.localStorage.removeItem(PHONE_KEY);
          window.localStorage.setItem(REMEMBER_KEY, "false");
        }
      }
      onSuccess?.(profile);
    } catch (err) {
      setErrorMsg(formatLoginError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="absolute inset-0 select-none overflow-hidden bg-white"
      style={{ fontFamily: FONT_BODY }}
    >
      <Backdrop />

      <main className="relative flex h-full w-full items-center justify-center px-6 md:px-10 lg:px-12">
        <div className="grid w-full max-w-[1080px] grid-cols-1 items-center gap-10 lg:grid-cols-[1fr_460px] lg:gap-16">
          <BrandPanel />
          <FormCard
            tab={tab}
            account={account}
            phone={phone}
            password={password}
            remember={remember}
            showPassword={showPassword}
            canSubmit={canSubmit}
            loading={loading}
            errorMsg={errorMsg}
            onTabChange={setTab}
            onAccountChange={setAccount}
            onPhoneChange={setPhone}
            onPasswordChange={setPassword}
            onRememberChange={setRemember}
            onShowPasswordToggle={() => setShowPassword((v) => !v)}
            onSubmit={handleSubmit}
          />
        </div>
      </main>

      <BottomWaves />
    </div>
  );
}

// ─── Backdrop (ambient halos) ───────────────────────────────────────────────

function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div
        className="absolute -left-40 -top-40 h-[520px] w-[520px] rounded-full"
        style={{
          background: "radial-gradient(closest-side, #DCE6FF 0%, rgba(220,230,255,0) 70%)",
          animation: "chHaloPulse 9s ease-in-out infinite",
        }}
      />
      <div
        className="absolute -right-32 -top-24 h-[420px] w-[420px] rounded-full"
        style={{
          background: "radial-gradient(closest-side, #FFE2C7 0%, rgba(255,226,199,0) 70%)",
          animation: "chHaloPulse 11s 1.4s ease-in-out infinite",
        }}
      />
      <div
        className="absolute -bottom-24 left-1/4 h-[300px] w-[480px] rounded-full"
        style={{
          background: "radial-gradient(closest-side, #DCEFE2 0%, rgba(220,239,226,0) 70%)",
          animation: "chHaloPulse 13s 2.8s ease-in-out infinite",
        }}
      />
    </div>
  );
}

// ─── Brand panel (left) ─────────────────────────────────────────────────────

function BrandPanel() {
  return (
    <div
      className="relative hidden flex-col gap-8 lg:flex"
      style={{ animation: "chFadeUpSmall 800ms 200ms backwards ease-out" }}
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
          style={{ color: COLOR_SUBTITLE, letterSpacing: "0.04em" }}
        >
          让每一次团队对话都更高效，让每一个工作流都更顺畅
        </p>
      </div>

      <BrandIllustration />

      <div
        className="mt-2 inline-flex w-fit items-center gap-2 rounded-full bg-[#F5F8FF] px-4 py-2"
        style={{ animation: "chFadeUpSmall 800ms 600ms backwards ease-out" }}
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
  return (
    <div
      className="relative h-[290px] w-full max-w-[460px]"
      style={{ animation: "chIllustrationIn 900ms 300ms backwards ease-out" }}
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
            animation: "chDotFloat 5s ease-in-out infinite",
          }}
        />
      ))}

      {/* Stacking order — blue is on top, matching splash */}
      <BubbleWhite
        left={250}
        top={150}
        width={130}
        height={112}
        delay={700}
        satellites={SATELLITES_WHITE}
      />
      <BubbleGreen
        left={60}
        top={165}
        width={92}
        height={84}
        delay={540}
        satellites={SATELLITES_GREEN}
      />
      <BubbleBlue
        left={100}
        top={50}
        width={240}
        height={200}
        delay={380}
        satellites={SATELLITES_BLUE}
      />
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

// AuthError 序列化为 { kind: "kebab-case", ...fields },见 backends/crates/chathub-net/src/error.rs
function formatLoginError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as { kind?: string; message?: string; min_version?: string };
    switch (e.kind) {
      case "unauthenticated":
        return "账号或密码错误";
      case "account-disabled":
        return e.message ? `账号已停用：${e.message}` : "账号已停用";
      case "upgrade-required":
        return e.min_version ? `客户端需升级至 ${e.min_version}` : "客户端需升级";
      case "network":
        return e.message ? `网络错误：${e.message}` : "网络错误,请检查 relay 是否在运行";
      case "storage":
        return e.message ? `本地存储错误：${e.message}` : "本地存储错误";
      case "internal":
        return e.message ? `服务内部错误：${e.message}` : "服务内部错误";
      default:
        return e.message ?? JSON.stringify(err);
    }
  }
  return String(err);
}

// ─── Form card (right) ──────────────────────────────────────────────────────

interface FormCardProps {
  tab: Tab;
  account: string;
  phone: string;
  password: string;
  remember: boolean;
  showPassword: boolean;
  canSubmit: boolean;
  loading: boolean;
  errorMsg: string | null;
  onTabChange: (t: Tab) => void;
  onAccountChange: (v: string) => void;
  onPhoneChange: (v: string) => void;
  onPasswordChange: (v: string) => void;
  onRememberChange: (v: boolean) => void;
  onShowPasswordToggle: () => void;
  onSubmit: (e: FormEvent) => void;
}

function FormCard(p: FormCardProps) {
  return (
    <div
      className="relative w-full rounded-[20px] border border-[#EEF2F7] bg-white/95 p-10 shadow-[0_20px_60px_-20px_rgba(33,68,124,0.18)] backdrop-blur"
      style={{ animation: "chCardIn 800ms 220ms backwards cubic-bezier(.2,.7,.2,1)" }}
    >
      <div className="mb-7 flex flex-col gap-1.5">
        <h2 className="text-[24px] font-semibold" style={{ color: COLOR_TITLE }}>
          欢迎回来
        </h2>
        <p className="text-[13px]" style={{ color: COLOR_SUBTITLE, letterSpacing: "0.04em" }}>
          登录到您的协作空间
        </p>
      </div>

      <Tabs value={p.tab} onChange={p.onTabChange} />

      <form onSubmit={p.onSubmit} className="mt-6 flex flex-col gap-5">
        {p.tab === "account" ? (
          <Field label="账号">
            <Input
              icon={<UserRound size={16} />}
              placeholder="请输入账号 / 邮箱"
              autoComplete="username"
              value={p.account}
              onChange={(e) => p.onAccountChange(e.currentTarget.value)}
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
              onChange={(e) => p.onPhoneChange(e.currentTarget.value.replace(/\D/g, ""))}
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
            onChange={(e) => p.onPasswordChange(e.currentTarget.value)}
            endSlot={
              <button
                type="button"
                onClick={p.onShowPasswordToggle}
                className="grid size-7 place-items-center rounded-md text-[#A0AEC0] transition-colors hover:bg-[#F5F8FF] hover:text-[#2196FA]"
                aria-label={p.showPassword ? "隐藏密码" : "显示密码"}
              >
                {p.showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            }
          />
        </Field>

        <div className="flex items-center justify-between text-[12.5px]">
          <Checkbox checked={p.remember} onChange={p.onRememberChange} label="7 天免登录" />
          <button
            type="button"
            className="font-medium text-[#2196FA] transition-colors hover:text-[#0F6FE0]"
          >
            忘记密码？
          </button>
        </div>

        {/* 错误提示 + 按钮包在无 gap 的子容器里:错误用 grid 高度(0fr↔1fr)+ 淡入动画
            平滑展开/收起,替代原来从无到有硬插入——避免插入瞬间把按钮往下顶的布局抖动。
            收起时高度与 margin 归零、不占文档流,布局与无错误时完全一致。 */}
        <div className="flex flex-col">
          <div
            className={cn(
              "grid transition-all duration-300 ease-out",
              p.errorMsg ? "mb-4 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
            )}
          >
            <div className="overflow-hidden">
              <div
                role="alert"
                className="rounded-md border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-[12.5px] text-[#B91C1C]"
              >
                {p.errorMsg}
              </div>
            </div>
          </div>

          <SubmitButton disabled={!p.canSubmit || p.loading} loading={p.loading} />
        </div>

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

// ─── Form primitives ────────────────────────────────────────────────────────

const TAB_ITEMS: { value: Tab; label: string }[] = [
  { value: "account", label: "账号登录" },
  { value: "phone", label: "手机号登录" },
];

function Tabs({ value, onChange }: { value: Tab; onChange: (t: Tab) => void }) {
  return (
    <div className="relative grid grid-cols-2 rounded-lg bg-[#F5F8FF] p-1">
      <span
        aria-hidden
        className="absolute bottom-1 top-1 w-[calc(50%-4px)] rounded-md bg-white shadow-[0_2px_8px_-2px_rgba(33,68,124,0.18)] transition-transform duration-300 ease-out"
        style={{
          transform: value === "account" ? "translateX(4px)" : "translateX(calc(100% + 4px))",
        }}
      />
      {TAB_ITEMS.map((it) => (
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

function SubmitButton({ disabled, loading }: { disabled: boolean; loading?: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <Button
      type="submit"
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="group h-11 w-full rounded-lg text-[14px] font-medium text-white shadow-[0_10px_24px_-10px_rgba(33,150,250,0.6)] transition-all hover:shadow-[0_14px_28px_-10px_rgba(33,150,250,0.7)] disabled:shadow-none"
      style={{ background: hover && !disabled ? BLUE_GRADIENT_HOVER : BLUE_GRADIENT }}
    >
      <span className="flex items-center justify-center gap-1.5">
        {loading ? (
          "登录中…"
        ) : (
          <>
            登&nbsp;录
            <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
          </>
        )}
      </span>
    </Button>
  );
}

// ─── Bottom waves ───────────────────────────────────────────────────────────

function BottomWaves() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute bottom-0 left-0 block h-[320px] w-full"
      viewBox={`0 0 1280 ${LOGIN_WAVE_BOTTOM}`}
      preserveAspectRatio="none"
      style={{ animation: "chFadeUpSmall 900ms 500ms backwards ease-out" }}
    >
      {LOGIN_WAVES.map((w, i) => (
        <DriftingWave key={i} {...w} />
      ))}
    </svg>
  );
}
