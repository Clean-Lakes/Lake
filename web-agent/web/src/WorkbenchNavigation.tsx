import {createContext, useLayoutEffect, useState, type ReactNode} from 'react';
import {Glyph} from './Icons';
import './workbenchNavigation.css';

export const WorkbenchSidebar = createContext({collapsed: false, expand() {}});

export function WorkbenchShell({className, compact, inspectorOpen, back, forward, onStep, children}: {
  className: string;
  compact: boolean;
  inspectorOpen: boolean;
  back: boolean;
  forward: boolean;
  onStep: (direction: -1 | 1) => void;
  children: ReactNode;
}) {
  const [folded, setFolded] = useState(false);
  const collapsed = !compact && folded;
  const changeSidebar = (next: boolean) => {
    if (next === folded) return;
    window.dispatchEvent(new Event('lake-workbench-sidebar-toggle'));
    setFolded(next);
  };
  useLayoutEffect(() => {
    window.dispatchEvent(new Event('lake-workbench-layout'));
  }, [collapsed, className, inspectorOpen]);

  const label = collapsed ? '展开侧栏' : '收起侧栏';
  return <div className={className + (collapsed ? ' has-collapsed-sidebar' : '')}>
    <div className="workbench-navigation" role="group" aria-label="工作台导航">
      <button type="button" aria-label={label} title={label} aria-expanded={!collapsed}
        aria-controls="lake-project-navigation" onClick={() => changeSidebar(!folded)}><Glyph name="panel" size={16}/></button>
      <div className="workbench-navigation-history">
        <button type="button" aria-label="后退" title="后退" disabled={!back} onClick={() => onStep(-1)}>
          <Glyph name="previous" size={17}/>
        </button>
        <button type="button" aria-label="前进" title="前进" disabled={!forward} onClick={() => onStep(1)}>
          <Glyph name="next" size={17}/>
        </button>
      </div>
    </div>
    <WorkbenchSidebar.Provider value={{collapsed, expand: () => changeSidebar(false)}}>{children}</WorkbenchSidebar.Provider>
  </div>;
}
