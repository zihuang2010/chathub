# 多端登录 force_close 终端粒度化 —— 方案 B 实施计划(架构 II)

> 日期:2026-06-08
> **前置依赖:** 后台契约**已确认**(2026-06-08,见对齐文档 §6:Q1/Q2/Q3/Q4/Q5 全 OK)。阻塞解除,可进入编码。
> 架构:**II —— relay 终端粒度定向 force_close;客户端只做 terminalId 管线接入,`detect_force_close` / `run_loop` 零逻辑改。**
> 踢法:**策略 Y —— 豁免保留端 terminalId、踢其余;安全默认全踢。**
> 来源:本计划的关键决策来自 2026-06-08 的 5 代理对抗式验证(见记忆 `project-multi-device-terminal-force-close`)。

---

## 0. 核心设计决策(已对抗验证,不要推翻)

1. **terminalId 由客户端 subscribe 上行携带。** relay 在 subscribe 时拿不到 username(`UserCtx` 无 username、verify_token 不返),无法自算 terminalId;内存缓存方案在"多实例 / relay 重启 / auth cache TTL 淘汰"下全部失效。客户端把 terminalId 当**不透明串**,不复制 `terminal_id_for` 公式(避免双份派生规则漂移)。
2. **force_close 定向投递,客户端零逻辑改。** relay 只把 force_close 事件发给"非保留端"→ 保留端**收不到事件 → 什么都不做**(连接照常);被踢端收到 → 走现有 `mark_kicked` + `return` 自行关流。新增 force_close **专用**的选择性投递,**不动正常推送的 fanout 热路径**。
3. **安全默认全踢(防御性双条件)。** 豁免保留端,当且仅当 `reasonCode == "EXCLUSIVE_LOGIN"`(或 `closeScope == "TERMINAL"`)**且** `terminalId` 非空;已知全员踢 reason、`terminalId` 为空、`closeScope==EMPLOYEE` 且非排他、或任何不确定 → 一律全踢。(后台已确认 Q1/Q2/Q3:排他填保留端 terminalId、全员踢留空、closeScope 可选 TERMINAL/EMPLOYEE;**过渡期现网排他仍是 EMPLOYEE+非空,故不能只看 closeScope**)
4. **"豁免 vs 踢"最终唯一键用 `connection_id`,terminalId 仅用于圈定集合**(防同设备 relogin 时 terminalId 撞车踢错)。
5. **真正关流靠客户端收事件自登出;relay 的 drop 只停 fanout、不关 socket**(`router.rs` 注释正确,`push.rs:302` 注释需改正)。架构 II 下被踢端会自登出,无僵尸。

---

## 1. 改动清单(分层,每层标 目标 / 风险 / 验证)

### 1.1 proto —— SubscribeRequest 带 terminalId

- 动作:`proto/chathub/v1/hub.proto` 的 `SubscribeRequest` 加 `string terminal_id = 4;`(注释:客户端登录后拿到、持久化、每次 subscribe 回带,relay 据此做终端粒度路由)。
- 目标:让 relay 在注册连接时即知道该连接的 terminalId。
- 风险:prost 生成的 struct 无 `..Default`,**13 处结构体字面量构造点全部编译失败**(机械补字段):`relay_e2e.rs` 9 处、`hub_service.rs` 2 处、`bin/test_subscribe.rs` 1 处、`net/src/hub.rs:396` 1 处。
- 验证:`cargo build -p chathub-proto` 通过;全 workspace 编译。

### 1.2 relay 登录回传 terminalId

- 动作:
  - `downstream.rs::login`:terminalId 已在 `downstream.rs:492` 算出,塞进 `LoginResp`(加字段)。
  - `auth_service.rs::login`:透传进 `LoginResponse`(放 `UserProfile.terminal_id` 或 LoginResponse 顶层;若放 UserProfile 则 `common.proto` 加字段)。
  - (可选)`auth_service.rs` 的 cache `prepopulate` 顺手不必改。
- 目标:客户端能在登录响应里拿到自己的 terminalId。
- 风险:LOW(纯追加字段,proto3 向后兼容)。
- 验证:relay 单测 + 客户端登录后能读到非空 terminalId。

