import { useState, type ReactNode } from "react";
import { Pin } from "lucide-react";

import { cn } from "@/lib/utils";

import { STRINGS } from "./strings";
import { cssUrlSafe, pickAvatarColor } from "./utils";

// letter-tile 底色:显式 `color` 优先,否则按 name hash 取稳定底色。
function resolveAvatarColor(seed: string, color?: string): string {
  return color && color.length > 0 ? color : pickAvatarColor(seed);
}

// 名字首字(按码点切分,兼容中文/emoji);空名兜底「?」。
function firstChar(name: string): string {
  return Array.from(name.trim())[0] ?? "?";
}

// 全局统一头像规则:有真实头像 URL(企微 externalAvatar)就显示图片,缺失/非法/加载失败
// 时回退到「名字首字 + 底色」letter-tile。`size` 为像素直径,字号按 0.42 比例缩放;
// overlay(在线点 / pin 角标)由 children 叠加。CustomerAvatar / ConversationAvatar /
// CustomerDetails.ProfileHeader 共用,把规则收在一处。
export function AvatarTile({
  name,
  color,
  avatarUrl,
  size,
  children,
}: {
  name: string;
  color?: string;
  avatarUrl?: string;
  size: number;
  children?: ReactNode;
}) {
  // 失败态按「具体哪个 URL 失败」记录,而非布尔。AvatarTile 在头部(ChatHeader 单实例,
  // 切会话只改 props 不重挂)与虚拟化列表(行回收复用实例)里都会被同一实例承载多个 avatarUrl,
  // 若用 useState(false) 记失败,任一头像加载失败一次就会永久粘住、把后续有效头像也打回首字母。
  // 记 failedUrl 后,avatarUrl 一变旧失败记录自动失效,复用实例随之恢复 —— 无 effect、无额外重渲。
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const safe = failedUrl !== avatarUrl ? cssUrlSafe(avatarUrl, "image") : null;
  const boxClass = "rounded-lg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.48)]";
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {safe ? (
        <img
          src={safe}
          alt={name}
          loading="lazy"
          onError={() => setFailedUrl(avatarUrl ?? null)}
          className={cn(boxClass, "block size-full bg-center object-cover")}
        />
      ) : (
        <div
          role="img"
          aria-label={name}
          className={cn(
            boxClass,
            "grid size-full place-items-center font-medium text-workbench-text",
          )}
          style={{
            backgroundColor: resolveAvatarColor(name, color),
            fontSize: Math.round(size * 0.42),
          }}
        >
          {firstChar(name)}
        </div>
      )}
      {children}
    </div>
  );
}

interface CustomerAvatarProps {
  name: string;
  color?: string;
  /** 真实头像 URL(企微 externalAvatar);空/非法/加载失败时回退名字首字色块。 */
  avatarUrl?: string;
  size: "header" | "sm";
}

export function CustomerAvatar({ name, color, avatarUrl, size }: CustomerAvatarProps) {
  // 气泡内(sm)头像收小到 36px,让每条消息更紧凑;聊天头部(header)保持 44px 不变。
  return (
    <AvatarTile
      name={name}
      color={color}
      avatarUrl={avatarUrl}
      size={size === "header" ? 44 : 36}
    />
  );
}

export function AgentAvatar({ account, badge }: { account: string; badge?: ReactNode }) {
  // 归属账号在数据模型里没有真实头像(Account 无头像 URL 字段),故出向气泡头像统一回退到
  // 首字色块:账号名首字 + 按账号名 hash 的 wb-avatar 配色,与账号下拉(AccountDropdown)、
  // 客户头像 fallback(AvatarTile)同一套 letter-tile 视觉。后续接入企微员工真实头像后,
  // 改用 AvatarTile 传 avatarUrl 即可。
  const initial = account.trim().slice(0, 1) || "?";
  const tile = (
    <div
      role="img"
      aria-label={account}
      className="grid size-9 shrink-0 place-items-center rounded-lg text-[15px] font-medium text-workbench-text shadow-[inset_0_0_0_1px_rgba(255,255,255,0.48)]"
      style={{ background: pickAvatarColor(account) }}
    >
      {initial}
    </div>
  );
  // 多端同步消息:在头像右下角叠加来源角标(badge 由调用方传入,logo 资源引用集中在 MessageBubble)。
  if (!badge) return tile;
  return (
    <div className="relative shrink-0">
      {tile}
      {badge}
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
    <AvatarTile name={name} color={color} avatarUrl={avatarUrl} size={44}>
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
    </AvatarTile>
  );
}
