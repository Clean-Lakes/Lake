import { useRef, useState } from "react";
import { Glyph } from "./Icons";

export function WorkspaceRefresh({ refresh, onComplete, onFailure }: {
  refresh: () => Promise<void>;
  onComplete: () => void;
  onFailure: (error: unknown) => void;
}) {
  const pending = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  async function run() {
    if (pending.current) return;
    pending.current = true;
    setRefreshing(true);
    try { await refresh(); onComplete(); }
    catch (error) { onFailure(error); }
    finally { pending.current = false; setRefreshing(false); }
  }
  return <button className={`icon-button workspace-refresh${refreshing ? " is-refreshing" : ""}`} type="button" aria-label={refreshing ? "正在刷新工作台" : "刷新工作台"} title={refreshing ? "正在刷新工作台…" : "刷新项目、会话与终端数据"} aria-busy={refreshing} disabled={refreshing} onClick={() => void run()}><Glyph name="refresh" size={16}/></button>;
}