### 1.3 客户端持久化 + subscribe 上行

- 动作:
  - 客户端登录拿到 terminalId → 持久化(建议存 `hub_current_session` 表,见 `chathub-net/src/session.rs`;或 `local_token`)。
  - `ConnectionManager::new` / `Inner` 增加 `terminal_id` 字段(`hub.rs` ~983/1004/1033)。
  - `hub.rs` 的 `subscribe()`(~389)与调用点(~1109)把 terminal_id 填进 `SubscribeRequest`。
- 目标:每次(含重连)subscribe 都带 terminalId,跨 relay 重启/多实例稳定。
- 风险:LOW-MEDIUM(跨 4 处签名/字段串接);**`detect_force_close` / `run_loop` 不改**。
- 验证:客户端单测;抓 relay 日志确认 subscribe 收到非空 terminal_id。

### 1.4 relay 注册表带 terminalId

- 动作:`router.rs` 的 `EmployeeStream`(:32)加 `terminal_id: String`;`register_employee`(:76)签名加参;唯一生产调用点 `hub_service.rs:617` 补传 `terminal_id`(取自 SubscribeRequest)。
- 目标:注册表里每条连接都带 terminalId,供 force_close 匹配。
- 风险:MEDIUM —— `register_employee` 加参致 11 处单测编译失败(router.rs / push.rs,机械补参)。
- 验证:`cargo test -p chathub-relay` 编译通过 + 既有断言不变。

### 1.5 relay 选择性投递 / 摘流(新增,不动热路径)

- 动作:`router.rs` 新增两个方法:
  - `fanout_force_close_except_terminal(emp, survivor_terminal) -> FanoutOutcome`:只投 `terminal_id != survivor_terminal` 的连接(按 connection 迭代)。
  - `drop_streams_except_terminal(emp, survivor_terminal) -> Vec<String>`:grace 后摘"非保留端"(内部按 connection_id 摘,复用 `drop_employee_stream` 语义)。
  - 保留现有 `fanout_employee` / `drop_all_employee_streams` 作"全踢"路径(正常推送热路径完全不变)。
- 目标:把"豁免保留端、踢其余"做成独立路径,爆炸半径锁在 router.rs。
- 风险:LOW(纯新增方法 + 单测)。
- 验证:新增 router 单测(见 §2)。

### 1.6 relay push.rs force_close 分支改造

- 动作:
  - `convert_batch_to_rows`(:370)在识别 `CONNECTION_FORCE_CLOSE` 时,**额外解析** `forceClose.terminalId` 与 `eventReason/reasonCode`(目前只产出 `has_force_close: bool`)。
  - `handle_push`(:298-321)force_close 分支,**判定是否终端粒度豁免(防御性,需同时满足两条)**:
    - **终端粒度**(豁免保留端、踢其余),当且仅当 `reasonCode == "EXCLUSIVE_LOGIN"`(或 `closeScope == "TERMINAL"`)**且** `terminalId` 非空 → 用 §1.5:`fanout_force_close_except_terminal(survivor=terminalId)` 只投非保留端 + grace `drop_streams_except_terminal`。保留端还没 subscribe 上来时,"踢其余"自然等于踢光当前在线(正确,代理4 时序 a),保留端随后连入不受影响。
    - **全员踢**(其余一切):已知全员踢 reason 集合 `{EMPLOYEE_DISABLED, CONFIG_DISABLED, ACCESS_REVOKED, TOKEN_RECHECK_FAILED}`、`terminalId` 为空、`closeScope==EMPLOYEE` 且非排他、或任何无法判定 → `fanout_employee` 全投 + grace `drop_all_employee_streams`。
    - ⚠️ **过渡期**:现网 EXCLUSIVE_LOGIN 样本是 `closeScope=EMPLOYEE`+`terminalId` 非空,故判定以 **reasonCode==EXCLUSIVE_LOGIN(或 closeScope==TERMINAL)+ terminalId 非空** 为准,**绝不能**简单按 `closeScope==EMPLOYEE` 就全踢(否则回到误踢新端的 bug)。
  - `invalidate_employee`(:306)**维持 employee 级**(依赖后台 verify_token 按 terminal 判定 —— 见契约 Q4,代码注释标注)。
  - 改正 `push.rs:302` 误导注释("摘除路由 → stream 自然关闭" → "停止继续 fanout;流由客户端收 force_close 后主动断开回收")。
