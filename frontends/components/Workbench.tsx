import { useCallback, useState } from "react";
import type { ReactNode } from "react";

import { PlaceholderPage } from "@/components/workbench/PlaceholderPage";
import { Sidebar } from "@/components/workbench/Sidebar";
import { type Section } from "@/components/workbench/nav";
import { AccountsPage } from "@/components/workbench/accounts/AccountsPage";
import { CustomersPage } from "@/components/workbench/customers/CustomersPage";
import { MessagesPage } from "@/components/workbench/messages/MessagesPage";
import { useAccounts } from "@/lib/api/useAccounts";
import { FONT_BODY } from "@/lib/theme";

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
      {/* 所有 section 常驻挂载(保留选中会话 / 滚动位置 / 草稿等组件内状态,切走再回来不闪、
          不重拉)。但非激活页用 content-visibility:hidden 让 WebKit 跳过其内容的布局/绘制/合成
          并释放这部分渲染内存——只有当前页真正参与渲染,避免三整页同时驻留渲染树把「页面」内存
          撑到几百 MB。仅当前 section 接收交互(pointer-events),其它 aria-hidden 静默。 */}
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
    <div
      className="absolute inset-0 flex"
      // 非激活页 content-visibility:hidden —— WebKit 跳过其内容的布局/绘制/合成并可释放渲染
      // 内存,同时保留 DOM 与 React 状态(切回秒恢复,滚动位置不丢)。激活页正常渲染。
      // 不再用 framer-motion 的 opacity 淡入淡出:淡入淡出会把整窗子树提升为合成层并在每次切换
      // 全面重绘,正是「页面」内存峰值的来源;改为直接硬切(状态/滚动/草稿仍保留)。
      // 非 active 层不吃事件、aria-hidden 让读屏忽略。
      style={{
        contentVisibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
      }}
      aria-hidden={!active}
    >
      {children}
    </div>
  );
}
