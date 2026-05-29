// 账号 API 层 —— 桥接 Tauri `list_accounts` 命令到前端 Account 类型。
//
// 真后端契约返 8 字段(wecomAccountId/wecomName/wecomAccount/wecomAlias/
// wecomAvatar/wecomStatus/gender/position)。前端 Account 富字段
// (city/enterprise/trend7d/...)在 mock 联调阶段用 wecomAccountId 作 seed
// 确定性派生 —— 同一账号每次渲染相同,真后端上线时只需替换 list_accounts() 实现
// + 把派生字段改成真接口字段,UI 不动。

import { invoke } from "@tauri-apps/api/core";

import type { Account, AccountStatus, AvatarColorToken } from "@/lib/types/account";

/** Tauri `list_accounts` 命令的原始返回(对应 SDK ListAccountsItem)。 */
export interface ListAccountsItem {
  wecomAccountId: string;
  wecomName: string;
  wecomAccount: string;
  wecomAlias: string;
  wecomAvatar: string;
  /** 1 = 启用,0 = 停用 */
  wecomStatus: number;
  gender: number;
  position: string;
}

/**
 * 拉取当前员工可管理的企微账号列表。
 *
 * Cache-first(2026-05-17):Tauri 端默认读本地 SQLite 缓存,缓存空 / `force=true` 时
 * 才透传业务后台 listMine。Subscribe 流推 ACCOUNT_* 事件后 Tauri 自动维护 cache,
 * 前端 listen("accounts_changed") 后再 fetchAccounts() 即读到新数据。
 *
 * @param opts.enabled 可选过滤:true=仅启用 / false=仅停用 / 不传=全量。后端按
 *                     wecomStatus(1/0)做过滤。
 * @param opts.force   true 时强制透传 listMine(用户手动刷新按钮)。
 */
export async function fetchAccounts(opts?: {
  enabled?: boolean;
  force?: boolean;
}): Promise<Account[]> {
  const items = await invoke<ListAccountsItem[]>("list_accounts", {
    enabled: opts?.enabled,
    force: opts?.force,
  });
  return items.map(deriveAccount);
}

// ─── 确定性派生(mock 联调期专用)───────────────────────────────────────────

const CITIES = [
  "北京",
  "深圳",
  "成都",
  "广州",
  "杭州",
  "南京",
  "上海",
  "武汉",
  "重庆",
  "西安",
  "福州",
  "厦门",
];
const ENTERPRISES = [
  "北京科技有限公司",
  "深圳创新科技有限公司",
  "成都智联科技有限公司",
  "广州云创科技有限公司",
  "杭州未来科技有限公司",
  "南京数智科技有限公司",
  "上海前沿信息技术有限公司",
  "武汉光谷信息有限公司",
  "重庆智算科技有限公司",
  "西安长安信息有限公司",
  "福州榕城信息有限公司",
  "厦门海丝科技有限公司",
];
const OWNERS = [
  "小美",
  "阿哲",
  "阿玲",
  "阿菲",
  "小贝",
  "小周",
  "小彦",
  "阿陶",
  "小欣",
  "豫哥",
  "阿瑞",
  "未分配",
];

/** 字符串 → 32-bit 稳定 hash;同一 wecomAccountId 每次得到相同种子。 */
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** LCG 序列生成器 —— 由种子推导一串伪随机 [0,1)。和后端 seedTrend 同款思路。 */
function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233_280;
    return s / 233_280;
  };
}

function deriveAccount(item: ListAccountsItem): Account {
  const seed = hashSeed(item.wecomAccountId);
  const rand = lcg(seed);
  const enabled = item.wecomStatus === 1;

  const cityIdx = seed % CITIES.length;
  const ownerIdx = seed % OWNERS.length;
  const colorToken = ((seed % 8) + 1) as AvatarColorToken;

  // 状态:wecomStatus !== 1 直接 offline;其余以 seed 决定 online/abnormal(少量异常)
  const status: AccountStatus = !enabled ? "offline" : rand() < 0.12 ? "abnormal" : "online";

  const customerCount = 100 + Math.floor(rand() * 1200);
  const sessionCount = customerCount + Math.floor(rand() * 1500);

  const trend7d: number[] = [];
  const base = 20 + Math.floor(rand() * 40);
  for (let i = 0; i < 7; i++) {
    trend7d.push(Math.floor(base * 0.4 + rand() * base));
  }

  // 最近活跃: 启用账号 1-120 分钟内;停用账号 2-7 天前
  const minutesAgo = enabled
    ? 1 + Math.floor(rand() * 120)
    : 60 * 24 * (2 + Math.floor(rand() * 5));
  const lastActiveAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();

  // 创建时间:固定基线 2024-01-01,往后均匀展开 ~180 天
  const dayOffset = Math.floor(rand() * 180);
  const created = new Date(
    2024,
    0,
    1 + dayOffset,
    9 + Math.floor(rand() * 9),
    Math.floor(rand() * 60),
  );
  const createdAt = formatDateTime(created);

  return {
    id: item.wecomAccountId,
    name: item.wecomName,
    colorToken,
    wecomAlias: item.wecomAlias,
    position: item.position,
    ownerName: OWNERS[ownerIdx],
    city: CITIES[cityIdx],
    enterprise: ENTERPRISES[cityIdx],
    verified: true,
    status,
    createdAt,
    customerCount,
    sessionCount,
    trend7d,
    lastActiveAt,
  };
}

function formatDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
