import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * 列表行 / 详情面板共用的客户头像组件。优先渲染 `public/avatars/` 下的真人头像
 * （5 张轮转 + 客户 id 决定性 seed），加载失败 fallback 到 letter-tile。
 *
 * `online` 控制右下角小绿点；`size` 决定整体尺寸（默认 32px，详情面板用 48px）。
 */
interface CustomerAvatarProps {
  customerId: string;
  name: string;
  /** wb-avatar-1..8 配色 token，fallback letter-tile 时使用。 */
  colorToken?: number;
  /** 头像直径（像素）；点尺寸按比例缩放。 */
  size?: number;
  online?: boolean;
}

export function CustomerAvatar({
  customerId,
  name,
  colorToken,
  size = 32,
  online,
}: CustomerAvatarProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const photoUrl = pickPhotoUrl(customerId);
  const dotSize = Math.max(8, Math.round(size * 0.28));

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {photoUrl && !imgFailed ? (
        <img
          src={photoUrl}
          alt=""
          loading="lazy"
          onError={() => setImgFailed(true)}
          className="block size-full rounded-xl object-cover"
          style={{ width: size, height: size }}
        />
      ) : (
        <div
          className={cn(
            "grid size-full place-items-center rounded-xl font-medium text-workbench-text",
            "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.45)]",
          )}
          style={{
            background: `hsl(var(--wb-avatar-${colorToken ?? 1}))`,
            fontSize: Math.round(size * 0.42),
          }}
        >
          {name.slice(0, 1)}
        </div>
      )}
      {online && (
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 rounded-full bg-emerald-500 ring-2 ring-workbench-surface"
          style={{ width: dotSize, height: dotSize }}
        />
      )}
    </div>
  );
}

/**
 * 从 customerId 抽取末尾数字，对 5 取模，映射到 a01.png..a05.png。
 * id 解析失败时返回 null（调用方走 letter-tile 分支）。
 */
function pickPhotoUrl(customerId: string): string | null {
  const match = /(\d+)\s*$/.exec(customerId);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const index = (n % 5) + 1; // 1..5
  return `/avatars/a0${index}.png`;
}
