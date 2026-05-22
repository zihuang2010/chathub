// 统一变更通知协议 —— 跟 Rust `chathub_net::change_notice` 对齐。
// 设计纪律与扩展规则见 backends/crates/chathub-net/src/change_notice.rs 文件头注释。

/** 资源类型枚举。新加资源时同时扩 Rust ChangeTopic 与本 union。 */
export type ChangeTopic = "accounts" | "friends" | "recent-sessions" | "conversation-messages";

/** 影响范围。employeeId 必带;其他字段缺省视为"全量"。 */
export interface ChangeScope {
  employeeId: string;
  wecomAccountId?: string;
  conversationId?: string;
  externalUserId?: string;
}

export type ChangeKind = "upsert" | "delete" | "bulk-invalidate";

export type ChangeSource = "server-event" | "local-command" | "resync";

export interface ChangeNotice {
  topic: ChangeTopic;
  scope: ChangeScope;
  kind: ChangeKind;
  source: ChangeSource;
  occurredAtMs: number;
}

// ─── Scope match 算法 ───────────────────────────────────────────────────────
//
// 一个 ChangeNotice 是否影响某个查询订阅?
//   - employeeId 必须一致(跨员工隔离铁律)
//   - 订阅指定的每个非空字段,要么 notice 此字段缺省(广义影响),要么相等
//
// 形式化:notice.scope ⊇ subscription.scope (排除 notice 自身缺省字段)

/** 判定一个 notice 是否匹配某个订阅 scope。 */
export function scopeMatches(noticeScope: ChangeScope, subscriptionScope: ChangeScope): boolean {
  if (noticeScope.employeeId !== subscriptionScope.employeeId) return false;
  const keys: (keyof Omit<ChangeScope, "employeeId">)[] = [
    "wecomAccountId",
    "conversationId",
    "externalUserId",
  ];
  for (const k of keys) {
    const sub = subscriptionScope[k];
    const ev = noticeScope[k];
    // 订阅未指定 → 任何 notice 都匹配此维度
    // notice 未指定 → "广义影响",匹配任何订阅的此维度
    // 两者都指定但不等 → 不匹配
    if (sub != null && ev != null && sub !== ev) return false;
  }
  return true;
}
