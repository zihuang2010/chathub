# 多端登录 force_close 终端粒度化 —— 后台契约对齐单

> 对接方:wecom-aggregate gateway(业务后台)
> 提出方:ChatHub relay / 客户端
> 日期:2026-06-08
> 一句话目的:让排他登录(EXCLUSIVE_LOGIN)**只踢旧设备、保留刚登录的新设备**,不再误踢新端。

---

## 1. 现象与根因

排他登录时,业务后台下发 `CONNECTION_FORCE_CLOSE`,本意是踢掉旧设备。但 relay 当前按 **employeeId 维度**把该事件扇出给该员工的**所有**在线连接(含刚登录的新设备),并在 grace 后摘掉该员工的**全部**流 → **新登录的设备也被一起踢下线**。

要做到"终端粒度"(只踢被踢端、留保留端),relay 必须能从 force_close 事件里**无歧义识别出"哪台保留、哪台踢"**,并能把它对应到具体的在线连接。这依赖后台下发的字段语义,故有此对齐单。

---

## 2. 当前 force_close 样本观测(来源:`docs/2026-06-02-工具网关notify-push请求模板.md`)

| reasonCode           | previousTerminalId | terminalId                        | closeScope |
| -------------------- | ------------------ | --------------------------------- | ---------- |
| EXCLUSIVE_LOGIN      | `""`(空)           | `"test_local_001"`                | `EMPLOYEE` |
| EMPLOYEE_DISABLED    | `""`(空)           | `"codex-doc-force-employee-..."`  | `EMPLOYEE` |
| CONFIG_DISABLED      | `""`(空)           | `"codex-dev-terminal-config-..."` | `EMPLOYEE` |
| ACCESS_REVOKED       | `""`(空)           | `"codex-doc-force-access-..."`    | `EMPLOYEE` |
| TOKEN_RECHECK_FAILED | `""`(空)           | `"codex-doc-force-token-..."`     | `EMPLOYEE` |

**三个与"终端粒度"冲突、需要后台确认的点:**

1. `previousTerminalId` **全部为空** → relay 无法据此定位"被踢端"。
2. `terminalId` 是后台自定义串(`test_local_001` 等),**不是 relay 在 OAuth 时传给后台的那个 UUID** → relay 无法把它和某条在线连接对应上。
3. `closeScope` **全是 EMPLOYEE** → relay 无法区分"留一个"(排他)和"全员踢"(禁用/撤销/封禁)。

---

## 3. 关键背景:terminalId 是怎么来的(后台已持有)

relay 在 **OAuth 登录**时,用 `UUIDv5("chathub:terminal:" + device_id + ":" + username)` 派生出该终端的 `terminalId`,并通过 `?terminalId=<UUID>` query 传给后台(见 relay `downstream.rs`)。

→ 也就是说:**每次有终端登录,后台都已经收到过它的这个 UUID 形态的 terminalId**。后台只要在 force_close 里回填正确的那个 UUID,relay 就能精确匹配到连接。

---

## 4. 需要确认 / 约定的契约点

> 标 **【阻塞】** 的项目不确认,relay 改造无法落地。

- **Q1【阻塞】** 排他登录(EXCLUSIVE_LOGIN)时,`forceClose.terminalId` 能否填**保留端(刚登录的新终端)**的 terminalId,且就是 OAuth 时 relay 传给后台的那个 **UUID**?(relay 据此豁免保留端、踢掉其余)
- **Q2【阻塞】** "全员踢"类 reason(EMPLOYEE_DISABLED / CONFIG_DISABLED / ACCESS_REVOKED / TOKEN_RECHECK_FAILED)能否把 `forceClose.terminalId` **留空**,表示"无保留端、全员踢"?
  - 说明:若这些 reason 也带非空 terminalId,relay 会误以为"要保留这一台",导致被禁用/被撤销的账号在某台设备**漏踢仍在线(安全事故)**。
- **Q3(可选,二选一)** 是否能改用 `closeScope` 区分:终端粒度踢 → `TERMINAL`,整账号踢 → `EMPLOYEE`?这比"靠 terminalId 空不空"更显式。Q2 与 Q3 满足其一即可。
- **Q4【阻塞】** verify_token 语义:排他登录后,
  - **被踢端的旧 token** 再来鉴权,是否返回 `allowed=false`?(否则被踢端会"踢下线又自动重连回来",死循环)
  - **保留端的 token** 是否**仍**返回 `allowed=true`?(relay 会失效该员工鉴权缓存,保留端下次鉴权会回源 verify_token,被误判则保留端被误杀)
- **Q5** 同一台设备、同一账号 **重新登录**(relogin),后台是否**不**下发 EXCLUSIVE_LOGIN?
  - 说明:同设备同账号的 terminalId 是恒定的,会与新连接"撞车",relay 难以区分新旧;若后台对同设备重登也发排他踢线,需另行讨论。

---

## 5. 推荐契约(若全部同意,relay 逻辑最简、最安全)

1. **EXCLUSIVE_LOGIN**:`terminalId` = 保留端 UUID(= OAuth 时 relay 传的那个);`previousTerminalId` 可选填被踢端,**relay 不依赖它**。
2. **全员踢类 reason**:`terminalId` **留空**。
3. **relay 行为约定**:`terminalId` 非空且能匹配到在线连接 → 豁免该连接、踢其余;`terminalId` 为空 / 匹配不到 → **全员踢**。
4. **安全默认**:任何无法判定"是否有保留端"的情况,relay 一律**全员踋**(宁可错踢、不可漏踢)。
5. **verify_token 按终端判定**:被踢端 token 拒、保留端 token 放行。

> 上述契约确认后,relay 侧改造见配套文档:`docs/2026-06-08-多端登录force_close终端粒度-方案B实施计划.md`。

---

## 6. 后台答复(2026-06-08,已确认,全部 OK)

- **Q1 ✓** EXCLUSIVE_LOGIN:`forceClose.terminalId` 填**保留端**(刚登录的新终端),与 OAuth 时 relay 传给后台的 UUID 一致。
- **Q2 ✓** 全员踢(EMPLOYEE_DISABLED / CONFIG_DISABLED / ACCESS_REVOKED / TOKEN_RECHECK_FAILED):`forceClose.terminalId` **留空**,表示无保留端、全员踢。
- **Q3 ✓(推荐)** 终端粒度踢用 `closeScope=TERMINAL`、整账号踢用 `closeScope=EMPLOYEE`;**若本期不放 closeScope,则按 Q2 的 terminalId 留空规则执行**。
- **Q4 ✓** 排他登录后:被踢端旧 token 鉴权返回 `allowed=false`;保留端新 token 鉴权继续 `allowed=true`。
- **Q5 ✓** 同设备同账号 relogin 后台**不下发** EXCLUSIVE_LOGIN;同 terminalId 重登只做 token 替换/清旧 token,不走 relay 排他踢线。

**→ B1 阻塞解除。** relay 判定规则(防御性双条件,容过渡期):
`reasonCode == "EXCLUSIVE_LOGIN"`(或 `closeScope == "TERMINAL"`)**且** `terminalId` 非空 → 豁免保留端、踢其余;**否则全员踢**(已知全员踢 reason / terminalId 空 / closeScope=EMPLOYEE 且非排他 / 任何不确定)。
注意:现网 EXCLUSIVE_LOGIN 仍是 `closeScope=EMPLOYEE`+`terminalId` 非空,故**不能**简单按 `closeScope==EMPLOYEE` 全踢。
