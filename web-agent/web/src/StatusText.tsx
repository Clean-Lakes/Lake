/** Move a color highlight across opaque text without changing its layout. */
export function StatusText({ text, active = false, className = "" }: { text: string; active?: boolean; className?: string }) {
  return <span className={`status-text ${active ? "status-text--active" : ""} ${className}`}>{text}</span>;
}
