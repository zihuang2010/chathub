import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { MessageBubble } from "@/components/workbench/messages/MessageBubble";
import type { Message } from "@/components/workbench/messages/data";

import "./index.css";

function synced(id: string, text: string): Message {
  return {
    id,
    conversationId: "c1",
    direction: "out",
    text,
    sentAt: "2026-06-06T14:00:00.000Z",
    status: "sent",
    parts: [{ kind: "text", text }],
    syncedFromOtherDevice: true,
  };
}

const msgs = [
  synced("1", "天健湖"),
  synced("2", "天健湖"),
  synced("3", "369"),
  synced("4", "361213号门"),
];

function App() {
  return (
    <div
      style={{
        width: 280,
        margin: "24px auto",
        padding: 16,
        background: "hsl(var(--wb-surface, 0 0% 100%))",
      }}
    >
      {/* 一条恒定红色竖线标出头像左缘所在位置,肉眼对照徽章右缘是否齐 */}
      {msgs.map((m, i) => (
        <div key={m.id} style={{ marginTop: i === 0 ? 0 : 44 }}>
          <MessageBubble message={m} avatarName="梁" account="梁" />
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
