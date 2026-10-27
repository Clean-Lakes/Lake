import type {StrategySettings,StrategySettingsView} from './strategyApi';

export function StrategySwitches({view,disabled,onChange,onSave}:{view:StrategySettingsView;disabled:boolean;onChange:(value:StrategySettings)=>void;onSave:()=>void}) {
 const {settings,effective,source}=view;
 const change=(value:Partial<StrategySettings>)=>onChange({...settings,...value,learnEnabled:false,correctEnabled:false,onlineCorrectEnabled:false,onlineConsentVersion:0});
 return <fieldset className="strategy-switches" disabled={disabled}>
  <legend>人工资产应用</legend>
  <label><input type="checkbox" checked={settings.masterEnabled} onChange={e=>change({masterEnabled:e.target.checked})}/>启用策略能力</label>
  <label><input type="checkbox" checked={settings.applyEnabled} onChange={e=>change({applyEnabled:e.target.checked})}/>会话应用已采用资产</label>
  <p className="settings-note">在线纠错、候选提取和新增对照实验已停用。已保存资产、采用设置与历史记录保留，项目记忆和 Skills 按原设置工作。</p>
  <p className="settings-note">{source==='inherited'?'当前继承全局设置，保存后项目与全局取交集。':source==='default'?'初始默认关闭。':'设置已保存。'} 当前实际应用：{effective.masterEnabled&&effective.applyEnabled?'开启':'关闭'}。</p>
  <button type="button" className="button secondary" onClick={onSave}>保存开关</button>
 </fieldset>;
}
