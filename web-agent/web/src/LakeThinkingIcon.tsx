import { AgentIcon } from "./AgentIcon";

/** Lake's role mark remains the same before, during, and after execution. */
export function LakeThinkingIcon({ className }: { className?: string }) {
  return <AgentIcon role="lake" className={className}/>;
}
