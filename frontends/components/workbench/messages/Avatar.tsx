import { useState, type ReactNode } from "react";
import { Pin } from "lucide-react";

import { secureImageUrl } from "@/lib/secureImageUrl";

import { STRINGS } from "./strings";
import { cssUrlSafe, pickAvatarGradient } from "./utils";

// letter-tile 底色:显式 `color`(可为任意 CSS background,含渐变)优先,否则按
// name hash 取稳定的饱和渐变。文字恒为白色,调用方传入浅色实底会损失对比度。
function resolveAvatarBackground(seed: string, color?: string): string {
  return color && color.length > 0 ? color : pickAvatarGradient(seed);
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
  // 渲染前把头像 http:// 升级为 https://，避免 macOS 正式包 secure context 的混合内容拦截。
  // 失败态仍按原始 avatarUrl 记录（与 onError 一致），不受 scheme 升级影响。
  const safe = failedUrl !== avatarUrl ? cssUrlSafe(secureImageUrl(avatarUrl), "image") : null;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {safe ? (
        <img
          src={safe}
          alt={name}
          loading="lazy"
          onError={() => setFailedUrl(avatarUrl ?? null)}
          className="block size-full rounded-lg bg-center object-cover ring-1 ring-black/5"
        />
      ) : (
        // letter-tile:饱和渐变底 + 白色首字,顶部一道细微高光(inset shadow)增加体积感。
        <div
          role="img"
          aria-label={name}
          className="grid size-full place-items-center rounded-lg font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28)]"
          style={{
            background: resolveAvatarBackground(name, color),
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
  /** 叠加在头像上的 overlay(如微信来源角标),透传给 AvatarTile。 */
  children?: ReactNode;
}

export function CustomerAvatar({ name, color, avatarUrl, size, children }: CustomerAvatarProps) {
  // 气泡内(sm)头像收小到 36px,让每条消息更紧凑;聊天头部(header)保持 44px 不变。
  return (
    <AvatarTile name={name} color={color} avatarUrl={avatarUrl} size={size === "header" ? 44 : 36}>
      {children}
    </AvatarTile>
  );
}

/** 客户来源角标:微信小图标贴头像左下角。会话列表行与聊天头部共用,保证两处
 *  「客户从微信来」的标识视觉一致;归属企微账号的标识由各自的 logo+名字承担。 */
export function WeChatSourceBadge() {
  return (
    <span
      aria-label={STRINGS.header.fromWeChat}
      title={STRINGS.header.fromWeChat}
      className="absolute -bottom-1 -left-1 grid size-4 place-items-center rounded-full border border-workbench-line-strong bg-workbench-surface-elevated shadow-[0_1px_4px_rgba(15,23,42,0.16)]"
    >
      <svg aria-hidden viewBox="0 0 16 16" className="size-3 text-[#21A65B]" fill="none">
        <path
          d="M7.1 3.2C4.3 3.2 2 4.9 2 7c0 1.2.7 2.2 1.8 2.9l-.4 1.3 1.5-.7c.7.2 1.4.3 2.2.3 2.8 0 5.1-1.7 5.1-3.8S9.9 3.2 7.1 3.2Z"
          fill="currentColor"
          opacity="0.95"
        />
        <path
          d="M10.5 6.3c2.1 0 3.7 1.3 3.7 2.9 0 .9-.5 1.7-1.4 2.2l.3 1-1.1-.5c-.5.2-1 .2-1.6.2-2.1 0-3.7-1.3-3.7-2.9s1.7-2.9 3.8-2.9Z"
          fill="currentColor"
          opacity="0.55"
        />
        <circle cx="5.5" cy="6.6" r="0.45" fill="hsl(var(--wb-wechat-bg))" />
        <circle cx="8.4" cy="6.6" r="0.45" fill="hsl(var(--wb-wechat-bg))" />
      </svg>
    </span>
  );
}

export function AgentAvatar({ account, badge }: { account: string; badge?: ReactNode }) {
  // 归属账号在数据模型里没有真实头像(Account 无头像 URL 字段),故出向气泡头像统一回退到
  // 首字色块:账号名首字 + 按账号名 hash 的饱和渐变,与客户头像 fallback(AvatarTile)
  // 同一套 letter-tile 视觉。后续接入企微员工真实头像后,改用 AvatarTile 传 avatarUrl 即可。
  const initial = account.trim().slice(0, 1) || "?";
  const tile = (
    <div
      role="img"
      aria-label={account}
      className="grid size-9 shrink-0 place-items-center rounded-lg text-[15px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28)]"
      style={{ background: pickAvatarGradient(account) }}
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
