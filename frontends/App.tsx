import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { Button } from "@/components/ui/button";
import { Login } from "@/components/Login";
import { Splash } from "@/components/Splash";
import { TitleBar } from "@/components/TitleBar";
import { cn } from "@/lib/utils";

const SPLASH_DURATION_MS = 5000;

function App() {
  const [splashHidden, setSplashHidden] = useState(false);
  const [splashFading, setSplashFading] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);

  const handleSplashReady = useCallback(() => {
    setSplashFading(true);
    window.setTimeout(() => setSplashHidden(true), 700);
  }, []);

  return (
    <div
      id="app-shell"
      className="relative h-screen w-screen overflow-hidden bg-background text-foreground"
    >
      <TitleBar showTitle={loggedIn} />

      {/* Underlying view fades in while the splash overlay fades out. */}
      {(splashFading || splashHidden) &&
        (loggedIn ? <MainShell /> : <Login onSuccess={() => setLoggedIn(true)} />)}

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

function MainShell() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");

  const greet = async () => {
    setGreetMsg(await invoke("greet", { name }));
  };

  return (
    <main className="flex h-full flex-col items-center justify-center gap-6 p-8 pt-12">
      <h1 className="text-3xl font-semibold tracking-tight">ChatHub · 匠多多企微聚合平台</h1>
      <p className="text-muted-foreground">Tauri + React + Tailwind v3 + shadcn/ui</p>

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void greet();
        }}
      >
        <input
          className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="输入名字…"
        />
        <Button type="submit">Greet</Button>
      </form>

      {greetMsg && <p className="text-sm">{greetMsg}</p>}
    </main>
  );
}

export default App;
