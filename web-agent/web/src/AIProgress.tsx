import { useEffect, useState } from "react";
import type { AICard, AIView } from "../../shared/contracts";
import { turnProgress } from "./activity";
import { LakeThinkingIcon } from "./LakeThinkingIcon";

export function AIProgress({ view, cards, latestUserAt, thinkingVisible }: { view: AIView; cards: AICard[]; latestUserAt: string; thinkingVisible: boolean }) {
  const [now, setNow] = useState(Date.now);
  const live = ["running", "waiting_approval"].includes(view.status);
  useEffect(() => {
    setNow(Date.now());
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [view.session, view.turnStartedAt, latestUserAt, live]);
  const {activity, elapsed} = turnProgress(view, cards, latestUserAt, now, thinkingVisible);
  // The compact timeline already presents the current action. Keep one status
  // surface, and show the final duration only once the turn finishes.
  if (live && thinkingVisible) return null;
  if (!activity && !elapsed) return null;
  return <div className="ai-progress">
    {elapsed && <div className="ai-progress-elapsed">已处理 {elapsed}</div>}
    {activity && <div className={`ai-progress-activity ${activity.icon === "approval" ? "is-waiting" : view.status === "running" ? "is-processing" : ""}`} role="status" aria-live="polite" aria-atomic="true"><LakeThinkingIcon/><strong className="thinking-agent-name">Lake</strong><span className="ai-progress-text">{activity.text}</span>{activity.detail && <small>{activity.detail}</small>}</div>}
  </div>;
}
