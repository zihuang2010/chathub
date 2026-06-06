# 附件转存状态实时更新修复 — 设计

日期:2026-06-06
范围:后端消息同步(chathub-net / chathub-state)。前端不改动。
验证:Rust 单测为主。

---

## 1. 背景与症状

收到客户/多端同步的非文本消息(图片/文件/语音/视频/图文)时,附件带 `transferStatus`:
`0=无需转存,1=待转存,2=成功,3=失败`,前端据此分别展示(骨架/占位/就绪)。

转存完成后上游会再推一条 `MESSAGE_UPSERT` + `eventReason=ATTACHMENT_TRANSFER_CHANGED`
(同一条消息,`transferStatus` 变为 2)。期望:客户端**动态**把「转存中」刷成「就绪」。

**实测症状:开着的会话卡在「转存中/占位」,不刷新;切走再切回 / 重启才更新。**

## 2. 证据(日志 + 真机 state.sqlite 交叉验证)

- DB 现状:转存成功(2)72 条、**永久卡在待转存(1)11 条**、失败(3)7 条。
- 那 11 条覆盖全部非文本类型,最早来自 2026-06-02(卡 4 天),**所在会话都仍有 window**。
- 两条真实 `ATTACHMENT_TRANSFER_CHANGED`(语音)经直连 upsert 后 DB 已是 2 ✓;
  但会话 `2060260503288029184`(含 7 条卡死)在 06-02/06-03 两天日志里 **0 条 transfer-changed**,
  却有**大量 `reconcile_newest` 反复重拉上游首页并无条件覆盖**。
- 前端链路验证完好:`valueEqual` 深比较已能感知 `transferStatus` 变化并触发 re-render;
  问题在后端「更新被静默丢弃 / 被回退」。

## 3. 根因(三处叠加)

1. **`reconcile_newest` 的 `should_notify` 只看水位推进**(`message_sync.rs` Stitch 分支)。
   转存状态变化不改 `sortKey`(同一条消息)→ `page_newest == prev_newest` → `should_notify=false`
   → DB 悄悄写了新值但**不发 ChangeNotice → 前端永不重读**。

2. **`upsert_messages` 无条件覆盖 `attachments_json`**(`messages.rs` ON CONFLICT)。
   `send_status` 有"不倒退"CASE,但**附件 `transferStatus` 没有**。reconcile 重拉上游历史
   若仍返回 `transferStatus=1`,会把已成功的 2 **打回 1** → 永久卡死。

3. **`MessageEventApplier` 冷会话(无 window)整条事件 `continue` 跳过**(`message_event.rs`)。
   无窗会话的 transfer-changed 既不落库也不通知;重开后再撞上根因 1/2。

## 4. 修复方案(根因 1+2+3,后端三点)

### 不降级语义(贯穿 2 与 3)

> **一旦某条消息的附件集合不再含「待转存(1)」,就不允许被一个「含待转存(1)」的载荷覆盖回去。**

转存是单向单调的(pending → success/fail 终态,不会再回 pending),故"拒绝任何 →pending 的覆盖"安全。
SQL 实现(与 `send_status` 的 CASE 同位置、同风格):

```sql
attachments_json = CASE
    WHEN attachments_json          NOT LIKE '%"transferStatus":1%'
     AND excluded.attachments_json     LIKE '%"transferStatus":1%'
    THEN attachments_json          -- 已脱离 pending,拒绝回退
    ELSE excluded.attachments_json
END
```

说明:`attachments_json` 由我方序列化器(realtime 透传上游原始 JSON / reconcile 走 serde),
键形态固定为 `"transferStatus":N`(无空格,N∈0..3),LIKE 模式安全。`[]`(无附件,如文本)
恒不含 pending → 永远走 ELSE,对非附件消息零行为变化。混合附件(一已成一待转)按现状取上游新值。

### 改动点 A — 根因 2:`MessagesStore::upsert_messages`(`chathub-state/src/messages.rs`)

