import { useEffect, useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { getVersion } from "@tauri-apps/api/app";
import { Info } from "lucide-react";

import { BubbleBlue } from "@/components/illustrations";
import { Modal } from "@/components/ui/Modal";

/**
 * 左下角「更多」菜单:点「更多」弹出「关于」。
 *
 * 退出登录已移至个人信息卡片(Sidebar 的 ProfilePopover),见 LogoutConfirmDialog。
 */
export function UserMenu({ children }: { children: ReactNode }) {
  const [aboutOpen, setAboutOpen] = useState(false);

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
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
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
