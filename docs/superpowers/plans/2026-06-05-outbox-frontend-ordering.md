# 出站失败气泡持久化 — 前端排序修正（Plan C）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修 `replaceAuthoritative` 排序，让失败气泡按 sentAt 归位（不再被冻结在沉底位），既治「失败气泡沉底」现场症状，又不破坏既有 25 条排序断言。

**Architecture:** 把排序从「knownAuth 前缀 + leftover 尾段归并」改为「real 消息 spine（已显示保位+新消息追底）+ failed 按 sentAt 稳定插入整条时间线 + 在途/待回显 leftover 贴底」。纯前端，独立 `pnpm vitest` 可验。**不依赖 Plan A/B**——它单独就能让失败气泡按时间归位（持久化由 Plan A 提供，但本修对内存态失败气泡同样生效）。

**Tech Stack:** TypeScript / React / Zustand / Vitest。设计依据：`docs/superpowers/specs/2026-06-05-outbox-failed-bubble-design.md`（§6）。

**前置约定：**

- 分支 `feat/outbox-failed-bubble`。
- 本计划只动 `frontends/components/workbench/messages/store/chatStore.ts` 与其单测，**不碰 useChatActions.ts**（避开并发 WIP）。
- 所有 `pnpm`/`vitest` 命令 cwd = **仓库根目录**（不是 frontends/）。

---

## 根因与算法

当前 `replaceAuthoritative`（chatStore.ts:278-313）排序：`order = knownAuth(按先前位置冻结) ++ mergeByTimeAscending(newAuthIds, leftover)`。缺陷：① 失败 leftover 一律塞尾段；② 一旦失败行落库成权威（id=client_msg_id 命中 priorIndex），被判 knownAuth 冻结在**已沉底**的先前位置 → 永远在后发成功消息下方（两次重读竞态）。

**新算法**（三类）：

1. **spine = 非 failed 的权威消息**：已显示的（knownAuth，m.id 或 echo.id 在 priorIndex）按先前相对位置冻结；本批新出现的（newAuth）按服务端序追加到底。real 之间不重排 → 保住「已显示保位 / 同毫秒不翻序 / 迟到入站追底」三测。
2. **failed（status==='failed'，含 leftover 失败气泡 + 已落库权威失败行）按 sentAt 插进 spine**：稳定插入 = 在每个 spine 元素前，先吐出所有 sentAt **严格小于**它的 failed（同毫秒 → 失败排在 real 之后，与「失败文本不被同内容权威吞」测一致）。
3. **其余 leftover（在途 sending / 已 markSent 待回显 sent）贴底**，保持先前相对序。

---

## File Structure

| 文件                                                              | 职责                                                                     | 改动 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ | ---- |
| `frontends/components/workbench/messages/store/chatStore.ts`      | replaceAuthoritative 排序段重写；删除变为死代码的 `mergeByTimeAscending` | 改   |
| `frontends/components/workbench/messages/store/chatStore.test.ts` | 新增两条护栏红测                                                         | 增   |

---

## Task 1: 两条红测（TDD：先看它们在当前 main 失败）

**Files:** Modify `frontends/components/workbench/messages/store/chatStore.test.ts`（`describe("chatStore reducers", ...)` 内追加）

- [ ] **Step 1: 追加两条测试**

