/**
 * 标签彩色 chip 调色盘。按 tag 字符串做稳定哈希取模，保证同名 tag 永远落到同色，
 * 视觉上像可靠的"分类色"，又不需要为运行时新增的标签维护映射表。
 * 选取的色调避开高饱和荧光，偏 50/700 组合 + 200/60 ring，保证白底卡片上对比度足够
 * 同时不与状态 badge / 选中蓝抢戏。共用于列表行与详情面板的「标签」卡。
 */
const TAG_PALETTE = [
  "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200/60",
  "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200/60",
  "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200/60",
  "bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200/60",
  "bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200/60",
  "bg-teal-50 text-teal-700 ring-1 ring-inset ring-teal-200/60",
  "bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-200/60",
  "bg-fuchsia-50 text-fuchsia-700 ring-1 ring-inset ring-fuchsia-200/60",
] as const;

export function tagColorClass(tag: string): string {
  let hash = 2166136261;
  for (let i = 0; i < tag.length; i += 1) {
    hash ^= tag.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return TAG_PALETTE[Math.abs(hash) % TAG_PALETTE.length];
}
