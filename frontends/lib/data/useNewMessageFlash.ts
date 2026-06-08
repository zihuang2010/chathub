// useNewMessageFlash — 收到新入站消息且窗口失焦时,闪烁任务栏(Windows)/ 跳动 Dock(macOS)。
//
// 设计:
//   - 订阅 ChangeBus topic="conversation-messages",scope={employeeId}(当前登录用户)。
//   - 仅对 kind="upsert" + source="server-event" 触发(服务端推送的新消息);
//     local-command(自己发的)与 bulk-invalidate(resync/fallback 整表重拉)都跳过。
//   - 触发前判 isFocused():用户正盯着窗口就不闪。
//   - 调 requestUserAttention(Critical):Windows 持续闪到窗口获焦,macOS Dock 跳动。
//     窗口获焦后系统自动停闪,无需手动取消。
//
// 已知取舍(v1):ChangeNotice 不带消息方向,多端同步回灌「自己另一端发的消息」也是
// server-event,会被一并闪一下(轻微误触发)。要精准需在闪前读那条消息的 direction,留待后续。

import { useEffect } from "react";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";

import { changeBus } from "./changeBus";
import { useCurrentEmployeeId } from "./useCurrentEmployeeId";

export function useNewMessageFlash(): void {
  const employeeId = useCurrentEmployeeId();

  useEffect(() => {
    if (!employeeId) return;
    return changeBus.subscribe("conversation-messages", { employeeId }, (notice) => {
      // 只对服务端推送的新消息闪;自己发的(local-command)、整表重拉(bulk-invalidate)跳过。
      if (notice.kind !== "upsert" || notice.source !== "server-event") return;
      void (async () => {
        const win = getCurrentWindow();
        if (await win.isFocused()) return;
        await win.requestUserAttention(UserAttentionType.Critical);
      })();
    });
  }, [employeeId]);
}
