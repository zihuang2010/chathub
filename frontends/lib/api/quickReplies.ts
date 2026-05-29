// 快捷回复 API 层 —— 纯客户端本地表(hub_quick_replies),按登录员工隔离。
// 桥接 4 个 Tauri command:list / create / update / delete。
// 无服务端同步:CRUD 全落本地 SQLite,employee_id 由后端从当前会话注入。

import { invoke } from "@tauri-apps/api/core";

/** 本地快捷回复行,对齐 Rust `QuickReplyRow`(camelCase)。 */
export interface QuickReplyRecord {
  id: string;
  employeeId: string;
  title: string;
  content: string;
  sortOrder: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/** 列出当前登录员工的全部快捷回复(按 sortOrder 升序)。 */
export async function listQuickReplies(): Promise<QuickReplyRecord[]> {
  return await invoke<QuickReplyRecord[]>("list_quick_replies");
}

/** 新建快捷回复。id 由前端生成(crypto.randomUUID),保证 PK 唯一。 */
export async function createQuickReply(id: string, title: string, content: string): Promise<void> {
  await invoke<void>("create_quick_reply", { id, title, content });
}

/** 修改快捷回复的标题 / 正文。 */
export async function updateQuickReply(id: string, title: string, content: string): Promise<void> {
  await invoke<void>("update_quick_reply", { id, title, content });
}

/** 删除快捷回复。 */
export async function deleteQuickReply(id: string): Promise<void> {
  await invoke<void>("delete_quick_reply", { id });
}
