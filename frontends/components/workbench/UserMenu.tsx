import { useEffect, useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { getVersion } from "@tauri-apps/api/app";
import { Info, LogOut } from "lucide-react";

import { BubbleBlue } from "@/components/illustrations";
import { Modal } from "@/components/ui/Modal";
import { showToast } from "@/components/ui/toast";
import { invokeWithTimeout } from "@/lib/api/invokeClient";
import { cn } from "@/lib/utils";

/**
 * 左下角「更多」菜单:点「更多」弹出「关于」「退出」两项。
 *
 * 退出无需在此 setProfile —— 后端 `logout` 命令会 broadcast Manual,经 lib.rs 桥接为
 * `auth:logged_out{reason:"manual"}`,App.tsx 监听后自动切回登录页(见 App.tsx C2)。
 */
export function UserMenu({ children }: { children: ReactNode }) {
  const [aboutOpen, setAboutOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="right"
            align="end"
            sideOffset={8}
            className="z-[120] min-w-[160px] overflow-hidden rounded-md border border-workbench-line bg-workbench-surface p-1 shadow-wb-popover"
          >
            <DropdownMenu.Item
              onSelect={() => setAboutOpen(true)}
              className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-wb-2xs text-workbench-text outline-none transition-colors data-[highlighted]:bg-workbench-surface-subtle"
            >
              <Info size={14} />
              关于
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onSelect={() => setConfirmOpen(true)}
              className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-wb-2xs text-workbench-danger outline-none transition-colors data-[highlighted]:bg-workbench-danger/10"
            >
              <LogOut size={14} />
              退出
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <LogoutConfirmDialog open={confirmOpen} onClose={() => setConfirmOpen(false)} />
    </>
  );
}

// ─── 关于 ─────────────────────────────────────────────────────────────────────

function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [version, setVersion] = useState("");

  // 版本号取自 tauri.conf.json(productName/version),运行时读,不硬编码。
  useEffect(() => {
    let cancelled = false;
    void getVersion().then((v) => {
      if (!cancelled) setVersion(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Modal open={open} onClose={onClose} labelledBy="about-title">
      <div className="flex flex-col items-center px-6 pb-6 pt-8 text-center">
        {/* 品牌 logo —— 复用 Splash/Login 同款蓝色气泡(绝对定位,套固定尺寸 relative 容器)。 */}
        <div className="relative mb-4 size-16">
          <BubbleBlue left={0} top={0} width={64} height={56} />
        </div>
        <h2 id="about-title" className="text-[16px] font-semibold text-workbench-text">
          匠多多企微聚合平台
        </h2>
        <p className="mt-1.5 font-numeric text-[12px] tabular-nums text-workbench-text-muted">
          {version ? `v${version}` : "—"}
        </p>
        <p className="mt-4 text-[11px] text-workbench-text-muted">© 2026 匠多多</p>
      </div>
    </Modal>
  );
}

// ─── 退出确认 ───────────────────────────────────────────────────────────────

function LogoutConfirmDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [loading, setLoading] = useState(false);

  const handleLogout = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await invokeWithTimeout<void>("logout");
      // 成功后无需在此处理:App.tsx 收到 auth:logged_out 事件会切回登录页并卸载本组件。
    } catch (err) {
      showToast(`退出失败:${err instanceof Error ? err.message : String(err)}`, {
        type: "error",
      });
      setLoading(false);
    }
  };

  return (
    <Modal open={open} onClose={loading ? () => {} : onClose} labelledBy="logout-title">
      <div className="px-6 pb-5 pt-6">
        <h2 id="logout-title" className="text-[15px] font-semibold text-workbench-text">
          确定退出登录？
        </h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-workbench-text-muted">
          退出后需重新登录才能继续使用。
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="focus-ring h-9 rounded-lg border border-workbench-line px-4 text-[13px] font-medium text-workbench-text transition-colors hover:bg-workbench-surface-subtle disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleLogout}
            disabled={loading}
            className={cn(
              "focus-ring h-9 rounded-lg px-4 text-[13px] font-medium text-white transition-colors",
              "bg-workbench-danger hover:opacity-90 disabled:opacity-60",
            )}
          >
            {loading ? "退出中…" : "退出"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
