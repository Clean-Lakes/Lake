/** Shared running indicator for conversations and independent Agent tasks. */
export function ActivityIndicator({className = ""}: {className?: string}) {
  return <svg className={`activity-indicator ${className}`} viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6" opacity=".2"/><path d="M8 2a6 6 0 0 1 6 6"/></svg>;
}
