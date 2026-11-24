import {useState} from 'react';
import type {Project} from '../../shared/contracts';
import {AppSelect} from './AppSelect';
import {Glyph} from './Icons';

export type ProjectSwitcherProps = {
  projects: readonly Pick<Project, 'id' | 'name'>[];
  value: string;
  onChange: (id: string) => void;
  iconOnly?: boolean;
  disabled?: boolean;
};

export function ProjectSwitcher({projects, value, onChange, iconOnly = false, disabled}: ProjectSwitcherProps) {
  const [query, setQuery] = useState('');
  const selected = projects.find(project => project.id === value);
  const needle = query.trim().normalize('NFKC').toLowerCase();
  const visible = projects.filter(project => project.name.normalize('NFKC').toLowerCase().includes(needle));
  const label = selected ? `切换项目：${selected.name}` : '切换项目';
  return <AppSelect popupMotion className={`sidebar-project-select${iconOnly ? ' is-icon-only' : ''}`}
    popupClassName="sidebar-project-popup" popupMinWidth={iconOnly ? 250 : 0} popupMaxHeight={320}
    value={value} label={label} title={label} disabled={disabled || !projects.length}
    icon={<Glyph name="folder" size={iconOnly ? 20 : 16}/>}
    renderValue={selected?.name ?? '选择项目'}
    onChange={event => onChange(event.target.value)}
    onOpenChange={open => {if (!open) setQuery('');}}
    popupHeader={({listId, activeId}) => <label className="sidebar-project-search">
      <Glyph name="search" size={16}/>
      <input type="search" autoFocus role="combobox" aria-label="搜索项目" placeholder="搜索项目"
        aria-expanded="true" aria-controls={listId} aria-activedescendant={activeId} aria-autocomplete="list"
        autoComplete="off" value={query} onChange={event => setQuery(event.target.value)}/>
    </label>}
    renderOption={option => <><Glyph name="folder" size={15}/><span>{option.label}</span></>}
    emptyMessage={needle ? '没有匹配的项目' : '暂无项目'}>
    {visible.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
  </AppSelect>;
}
