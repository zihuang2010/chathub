import { Pin } from "lucide-react";

import { STRINGS } from "./strings";
import { pickAvatarColor, pickCustomerAvatarImage, resolveAvatarImageUrl } from "./utils";

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
  // 用与 CustomerAvatar 同一套 illustrated 头像素材,以 account 名 hash 取色与图,
  // 避免之前文字缩写在出消息气泡边上像一个"账号 chip"而非"员工形象"的别扭感。
  // 后续接入企微员工真实头像后只需要换数据源,DOM 结构不变。
  return (
    <div
      role="img"
      aria-label={account}
      className="size-9 shrink-0 rounded-lg bg-cover bg-center shadow-[inset_0_0_0_1px_rgba(255,255,255,0.48)]"
      style={{
        backgroundColor: pickAvatarColor(account),
        backgroundImage: `url(${pickCustomerAvatarImage(account)})`,
      }}
    />
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
