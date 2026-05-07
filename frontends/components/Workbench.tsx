import { useState } from "react";

import { PlaceholderPage } from "@/components/workbench/PlaceholderPage";
import { Sidebar } from "@/components/workbench/Sidebar";
import { type Section } from "@/components/workbench/nav";
import { CustomersPage } from "@/components/workbench/customers/CustomersPage";
import { MessagesPage } from "@/components/workbench/messages/MessagesPage";
import { FONT_BODY } from "@/lib/theme";

export function Workbench() {
  const [section, setSection] = useState<Section>("messages");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
      {section === "messages" ? (
        <MessagesPage />
      ) : section === "customers" ? (
        <CustomersPage />
      ) : (
        <PlaceholderPage section={section} />
      )}
    </div>
  );
}