```ts
it("两次重读:失败行落库为权威后仍按 sentAt 排在后发成功行之上(堵 priorIndex 冻结)", () => {
  // 第一次重读:A 失败(leftover),只回后发成功 server 行 → A 沉底为 leftover
  let slice = sliceWith([
    optimistic("c-1", {
      status: "failed",
      sentAt: "2026-05-19T00:00:00.000Z",
      text: "先发失败",
      parts: [{ kind: "text", text: "先发失败" }],
    }),
  ]);
  slice = replaceAuthoritative(slice, [
    msg("server-2", {
      direction: "out",
      status: "sent",
      sentAt: "2026-05-19T00:00:10.000Z",
      text: "后发成功",
      parts: [{ kind: "text", text: "后发成功" }],
    }),
  ]);
  expect(selectTimeline(slice).map((e) => e.id)).toEqual(["c-1", "server-2"]);

  // 第二次重读:A 落库,以权威失败行(id=c-1,direction out,send_status=4→failed)带回
  const next = replaceAuthoritative(slice, [
    msg("server-2", {
      direction: "out",
      status: "sent",
      sentAt: "2026-05-19T00:00:10.000Z",
      text: "后发成功",
      parts: [{ kind: "text", text: "后发成功" }],
    }),
    msg("c-1", {
      direction: "out",
      status: "failed",
      sentAt: "2026-05-19T00:00:00.000Z",
      text: "先发失败",
      parts: [{ kind: "text", text: "先发失败" }],
    }),
  ]);
  // 当前 main 会 FAIL(A 撞沉底 priorIndex 被冻结 → ["server-2","c-1"]);修后应:
  expect(selectTimeline(next).map((e) => e.id)).toEqual(["c-1", "server-2"]);
  expect(next.byId["c-1"].status).toBe("failed");
});

it("反例护栏:失败行 sentAt 落在已显示历史中段,无关重读不顶动已显示的真实消息", () => {
  // h0(t0) 已显示, A(t1) 失败已显示中段, S(t2) 成功已显示 → 三条都在 slice.order
  const slice = sliceWith([
    msg("h0", { sentAt: "2026-05-19T00:00:00.000Z" }),
    optimistic("c-1", {
      status: "failed",
      sentAt: "2026-05-19T00:00:05.000Z",
      text: "A",
      parts: [{ kind: "text", text: "A" }],
    }),
    msg("S", { direction: "out", status: "sent", sentAt: "2026-05-19T00:00:10.000Z" }),
  ]);
  // 无关重读(同一份权威 h0/S 再来一次,A 仍只在本地)
  const next = replaceAuthoritative(slice, [
    msg("h0", { sentAt: "2026-05-19T00:00:00.000Z" }),
    msg("S", { direction: "out", status: "sent", sentAt: "2026-05-19T00:00:10.000Z" }),
  ]);
  // 当前 main 会 FAIL(A 塞尾段 → ["h0","S","c-1"]);修后应保 A 在中段:
  expect(selectTimeline(next).map((e) => e.id)).toEqual(["h0", "c-1", "S"]);
});
```

> `msg`/`optimistic`/`sliceWith`/`selectTimeline`/`replaceAuthoritative` 均为本测试文件既有 helper/导入（见文件顶部，`msg` 默认 direction "in"、`optimistic` 默认 direction "out" status "sending"）。

- [ ] **Step 2: 运行确认两测在当前 main 失败**

Run（cwd=仓库根目录）: `pnpm vitest run chatStore --reporter=verbose 2>&1 | grep -E "两次重读|反例护栏|✓|✗|FAIL|passed|failed"`
Expected: 两条新测 **FAIL**——「两次重读」得 `["server-2","c-1"]`、「反例护栏」得 `["h0","S","c-1"]`（失败行被沉底/塞尾），证明 bug 真实存在。其余既有测仍 PASS。

（本任务不单独提交——红测与实现一起在 Task 2 提交，符合 TDD。）

---

## Task 2: 实现 anchored insertion（两测转绿 + 既有 25 测不破 + 删死代码）

**Files:** Modify `frontends/components/workbench/messages/store/chatStore.ts`

- [ ] **Step 1: 重写排序段**

In `replaceAuthoritative`，把从 `// ── 排序:单调插入...` 注释块开始、到 `const order = [ ... ];` 结束的整段（当前约 chatStore.ts:278-309，即 `const priorIndex = new Map...` 到 `mergeByTimeAscending(...)` 闭合的 `];`）**整体替换**为：

