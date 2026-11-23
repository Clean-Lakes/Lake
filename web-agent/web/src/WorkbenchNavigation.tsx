import {Glyph} from './Icons';
import './workbenchNavigation.css';

export function WorkbenchNavigation({expanded, back, forward, onToggle, onStep}: {
  expanded: boolean;
  back: boolean;
  forward: boolean;
  onToggle: () => void;
  onStep: (direction: -1 | 1) => void;
}) {
  const label = expanded ? '收起侧栏' : '展开侧栏';
  return <div className="workbench-navigation" role="group" aria-label="工作台导航">
    <button type="button" aria-label={label} title={label} aria-expanded={expanded}
      aria-controls="lake-project-navigation" onClick={onToggle}><Glyph name="panel" size={16}/></button>
    <div className="workbench-navigation-history">
      <button type="button" aria-label="后退" title="后退" disabled={!back} onClick={() => onStep(-1)}>
        <Glyph name="previous" size={17}/>
      </button>
      <button type="button" aria-label="前进" title="前进" disabled={!forward} onClick={() => onStep(1)}>
        <Glyph name="next" size={17}/>
      </button>
    </div>
  </div>;
}
