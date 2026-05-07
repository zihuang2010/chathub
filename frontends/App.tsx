import { useCallback, useEffect, useState } from "react";

import { Login } from "@/components/Login";
import { Splash } from "@/components/Splash";
import { TitleBar } from "@/components/TitleBar";
import { Workbench } from "@/components/Workbench";
import { checkForAppUpdates } from "@/lib/updater";
import { cn } from "@/lib/utils";

const SPLASH_DURATION_MS = 2000;

function App() {
  const [splashHidden, setSplashHidden] = useState(false);
  const [splashFading, setSplashFading] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    void checkForAppUpdates({ silent: true });
  }, []);

  const handleSplashReady = useCallback(() => {
    setSplashFading(true);
    window.setTimeout(() => setSplashHidden(true), 700);
  }, []);

  return (
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
  );
}

export default App;