- 目标:终端粒度只踢旧端、留保留端;不确定时全踢兜底。
- 风险:MEDIUM(force_close 路径逻辑变更);正常推送路径不变。
- 验证:新增 push 单测(见 §2)+ e2e。

### 1.7 客户端 detect_force_close / run_loop

- 动作:**零改**(架构 II)。保留端收不到事件 → `detect_force_close_in` 返回 None → `run_loop` 不触发下线;被踢端收到 → 现有 `mark_kicked` + `return`。
- 目标:满足"客户端几乎不改"。
- 风险:依赖 §1.6 的定向投递正确(保留端确实收不到事件)——由 e2e 守住。
- 验证:`force_close_e2e` 加"保留端不下线"对照用例。

---

## 2. 测试计划

**机械必改(编译性):** `register_employee` 调用 16 处、`SubscribeRequest` 构造 13 处(补字段/补参)。

**新增 router 单测(`router.rs` tests):**

1. 豁免保留端 / 踢其余:emp 两条流(terminalA=保留、terminalB),选择性摘后 A 在、B 摘、fanout 仍投 A。
2. terminalId 空 → 退化全踢(等价 `drop_all`)。
3. N 台旧设备一次踢光:emp 三条流,保留端 1 台,断言摘除其余 2 台。
4. **同设备 relogin / terminalId 撞车(最易错,先写)**:保留端 terminalId == 某旧连接 terminalId 时,按 connection_id 区分,确保不误踢/不漏踢。

**新增 push 单测(`push.rs` tests):** 5. EXCLUSIVE_LOGIN 带保留端 terminalId → grace 后只摘非保留端(保留端连接数=1)。6. EMPLOYEE_DISABLED / terminalId 空 → 维持全踢(连接数=0)。

**新增 e2e:** 7. `relay_e2e.rs`:两条真实 subscribe(不同 terminalId)→ push 一条 EXCLUSIVE_LOGIN force_close → 被踢流关闭、保留流仍收后续实时帧。8. `force_close_e2e.rs`:保留端推不含 force_close 的普通 batch → 客户端保持 Subscribed、token 不清(架构 II 安全性反证)。9. verify_token 契约覆盖:被踢端 token 重连应被拒、保留端放行(当前 mock 放行=零覆盖,需补 mock 分支 + 断言)。

---

## 3. 落地顺序(TDD)

1. **后台契约确认(前置阻塞,Q1/Q2/Q4)。**
2. proto 加字段 → 登录回传 → 客户端持久化+上行(先把 terminalId 打通到 relay 注册表)。
3. router 选择性 fanout/drop + 单测(**relogin 撞车那条最先写**)。
4. push force_close 分支 + 单测。
5. e2e(含 verify_token 契约覆盖)。
6. 全测(`pnpm` 前端无关;`cargo test` in `backends/`,relay 注意 `env -u ALL_PROXY`)+ **真机多端验证**。

---

## 4. 风险与防呆汇总

- **安全默认全踢**:任何"无法判定是否有保留端"的情况一律全踢(宁错踢不漏踢)。
- **connection_id 唯一键**:防同设备 relogin terminalId 撞车。
- **terminalId 客户端上行**:不依赖 relay 内存/缓存(多实例/重启/TTL 安全)。
- **不动正常推送 fanout 热路径**:force_close 走独立选择性方法。
- **后台 verify_token 按 terminal**(Q4):被踢端拒(防"踢了又回来")、保留端放行(防 `invalidate_employee` 牵连误杀)。
- 改正 `push.rs:302` 误导注释。

---

## 5. 影响面(GitNexus 复核)

整体**中等偏小,无 HIGH/CRITICAL**:`register_employee` 加参 MEDIUM(11 上游全是单测);`drop_all_employee_streams` LOW;`EmployeeStream` 加字段 LOW;`SubscribeRequest` proto 加字段 13 处机械改。约 30 处机械改 + ~9 条新增用例。
