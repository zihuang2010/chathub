import { useCallback, useEffect, useState } from "react";

import { Login } from "@/components/Login";
import { Splash } from "@/components/Splash";
import { TitleBar } from "@/components/TitleBar";
import { WindowResizeEdges } from "@/components/WindowResizeEdges";
import { Workbench } from "@/components/Workbench";
import { checkForAppUpdates } from "@/lib/updater";
import { cn } from "@/lib/utils";
import { useWindowMaxSize } from "@/lib/useWindowMaxSize";

const SPLASH_DURATION_MS = 2000;

function App() {
  const [splashHidden, setSplashHidden] = useState(false);
  const [splashFading, setSplashFading] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);

  useWindowMaxSize();

  useEffect(() => {
    void checkForAppUpdates({ silent: true });
  }, []);

  const handleSplashReady = useCallback(() => {
    setSplashFading(true);
    window.setTimeout(() => setSplashHidden(true), 700);
  }, []);

  return (
    <>
      <div
        id="app-shell"
        className="relative h-full w-full overflow-hidden bg-[#F1F5F9] text-foreground"
      >
        <TitleBar tone={loggedIn ? "blue" : "transparent"} />

        {/* Underlying view fades in while the splash overlay fades out. */}
        {(splashFading || splashHidden) &&
          (loggedIn ? <Workbench /> : <Login onSuccess={() => setLoggedIn(true)} />)}

        {!splashHidden && (
          <div
            className={cn(
              "absolute inset-0 z-40 transition-opacity duration-700 ease-out",
              splashFading && "pointer-events-none opacity-0",
            )}
          >
            <Splash durationMs={SPLASH_DURATION_MS} onReady={handleSplashReady} />
          </div>
        )}
      </div>
      {/* 视口边缘的不可见 resize 命中区 — 与 #app-shell 同级，避免被它的
          overflow:hidden 裁掉。仅 macOS 注入；详见组件内注释。 */}
      <WindowResizeEdges />
    </>
  );
}

export default App;