ON CONFLICT 的 `attachments_json = excluded.attachments_json` 改为上面的 no-downgrade CASE。
覆盖所有 upsert 路径(reconcile / 在线直连 / 失败气泡 / 图片预取)。
**⚠️ HIGH 风险**(13 直接调用方,含多个单测)→ 必须配套单测。

### 改动点 B — 根因 1:`MessageSync::reconcile_newest` Stitch 分支(`chathub-net/src/message_sync.rs`)

新增「升级检测」:本次首页把某条**本地原为待转存(1)**的消息推进到非 pending(2/3)→
即使 `sortKey` 未推进也通知。

```rust
ReconcileMode::Stitch => {
    let existing = self.store.list_recent(employee_id, conversation_id, rows.len()).await?;
    let was_pending: HashSet<String> = existing.iter()
        .filter(|r| r.attachments_json.contains("\"transferStatus\":1"))
        .map(|r| r.local_message_id.clone()).collect();
    self.store.upsert_messages(&rows).await?;
    let advanced = /* 现状:page_newest > prev_newest */;
    let transfer_upgraded = rows.iter().any(|r|
        was_pending.contains(&r.local_message_id)
        && !r.attachments_json.contains("\"transferStatus\":1"));
    /* 现状:扩 newest 上界 */
    advanced || transfer_upgraded
}
```

与 no-downgrade 一致:回退被 A 拦截 → 不会触发升级检测 → 不会误通知 → 不破坏既有
「notify→read→reconcile→notify 自激死循环」的防护(空 recents 搜索会话仍安全)。

### 改动点 C — 根因 3:冷会话已存在行 UPDATE-if-exists(`message_event.rs` + 新增 state 方法)

`chathub-state` 新增 `update_message_attachments_if_exists(employee_id, conversation_id,
local_message_id, attachments_json) -> bool`:`UPDATE … SET attachments_json=<no-downgrade CASE>,
updated_at_ms=? WHERE local_message_id=? AND employee_id=?`,返回 `rows_affected>0`。
**只 UPDATE 不 INSERT**(绝不建孤儿气泡,保住"冷会话不建气泡"不变量)。

`MessageEventApplier`:把 `if !has_window { continue; }` 改为——无窗时若 `decode_message_row`
成功且该行已存在 → 调用上面方法更新 + 把会话计入 `applied_convs`(末尾照常发 ConversationMessages 通知);
行不存在 → 仍跳过。

## 5. 验证(单测清单)

chathub-state(`messages.rs`):

- `upsert no-downgrade: 已成功(2)被含待转存(1)的载荷覆盖时保持 2`
- `upsert 正常升级: 待转存(1) → 成功(2) 正常写入`
- `upsert 对非附件消息([])行为不变`
- `update_message_attachments_if_exists: 行存在→更新返回 true;不存在→返回 false 且不插入`
- `update_message_attachments_if_exists: 同样遵守 no-downgrade`

chathub-net(`message_sync.rs`):

- `reconcile Stitch: 待转存→成功 即使水位未推进也 should_notify=true`
- `reconcile Stitch: 无变化 / 回退 → should_notify=false(不破坏防死循环)`

chathub-net(`message_event.rs`):

- `冷会话 transfer-changed: 已存在行被更新 + 进 applied_convs(发通知)`
- `冷会话 transfer-changed: 行不存在 → 不建孤儿、不通知`
- `热会话 transfer-changed: 维持现状直连 upsert + 通知`

最终:`cargo test`(相关 crate)全绿;`gitnexus_detect_changes` 确认影响面符合预期。

## 6. 影响与风险

- HIGH 风险集中在改动点 A(`upsert_messages`)。其余 LOW。
- 仅后端;前端零改动。
- 不改 `to_local_direction` / `normalize_sync_send_status` / send_status 合并等既有不变量。

## 7. 非目标(本次不做)

- **不**做存量 11 条卡死消息的一次性恢复(用户已选不含)。修复后:这些旧消息若其会话被
  reconcile 重新覆盖到且上游返回终态,会被改动点 B 救回;否则需后续单独的一次性 resync,本次不处理。
- 不动 silk/amr 应用内播放等渲染细节。
