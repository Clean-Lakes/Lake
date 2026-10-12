/** A drop touching a lake: Lake's own thinking mark, shared by both status surfaces. */
export function LakeThinkingIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path className="lake-thinking-drop" d="M12 3.5s-2.5 2.8-2.5 4.7a2.5 2.5 0 0 0 5 0C14.5 6.3 12 3.5 12 3.5Z"/>
    <path className="lake-thinking-ripple" d="M8 12.4c-3 .6-5 1.9-5 3.4 0 2.1 4 3.9 9 3.9s9-1.8 9-3.9c0-1.5-2-2.8-5-3.4"/>
    <path className="lake-thinking-wave" d="M8.5 15.5c.8.5 2 .8 3.5.8s2.7-.3 3.5-.8"/>
  </svg>;
}
