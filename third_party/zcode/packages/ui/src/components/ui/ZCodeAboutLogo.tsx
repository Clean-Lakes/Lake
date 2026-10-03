import { cn } from '@/components/lib/utils.js';

export function ZCodeAboutLogo({ className }: { className?: string }) {
  return <svg width="118" height="100" viewBox="0 0 118 100" className={cn('shrink-0 text-current', className)} aria-hidden="true"><path fill="currentColor" d="M24 12h18v62h54v14H24z"/><path fill="none" stroke="currentColor" strokeWidth="4" d="M44 56q10-12 20 0t20 0t20 0"/></svg>;
}

export function ZCodeWordmarkLogo({ className }: { className?: string }) {
  return <svg width="244" height="54" viewBox="0 0 244 54" className={cn('shrink-0 text-current', className)} aria-hidden="true"><text x="0" y="46" fontFamily="system-ui, sans-serif" fontSize="52" fontWeight="700" letterSpacing="4" fill="currentColor">LAKE</text></svg>;
}
