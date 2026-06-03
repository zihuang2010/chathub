import { Pin } from "lucide-react";

import { STRINGS } from "./strings";
import { pickAvatarColor, resolveAvatarImageUrl } from "./utils";

// Customers render as illustrated portraits sourced from public/avatars/.
// We keep the legacy `avatarColor` (or hashed palette token) as the underlying
// background fill so a missing or slow-loading image degrades to a soft tint
// rather than a blank white square.
function resolveAvatarColor(seed: string, color?: string): string {
  return color && color.length > 0 ? color : pickAvatarColor(seed);
}

interface CustomerAvatarProps {
  name: string;
  color?: string;
  /** 真实头像 URL(企微外部联系人)。空/非法时回退到按 name hash 的占位插画图。 */
  avatarUrl?: string;
  size: "header" | "sm";
}

export function CustomerAvatar({ name, color, avatarUrl, size }: CustomerAvatarProps) {
  // 气泡内(sm)头像收小到 36px,让每条消息更紧凑;聊天头部(header)保持 44px 不变。
  const sizeClass = size === "header" ? "size-11" : "size-9";
  return (
    <div
      role="img"
      aria-label={name}
      className={`${sizeClass} shrink-0 rounded-lg bg-cover bg-center shadow-[inset_0_0_0_1px_rgba(255,255,255,0.48)]`}
      style={{
        backgroundColor: resolveAvatarColor(name, color),
        backgroundImage: `url("${resolveAvatarImageUrl(name, avatarUrl)}")`,
      }}
    />
  );
}

export function AgentAvatar({ account }: { account: string }) {
  // 归属账号在数据模型里没有真实头像(Account 无头像 URL 字段),故出向气泡头像统一回退到
  // 首字色块:账号名首字 + 按账号名 hash 的 wb-avatar 配色,与账号下拉(AccountDropdown)、
  // 客户头像 fallback 同一套 letter-tile 视觉。之前用 pickCustomerAvatarImage 取插画图会
  // 显示一张与账号无关的人像。后续接入企微员工真实头像后,只需在此叠加 <img> 优先渲染。
  const initial = account.trim().slice(0, 1) || "?";
  return (
    <div
      role="img"
      aria-label={account}
      className="grid size-9 shrink-0 place-items-center rounded-lg text-[15px] font-medium text-workbench-text shadow-[inset_0_0_0_1px_rgba(255,255,255,0.48)]"
      style={{ background: pickAvatarColor(account) }}
    >
      {initial}
    </div>
  );
}

interface ConversationAvatarProps {
  name: string;
  color?: string;
  /** 真实头像 URL(企微外部联系人)。空/非法时回退到按 name hash 的占位插画图。 */
  avatarUrl?: string;
  online: boolean;
  /** 置顶时在头像左上角叠加一个小尺寸 pin 徽标。 */
  pinned?: boolean;
}

export function ConversationAvatar({
  name,
  color,
  avatarUrl,
  online,
  pinned,
}: ConversationAvatarProps) {
  return (
    <div className="relative shrink-0">
      <div
        role="img"
        aria-label={name}
        className="size-11 rounded-lg bg-cover bg-center shadow-[inset_0_0_0_1px_rgba(255,255,255,0.45)]"
        style={{
          backgroundColor: resolveAvatarColor(name, color),
          backgroundImage: `url("${resolveAvatarImageUrl(name, avatarUrl)}")`,
        }}
      />
      {pinned && (
        <span
          aria-label={STRINGS.conversationList.contextUnpin}
          className="pointer-events-none absolute -left-0.5 -top-0.5 grid size-3.5 place-items-center rounded-full bg-workbench-accent shadow-[0_0_0_1.5px_white]"
        >
          <Pin size={8} className="-rotate-45 text-white" strokeWidth={2.5} />
        </span>
      )}
      {online && (
        <span
          aria-hidden
          className="absolute bottom-0 right-0 size-2.5 rounded-full border-2 border-workbench-line-strong bg-workbench-online"
        />
      )}
    </div>
  );
}
