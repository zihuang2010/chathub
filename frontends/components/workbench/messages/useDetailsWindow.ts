import { useCallback, useState } from "react";

interface UseDetailsWindowResult {
  detailsOpen: boolean;
  toggleDetails: () => void;
}

/**
 * 客户详情面板的开关状态(方案 A)。面板作为三栏布局里的「右栏」就地展开/收起,
 * 由聊天区(flex-1)自动收窄让出空间;窗口尺寸与位置、以及会话列表(接待区)宽度
 * 都保持不动。窗口装不下时(聊天区已到最小宽 CHAT_AREA_MIN_WIDTH)右栏从右缘
 * 裁切,而不是撑宽或移动窗口。
 */
export function useDetailsWindow(): UseDetailsWindowResult {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const toggleDetails = useCallback(() => setDetailsOpen((open) => !open), []);
  return { detailsOpen, toggleDetails };
}