```ts
// ── 排序:real 消息构成 spine(已显示保位 + 新消息追底);failed 按 sentAt 插入整条时间线;
//          在途/待回显(sending/sent leftover)贴底 ────────────────────────────────────
// 三类:① real 权威消息 = spine,已显示的(knownAuth)按先前相对位置冻结、本批新出现的(newAuth)
// 按服务端序追加到底,real 之间不重排(保住「已显示保位/同毫秒不翻序/迟到入站追底」三测);
// ② status==='failed' 的条目(失败行,无论 leftover 还是已落库的权威失败行)按 sentAt 插进 spine ——
// 锚定在过去时刻的失败气泡落回正确位置,杜绝「先沉底→后发成功收敛→失败行被冻结在沉底位」竞态;
// ③ 其余 leftover(在途 sending / 已 markSent 待回显 sent)贴底。failed 用「插在第一个 sentAt 严格
// 大于它的 spine 元素之前」的稳定插入:同毫秒时排在 real 之后(与「失败文本不被同内容权威吞」测一致)。
const at = (id: string) => new Date(byId[id]?.sentAt ?? 0).getTime();
const priorIndex = new Map<string, number>();
slice.order.forEach((id, i) => priorIndex.set(id, i));
const knownAuth: { id: string; idx: number }[] = [];
const newAuthIds: string[] = [];
for (const m of messages) {
  if (byId[m.id]?.status === "failed") continue; // 失败权威行不进 spine,稍后按 sentAt 插
  const echo = echoLookup.get(m.id) ?? matchedEcho.get(m.id);
  let idx = priorIndex.get(m.id);
  if (idx === undefined && echo) idx = priorIndex.get(echo.id);
  if (idx === undefined) newAuthIds.push(m.id);
  else knownAuth.push({ id: m.id, idx });
}
knownAuth.sort((a, b) => a.idx - b.idx);
const spine = [...knownAuth.map((k) => k.id), ...newAuthIds];

// 所有 status==='failed' 实体(权威失败行 + leftover 失败气泡;byId 键唯一,无重复),按 sentAt 升序。
const failedIds = Object.keys(byId)
  .filter((id) => byId[id]?.status === "failed")
  .sort((a, b) => at(a) - at(b));
// 非失败 leftover(在途 sending / 待回显 sent)贴底,保持先前相对序。
const tailLeftover = leftover.filter((e) => e.status !== "failed").map((e) => e.id);

// failed 稳定插入 spine:在每个 spine 元素前,先吐出所有 sentAt 严格小于它的 failed。
const withFailed: string[] = [];
let fi = 0;
for (const id of spine) {
  while (fi < failedIds.length && at(failedIds[fi]) < at(id)) withFailed.push(failedIds[fi++]);
  withFailed.push(id);
}
while (fi < failedIds.length) withFailed.push(failedIds[fi++]);

const order = [...withFailed, ...tailLeftover];
```

保留其后的两行不动：

```ts
const next = { ...slice, byId, order };
return sliceContentEqual(slice, next) ? slice : next;
```

- [ ] **Step 2: 删除变为死代码的 `mergeByTimeAscending`**

新排序不再用 `mergeByTimeAscending`。先确认无其它引用：`grep -rn "mergeByTimeAscending" frontends`（应只剩其定义处）。然后删除其函数定义（chatStore.ts，约 139-157：含 `// 把两条均按 sentAt 升序...` 注释 + `function mergeByTimeAscending(...) { ... }` 整块）。若 grep 显示仍有别处引用，**不要删**，改为 DONE_WITH_CONCERNS 报告。

- [ ] **Step 3: 运行两条红测转绿**

Run（cwd=仓库根目录）: `pnpm vitest run chatStore --reporter=verbose 2>&1 | grep -E "两次重读|反例护栏|passed|failed"`
Expected: 两条新测 PASS。

- [ ] **Step 4: 全量 chatStore 测试不破**

Run: `pnpm vitest run chatStore`
Expected: 全绿（既有 25 条排序/收敛/短路断言 + 2 新测 全部 PASS）。**若任何既有测变红，停下报 BLOCKED 并贴红测名 + 实际/期望**，不要硬改测试。

- [ ] **Step 5: 类型 + lint**

Run: `pnpm tsc --noEmit` 与 `pnpm eslint frontends/components/workbench/messages/store/chatStore.ts`
Expected: 无新增错误（尤其删除 mergeByTimeAscending 后无「未使用」残留、无类型错误）。已核 `package.json`：`test`=`vitest run`、`lint`=`eslint .`，无独立 typecheck 脚本 → 类型用 `pnpm tsc --noEmit`、lint 用 `pnpm eslint <文件>`（均直接跑 devDep 二进制）。

- [ ] **Step 6: 提交**

```bash
git add frontends/components/workbench/messages/store/chatStore.ts frontends/components/workbench/messages/store/chatStore.test.ts
git commit -m "fix(messages): replaceAuthoritative 失败气泡按 sentAt 归位(带锚点稳定插入,治沉底/卡底)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**只显式 `git add` 这两个文件，绝禁 `git add -A`/`git add .`**（分支有并发前端 WIP）。

---

## 验收（Plan C 完成判定）

- [ ] `pnpm vitest run chatStore` 全绿（25 既有 + 2 新）。
- [ ] `pnpm tsc --noEmit` 无错；eslint 无新增告警；无 `mergeByTimeAscending` 死代码残留。
- [ ] 两个提交只动 chatStore.ts + chatStore.test.ts，无误带 WIP。

## 不在本计划

- 后端持久化（Plan A，已完成）。
- 前端 IPC 接线 / failBubble / attachments 映射 / never-uploaded 重发拦截（Plan B，待写）。
