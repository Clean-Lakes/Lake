import type { ReactNode } from "react";

export type AgentIconName = "lake" | "host" | "application" | "data" | "network" | "change" | "verify" | "plan" | "memory" | "other";

/** Stable role shapes. Status and motion belong to a separate status mark. */
export function AgentIcon({ role, size = 18, className = "" }: { role: AgentIconName; size?: number; className?: string }) {
  const paths: Record<AgentIconName, ReactNode> = {
    lake: <><path d="M2 6c2-2 4 2 6 0s4 2 6 0 4 2 8 0M2 12c2-2 4 2 6 0s4 2 6 0 4 2 8 0M2 18c2-2 4 2 6 0s4 2 6 0 4 2 8 0"/></>,
    host: <><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/></>,
    application: <><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/><circle cx="10.5" cy="10.5" r="3.5"/><path d="m13 13 4 4"/></>,
    data: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/></>,
    network: <><rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4M5 16v-4h14v4"/></>,
    change: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v12m-3-3 3 3 3-3M18 17V5m-3 3 3-3 3 3M8 5h3a3 3 0 0 1 3 3v8a3 3 0 0 0 3 3"/></>,
    verify: <><path d="m12 3 8 3v5c0 4.6-3 7.9-8 10-5-2.1-8-5.4-8-10V6Z"/><path d="m8.5 11.5 2.5 2.5 4.5-5"/></>,
    plan: <><circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6 6-2Z"/></>,
    memory: <><path d="M4 3h10M4 7h7M4 11h5M4 15h5M4 19h11a2 2 0 0 0 2-2v-4M2 3h2M2 7h2M2 11h2M2 15h2M2 19h2"/><path d="m12 11 1-4 6-6 3 3-6 6-4 1Z"/></>,
    other: <><path d="m3 8 9-5 9 5-9 5-9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/></>,
  };
  return <svg className={`agent-role-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[role]}</svg>;
}
