import type { Customer } from "@/lib/types/customer";

/**
 * 「重点客户」单一来源：tag 列表。与 stageBadge.ts 的 PROMOTED_TAGS 保持一致，
 * 避免漂移；如果产品要新增第三种"等同重点"的标签，加在这里即可。
 */
export const KEY_CUSTOMER_TAGS = ["重点客户", "VIP"] as const;

/**
 * 是否为「重点客户」。条件 OR：
 * 1) tags 命中 KEY_CUSTOMER_TAGS 任一
 * 2) 或 level === "A"
 */
export function isKeyCustomer(c: Pick<Customer, "tags" | "level">): boolean {
  if (c.level === "A") return true;
  for (const tag of KEY_CUSTOMER_TAGS) {
    if (c.tags.includes(tag)) return true;
  }
  return false;
}
