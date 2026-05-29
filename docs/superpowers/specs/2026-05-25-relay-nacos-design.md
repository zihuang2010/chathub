# relay 对接 Nacos 服务注册与发现 — 设计

日期:2026-05-25
范围:`backends/crates/chathub-relay`

## 目标

relay 服务对接 Nacos 的**服务注册**与**服务发现**:

1. **发现**:下游业务后台的地址不再由固定 `RELAY_DOWNSTREAM_URL` 写死,而是通过 Nacos 服务发现解析得到。
2. **注册**:relay 把自身的 push HTTP 端点(业务后台回调 notify/push 用)注册进 Nacos。

## 已确认的关键决策

| 决策点     | 选择                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| 发现粒度   | **单一逻辑下游**:一个 Nacos 服务名解析出 base_url,所有路径照旧拼接(登录/业务路径共用同一 base_url,与现状一致) |
| 客户端     | 社区 **`nacos-sdk`** crate(0.8,基于 gRPC 的 Nacos 2.x 协议)                                                   |
| 不可达兜底 | **回退静态 `RELAY_DOWNSTREAM_URL`**;且为每请求决策 → Nacos 恢复后自动切回发现结果                             |
| 注册端点   | **只注册 push HTTP 端点**(50052)                                                                              |
| 负载均衡   | 加权随机(SDK 默认 `select_one_healthy_instance`)                                                              |
| 停机注销   | **主动 deregister**,先于 SERVER_DRAIN 广播                                                                    |

## 架构

三处改动,互相解耦:

- **新增 `src/nacos.rs`** — 封装 `nacos-sdk` 的 `NamingService`:
  - `NacosClient::connect(cfg)`:构建并连接(失败返回 `Err`,由 main best-effort 降级)。
  - `register_push()` / `deregister_push()`:注册/注销 relay 的 push 端点(ephemeral 实例,连接断开自动摘除作兜底)。失败仅 warn。
  - `discover_base_url() -> Option<String>`:`select_one_healthy_instance` → `scheme://ip:port`;无实例/出错返 `None`(热路径 miss 用 debug 级日志,避免刷屏)。

- **改造 `src/downstream.rs`** — `DownstreamClient` 的 `base_url: String` 换成 `source: BaseUrlSource`:

  ```rust
  pub enum BaseUrlSource {
      Static(Arc<str>),                                  // 现状 / 兜底
      Nacos { client: Arc<NacosClient>, fallback: Arc<str> },
  }
  ```

  `base_url()` 异步返回当前应使用地址(Nacos 失败回退 fallback,故不会失败)。各下游方法(login/logout/verify_token/notify_pull/forward)开头取一次 `base`,其余 reqwest/envelope/超时逻辑完全不动。
  `new(base_url, ...)` 签名**保留**(内部包成 `Static`),现有 wiremock 测试零改动;新增 `new_with_source(...)`。

- **`src/main.rs` 接线** — 启动时若 `nacos.enabled`:连接 → `register_push()` → source = `Nacos{fallback: downstream_url}`;连接失败 → warn + `Static`。停机信号 task 内先 `deregister_push()` 再广播 SERVER_DRAIN。

## 配置(env 驱动,默认关闭)

`RELAY_NACOS_ENABLED`(默认 `false`)为总开关,false 时零行为变化。启用后:

- 连接:`RELAY_NACOS_SERVER_ADDR`(必填)、`_NAMESPACE`、`_GROUP`(默认 `DEFAULT_GROUP`)、`_USERNAME`/`_PASSWORD`(+`_FILE`,可选鉴权)。
- 发现:`RELAY_NACOS_DISCOVERY_SERVICE`(必填)、`_DISCOVERY_SCHEME`(默认 https;http 受 `RELAY_ALLOW_HTTP` gate 约束)、`RELAY_DOWNSTREAM_URL`(保留必填,兜底)。
- 注册:`RELAY_NACOS_REGISTER_SERVICE`(默认 `chathub-relay`)、`_REGISTER_IP`(默认取 push_addr IP;通配地址时必填)、`_REGISTER_PORT`(默认 push 端口)、`_REGISTER_WEIGHT`(默认 1.0)、`_REGISTER_METADATA`(`k=v,k2=v2`)。

`validate()` 仅在 enabled 时强校验上述必填项与 scheme;`dump_redacted` 脱敏 Nacos 密码。

## 错误处理与安全

- Nacos **全程 best-effort**:连接/注册/发现任何失败都不阻断 relay 主流程,降级到静态 URL。
- 发现的 http scheme 与静态 URL 一样受 `RELAY_ALLOW_HTTP` 约束,防客户端 Bearer token 明文上行。

## 测试

- `config.rs`:Nacos 默认关闭、enabled 必填项校验、register_ip 通配校验、scheme(http 需 ALLOW_HTTP / 非法值拒绝)、metadata 解析、密码 `_FILE` 兜底、dump 脱敏。
- `downstream.rs`:`BaseUrlSource::Static` 的 base_url/representative_url 去尾斜杠;现有 wiremock 测试不变。
- 真实注册/发现属集成测试,需真 Nacos,文档说明手动跑(不进 CI)。

## 依赖

workspace 加 `nacos-sdk = { version = "0.8", default-features = false, features = ["naming", "auth-by-http"] }`。
注:nacos-sdk 内部用 tonic/prost 0.14,与本仓 0.12/0.13 并存(互不传递类型,Cargo 多版本共存,编译更重但无冲突)。
