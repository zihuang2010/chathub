import type { Account } from "@/lib/types/account";

import { RangePill } from "./RangePill";
import { STRINGS } from "./strings";

interface EmptyChatPaneProps {
  accounts: readonly Account[];
  /** 选中账号的 `account.id`(= wecomAccountId),`null` = 全部。 */
  selectedAccountId: string | null;
  onAccountChange: (accountId: string | null) => void;
}

/**
 * 无选中会话时的聊天区占位:账号筛选入口(RangePill)常驻顶部。
 * 若入口只挂在 ChatArea 内,切到无会话账号后 ChatArea 不渲染、入口随之消失,
 * 用户会被困在空账号下无法切回(白屏死路),故这里必须保留同一入口。
 */
export function EmptyChatPane({
  accounts,
  selectedAccountId,
  onAccountChange,
}: EmptyChatPaneProps) {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-workbench-surface">
      <RangePill
        accounts={accounts}
        selectedAccountId={selectedAccountId}
        onAccountChange={onAccountChange}
      />
      <div className="flex flex-1 items-center justify-center text-wb-2xs text-workbench-text-muted">
        {STRINGS.conversationList.noConversation}
      </div>
    </div>
  );
}
