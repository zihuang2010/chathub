import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * 列表行 / 详情面板共用的客户头像组件。优先渲染真实远程头像（生产取自 external_avatar），
 * 缺失或加载失败时 fallback 到首字母色块（letter-tile）。
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
  /** 真实远程头像 URL（生产取自 external_avatar）；无则回退首字母色块。 */
  photoUrl?: string;
}

export function CustomerAvatar({
  name,
  colorToken,
  size = 32,
  online,
  photoUrl,
}: CustomerAvatarProps) {
  const [imgFailed, setImgFailed] = useState(false);
  // 头像直连原始 https URL(企微头像域不在 cachedimg SSRF 白名单,走代理会被拒)。
  // 列表已虚拟化,仅可见行解码,不走降采样也不致内存膨胀。无则走首字母色块。
  const src = photoUrl || undefined;
  const dotSize = Math.max(8, Math.round(size * 0.28));

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {src && !imgFailed ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setImgFailed(true)}
          className="block size-full rounded-lg object-cover"
          style={{ width: size, height: size }}
        />
      ) : (
        <div
          className={cn(
            "grid size-full place-items-center rounded-lg font-medium text-workbench-text",
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
