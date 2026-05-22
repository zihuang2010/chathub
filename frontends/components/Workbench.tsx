import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { motion } from "framer-motion";

import { PlaceholderPage } from "@/components/workbench/PlaceholderPage";
import { Sidebar } from "@/components/workbench/Sidebar";
import { type Section } from "@/components/workbench/nav";
import { AccountsPage } from "@/components/workbench/accounts/AccountsPage";
import { CustomersPage } from "@/components/workbench/customers/CustomersPage";
import { MessagesPage } from "@/components/workbench/messages/MessagesPage";
import { useAccounts } from "@/lib/api/useAccounts";
import { FONT_BODY, TRANSITION_DURATIONS, TRANSITION_EASE } from "@/lib/theme";

export function Workbench() {
  const [section, setSection] = useState<Section>("messages");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // 跨页跳转用的一次性意图：账号页点卡片 → 客户页消费后清空。
  const [pendingAccountFilter, setPendingAccountFilter] = useState<string | null>(null);

  // 账号列表 — 整个 workbench 共享一份。账号页 / 客户页都从这里读。
  const accountsState = useAccounts();

  const openAccountInCustomers = useCallback((accountId: string) => {
    setPendingAccountFilter(accountId);
    setSection("customers");
  }, []);

  const consumePendingAccountFilter = useCallback(() => {
    setPendingAccountFilter(null);
  }, []);

  return (
    <div
      // Bounded explicitly to the area BELOW the 40px title bar (`top-10`) and
      // the bottom edge (`bottom-0`). This guarantees the workbench cannot
      // exceed the viewport height — children with `h-full` resolve against
      // this exact box, never extending below the visible area.
      className="absolute inset-x-0 bottom-0 top-10 flex select-none overflow-hidden bg-[#F1F5F9] text-[#1F2937]"
      style={{ fontFamily: FONT_BODY }}
    >
      <Sidebar
        value={section}
        onChange={setSection}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
      />
      {/* 所有 section 常驻挂载,通过 opacity 切换可见性。这样切走再回来:
          - 选中会话 / 滚动位置 / 草稿 全部保留(状态在自己组件里)
          - 数据已加载,不会出现"MOCK fallback → 真数据"的气泡闪烁
          - 内存代价:同时挂三个页面的 hook 订阅。chat workbench 单用户场景可接受。
          仅当前 section 接收交互(pointer-events / inert),其它三个 opacity:0 静默。 */}
      <div className="relative flex min-w-0 flex-1">
        <SectionLayer active={section === "messages"}>
          <MessagesPage accounts={accountsState.accounts} />
        </SectionLayer>
        <SectionLayer active={section === "customers"}>
          <CustomersPage
            accounts={accountsState.accounts}
            pendingAccountFilter={pendingAccountFilter}
            onConsumePendingFilter={consumePendingAccountFilter}
          />
        </SectionLayer>
        <SectionLayer active={section === "accounts"}>
          <AccountsPage accountsState={accountsState} onOpenInCustomers={openAccountInCustomers} />
        </SectionLayer>
        {/* 未实现的 section(tasks/...)走占位页 —— 不需要保留状态,按需挂载即可。 */}
        {section !== "messages" && section !== "customers" && section !== "accounts" && (
          <SectionLayer active>
            <PlaceholderPage section={section} />
          </SectionLayer>
        )}
      </div>
    </div>
  );
}

function SectionLayer({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <motion.div
      className="absolute inset-0 flex"
      initial={false}
      animate={{ opacity: active ? 1 : 0 }}
      transition={{
        duration: TRANSITION_DURATIONS.quick / 1000,
        ease: TRANSITION_EASE,
      }}
      // 非 active 层不吃事件、不可达。aria-hidden 让 screen reader 忽略;
      // pointer-events:none 防止 click 穿透/被遮挡误触。
      style={{ pointerEvents: active ? "auto" : "none" }}
      aria-hidden={!active}
    >
      {children}
    </motion.div>
  );
}
