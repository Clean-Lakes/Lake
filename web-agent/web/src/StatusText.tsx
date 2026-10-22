import type {ReactNode} from "react";

/** Move a color highlight across opaque text without changing its layout. */
export function StatusText({ text, children, active = false, className = "" }: { text?: string; children?: ReactNode; active?: boolean; className?: string }) {
  return <span className={`status-text ${active ? "status-text--active" : ""} ${className}`}>{children??text}</span>;
}
