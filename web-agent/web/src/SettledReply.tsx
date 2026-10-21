import type {ReactNode} from 'react';

// Keep the original reply node mounted through completion. CSS folds its actual
// height while the final reply stays mounted and keeps its streaming identity.
export function SettledReply({collapsed, children}: {collapsed: boolean; children: ReactNode}) {
  return <div className={`settled-reply${collapsed ? ' is-archived' : ''}`} aria-hidden={collapsed || undefined} inert={collapsed}>
    <div className="settled-reply-content">{children}</div>
  </div>;
}
