import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { Login } from "@/components/Login";
import { Splash } from "@/components/Splash";
import { TitleBar } from "@/components/TitleBar";
import { WindowResizeEdges } from "@/components/WindowResizeEdges";
import { Workbench } from "@/components/Workbench";
import { UpdateDialogViewport } from "@/components/ui/UpdateDialog";
import { useMessagesReady } from "@/lib/data/appReady";
import { changeBus } from "@/lib/data/changeBus";
import { checkForAppUpdates } from "@/lib/updater";
import { cn } from "@/lib/utils";
import { useWindowMaxSize } from "@/lib/useWindowMaxSize";

const SPLASH_DURATION_MS = 2000;

/** 对齐 chathub-proto::UserProfile,prost 默认 snake_case 序列化。 */
export interface UserProfile {
  user_id: string;
  display_name: string;
  avatar_url: string;
  role: string;
  tenant_id: string;
  username: string;
  mobile: string;
}

/** 后端 broadcast 的登出原因(LoggedOutReason),emit 时序列化为 {"reason": "manual" | "token-invalid" | "kicked"}。 */
export type LoggedOutReason = "manual" | "token-invalid" | "kicked";

function App() {
  // Splash 自身计时到达后置 true(handleSplashReady 回调,不在 effect 内)
  const [splashReady, setSplashReady] = useState(false);
  const [splashHidden, setSplashHidden] = useState(false);
  // 三态:undefined = try_resume 还没回结果;null = 确定未登录;UserProfile = 已登录
  const [profile, setProfile] = useState<UserProfile | null | undefined>(undefined);
  // 被踢/失效时携带的提示,Login mount 时通过 prop 一次性消费
  const [loginNotice, setLoginNotice] = useState<string | null>(null);

  useWindowMaxSize();

  useEffect(() => {
    void checkForAppUpdates({ silent: true });
    // 全局 ChangeBus 启动 —— 整个应用只有这一个 listen("hub:change")。
    void changeBus.start();
  }, []);

  // C1: bootstrap — 调 current_session 决定首屏(try_resume_session 是后端 setup
  // 阶段 spawn 的,这里 invoke 时 token 已经被恢复到内存或 None)。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const p = await invoke<UserProfile | null>("current_session");
        if (!cancelled) setProfile(p);
      } catch {
        if (!cancelled) setProfile(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // C2: 监听 auth:logged_out — token 失效 / 被踢 / 主动登出时 emit
  // backends/src/lib.rs 已经在 setup 阶段桥接了 LoggedOutReason broadcast。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await listen<{ reason: LoggedOutReason }>("auth:logged_out", (event) => {
        const reason = event.payload?.reason;
        // 注意:先 set notice 再 set profile,确保 Login mount 时 notice 已就绪
        if (reason === "token-invalid") {
          setLoginNotice("登录已失效,请重新登录");
        } else if (reason === "kicked") {
          setLoginNotice("账号在其他设备登录,本端已退出");
        } else {
          setLoginNotice(null);
        }
        setProfile(null);
      });
    })();
    return () => unlisten?.();
  }, []);

  // Splash 内部计时到点 → 触发 ready(只 set 一个 boolean,无副作用)。
  const handleSplashReady = useCallback(() => setSplashReady(true), []);

  // 消息页首屏 cache 是否已读出。Workbench 内的 MessagesPage 在 useRecentFriends
  // initialFetched=true 后通过 appReady.setMessagesReady() 发布信号;splash 等到
  // 数据就绪后再 fade,避免退场后出现"Skeleton → 真组件"二次跳变。
  const messagesReady = useMessagesReady();

  // ─── Splash 退场状态机(生产级丝滑过渡的关键所在) ──────────────────────
  //
  // 设计要点:
  //
  // 1. **Underlying view 提前挂载**(`profile !== undefined` 即渲染):Workbench
  //    在 splash 还盖在上面的时候就 mount,内部 hook(useRecentFriends 等)同步
  //    起跑;等 splash 真退场时数据已经在,**用户看到的就是真组件,无 Skeleton swap**。
  //    旧实现把 Workbench mount 条件绑在 shouldFade 上,与 messagesReady 互为前提
  //    形成死锁,必然等 backstop 强制 fade → Skeleton → 真组件 → 闪得最重。
  //
  // 2. **退场条件**:splashReady(自身计时到)+ profile 已确定 + 数据门(已登录则
  //    等 messagesReady,未登录直接放行)三者全部满足。
  //
  // 3. **TitleBar 与 splash 同步**:tone 跟 shouldFade(开始 fade)绑定而非
  //    splashHidden(完全消失),避免"splash 消失瞬间顶部突然变蓝"二次跳变;
  //    两者在 240ms 内并行完成。
  //
  // 4. **Fade 240ms + cubic-bezier**:200ms 太仓促,300ms+ splash 装饰会半透叠加
  //    到 Workbench 造成视觉混乱;240ms 是肉眼舒适但解析不出细节的甜区。
  //    曲线用 cubic-bezier(0.4,0,0.2,1)("standard easing"),开始略快尾部缓收。
  const SPLASH_FADE_MS = 240;
  // 数据迟到兜底:splashReady + profile 到了之后,最多再等 1500ms;到时强制 fade,
  // 防止后端拉取失败或离线时 splash 卡死不退。MessagesSkeleton 兜底 swap 体感。
  // 常规场景(本地 cache 命中)useRecentFriends 几十毫秒就 ready,backstop 走不到。
  const DATA_GATE_BACKSTOP_MS = 1500;
  const [backstopTripped, setBackstopTripped] = useState(false);
  const loggedIn = !!profile;
  useEffect(() => {
    if (!splashReady || profile === undefined) return;
    if (!loggedIn) return;
    if (messagesReady) return;
    const t = window.setTimeout(() => setBackstopTripped(true), DATA_GATE_BACKSTOP_MS);
    return () => window.clearTimeout(t);
  }, [splashReady, profile, loggedIn, messagesReady]);

  const dataGateOpen = !loggedIn || messagesReady || backstopTripped;
  const shouldFade = splashReady && profile !== undefined && dataGateOpen;
  useEffect(() => {
    if (!shouldFade || splashHidden) return;
    const t = window.setTimeout(() => setSplashHidden(true), SPLASH_FADE_MS);
    return () => window.clearTimeout(t);
  }, [shouldFade, splashHidden]);

  // TitleBar 蓝色 frosted glass 与 splash 退场**同步开始**:用户感知是"splash 淡出 +
  // 顶部蓝色淡入"一次性完成,而非两步跳变。TitleBar 内部已对 background-color 加 200ms
  // transition,与本处 240ms 几乎重合,体感是单一过渡。
  const titleBarBlue = loggedIn && shouldFade;

  return (
    <>
      <div
        id="app-shell"
        className="relative h-full w-full overflow-hidden bg-[#F1F5F9] text-foreground"
      >
        <TitleBar tone={titleBarBlue ? "blue" : "transparent"} />

        {/* Underlying view 在 profile 就绪后立即挂载,与 splash 并行存在;splash z:40
            覆盖在上,用户看不到 underlying 的初始数据加载过程。等数据就绪 splash 退场,
            用户看到的就是完整真组件。 */}
        {profile !== undefined &&
          (profile ? (
            <Workbench />
          ) : (
            <Login notice={loginNotice} onSuccess={(p) => setProfile(p)} />
          ))}

        {!splashHidden && (
          <div
            className={cn("absolute inset-0 z-40", shouldFade && "pointer-events-none opacity-0")}
            style={{
              // 与 SPLASH_FADE_MS 一致 + standard easing(Material/Apple 通用曲线);
              // duration 用 inline style 精确指定,避免依赖 Tailwind arbitrary value JIT。
              transition: "opacity 240ms cubic-bezier(0.4, 0, 0.2, 1)",
            }}
          >
            <Splash durationMs={SPLASH_DURATION_MS} onReady={handleSplashReady} />
          </div>
        )}
      </div>
      {/* 视口边缘的不可见 resize 命中区 — 与 #app-shell 同级，避免被它的
          overflow:hidden 裁掉。仅 macOS 注入；详见组件内注释。 */}
      <WindowResizeEdges />
      {/* 应用更新弹窗 —— 挂在 App 根,登录前后均覆盖(启动自查 + UserMenu 手动检查共用)。 */}
      <UpdateDialogViewport />
    </>
  );
}

export default App;
