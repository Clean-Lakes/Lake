import { useCallback } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { logger } from "@/logger.js";
import type { TabStoreState } from "@/store/tabStore.js";
import { requestLakeSwitcherOpen } from "@/lib/lakeSwitcherOpen.js";

export function useConversationWorkspaceActions({
  services,
  addTab,
  setWorkspaceActionError,
}: {
  services: IServiceAccessor;
  addTab: TabStoreState["addTab"];
  setWorkspaceActionError: (error: string | null) => void;
}) {
  const handleSelectConversationWorkspace = useCallback(
    (path: string) => {
      // 对话工作区是 app 管理的共享 cwd，不属于用户项目：不走跨窗口项目激活，
      // 也不写 recentProjects，只用 purpose 让展示层把它归到“对话”。
      logger.info("[Root] select conversation workspace", { path });
      addTab(path, { workspacePurpose: "conversation" });
      setWorkspaceActionError(null);
    },
    [addTab, setWorkspaceActionError],
  );

  const handleResolveConversationWorkspace = useCallback(async () => {
    try {
      const result = await services.fileService.ensureConversationWorkspace();
      setWorkspaceActionError(null);
      return result.path;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Root] ensure conversation workspace failed", { error });
      setWorkspaceActionError(message);
      throw error;
    }
  }, [services.fileService, setWorkspaceActionError]);

  const handleEnsureConversationWorkspace = useCallback(async () => {
    const path = await handleResolveConversationWorkspace();
    handleSelectConversationWorkspace(path);
    return path;
  }, [handleResolveConversationWorkspace, handleSelectConversationWorkspace]);

  const handleCreateConversationTask = useCallback(async () => {
    // 通用对话工作区没有湖绑定；继续从这里建草稿会绕过“先选湖”规则。
    requestLakeSwitcherOpen();
  }, []);

  return {
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
  };
}
