import type { AICard, AIView } from "../../shared/contracts";
import { turnProgress } from "./activity";
import { LakeThinkingIcon } from "./LakeThinkingIcon";
import { StatusText } from "./StatusText";

export function AIProgress({ view, cards, latestUserAt, thinkingVisible }: { view: AIView; cards: AICard[]; latestUserAt: string; thinkingVisible: boolean }) {
  const live = ["running", "waiting_approval"].includes(view.status);
  const {activity} = turnProgress(view, cards, latestUserAt, Date.now(), thinkingVisible);
  // The compact timeline already presents the current action. Keep one status
  // surface. Per-turn duration is rendered by ReplyDuration.
  if (live && thinkingVisible) return null;
  if (!activity) return null;
  return <div className="ai-progress">
    {activity && <div className={`ai-progress-activity ${activity.icon === "approval" ? "is-waiting" : view.status === "running" ? "is-processing" : ""}`} role="status" aria-live="polite" aria-atomic="true"><LakeThinkingIcon/><strong className="thinking-agent-name">Lake</strong><StatusText className="ai-progress-text" text={activity.text} active={view.status === "running" && activity.icon !== "approval"}/>{activity.detail && <small>{activity.detail}</small>}</div>}
  </div>;
}
