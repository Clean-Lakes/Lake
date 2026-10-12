import { useEffect, useState } from "react";
import type { AICard, AIView } from "../../shared/contracts";
import { turnProgress, type Activity } from "./activity";
import { LakeThinkingIcon } from "./LakeThinkingIcon";

function ActivityIcon({ icon }: { icon: Activity["icon"] }) {
  if (icon === "thinking") return <LakeThinkingIcon/>;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {icon === "file" ? <><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/><path d="M6 2v13"/></> : icon === "search" ? <><circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/></> : icon === "terminal" ? <><path d="m4 6 5 5-5 5M12 17h8"/></> : icon === "approval" ? <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></> : <><rect x="4" y="4" width="16" height="6" rx="2"/><rect x="4" y="14" width="16" height="6" rx="2"/></>}
  </svg>;
}
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
    {activity && <div className={`ai-progress-activity ${activity.icon === "approval" ? "is-waiting" : view.status === "running" ? "is-processing" : ""}`} role="status" aria-live="polite" aria-atomic="true"><ActivityIcon icon={activity.icon}/><span className="ai-progress-text">{activity.text}</span>{activity.detail && <small>{activity.detail}</small>}</div>}
  </div>;
}
