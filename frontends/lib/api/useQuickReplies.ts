// 快捷回复 hook —— 纯客户端本地表的读取 + 增删改。
//
// 设计:无事件驱动(不接 ChangeNotice),由本 hook 维护本地列表 state:
//   - 挂载时拉一次列表;
//   - create / update / remove 调命令成功后 refresh 重拉(单一可信源)。
// employee 隔离在后端按当前会话完成,前端无需传 employeeId。

import { useCallback, useEffect, useState } from "react";

import {
  createQuickReply,
  deleteQuickReply,
  listQuickReplies,
  updateQuickReply,
  type QuickReplyRecord,
} from "./quickReplies";

export interface UseQuickRepliesResult {
  replies: QuickReplyRecord[];
  loading: boolean;
  error: string | null;
  /** 新建:内部生成 id(crypto.randomUUID),成功后重拉列表。 */
  create: (title: string, content: string) => Promise<void>;
  update: (id: string, title: string, content: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useQuickReplies(): UseQuickRepliesResult {
  const [replies, setReplies] = useState<QuickReplyRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReplies(await listQuickReplies());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 挂载拉一次列表。refresh 内部「取数前同步置 loading=true」是标准取数模式;本 hook 用
  // 本地 useState 而非外部 store,取数确需 effect 触发,按 useFriendDetail 同例豁免该 lint。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (title: string, content: string) => {
      try {
        await createQuickReply(crypto.randomUUID(), title, content);
        await refresh();
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, title: string, content: string) => {
      try {
        await updateQuickReply(id, title, content);
        await refresh();
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteQuickReply(id);
        await refresh();
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [refresh],
  );

  return { replies, loading, error, create, update, remove, refresh };
}
