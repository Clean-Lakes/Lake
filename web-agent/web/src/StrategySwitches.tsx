import type {StrategySettings,StrategySettingsView} from './strategyApi';

export function StrategySwitches({view,disabled,onChange,onSave}:{view:StrategySettingsView;disabled:boolean;onChange:(value:StrategySettings)=>void;onSave:()=>void}) {
 const {settings,effective,source}=view;
 const online=!!settings.onlineCorrectEnabled&&settings.onlineConsentVersion===2;
 return <fieldset className="strategy-switches" disabled={disabled}>
  <legend>应用与学习</legend>
  <label><input type="checkbox" checked={settings.masterEnabled} onChange={e=>onChange({...settings,masterEnabled:e.target.checked})}/>启用策略能力</label>
  <label><input type="checkbox" checked={settings.applyEnabled} onChange={e=>onChange({...settings,applyEnabled:e.target.checked})}/>会话应用已采用资产</label>
  <label><input type="checkbox" checked={settings.learnEnabled} onChange={e=>onChange({...settings,learnEnabled:e.target.checked})}/>积累待审核候选</label>
  <p className="settings-note">应用与学习分别控制；候选需要审核和采用，记忆写入仍需独立授权。</p>
  {settings.legacyOnlineConsent?.enabled&&<p className="settings-note">旧版试用的在线纠错同意已停用，历史记录保留；不会自动恢复旧任务。</p>}
  <details>
   <summary>在线实验（默认关闭）</summary>
   <label><input type="checkbox" checked={settings.correctEnabled} onChange={e=>onChange({...settings,correctEnabled:e.target.checked})}/>允许在线只读纠错实验</label>
   <label><input type="checkbox" checked={online} onChange={e=>onChange({...settings,onlineCorrectEnabled:e.target.checked,onlineConsentVersion:e.target.checked?2:0})}/>我同意本版本的在线只读纠错实验</label>
   <p className="settings-note">在线实验可能因权限、未知结果或额度提前停止任务。需同时开启策略能力和在线实验；只在明确试验时开启。保存旧版开关不会授权本版本实验。</p>
  </details>
  <p className="settings-note">{source==='inherited'?'尚未保存项目限制，当前继承全局设置。保存后项目与全局逐项取交集。':source==='default'?'初始默认全部关闭。':'设置已保存。'} 当前实际应用：{effective.masterEnabled&&effective.applyEnabled?'开启':'关闭'}。当前在线实验：{effective.onlineCorrectEnabled?'开启':'关闭'}。设置版本 {settings.revision} · 变更序号 {settings.epoch}</p>
  <button type="button" className="button secondary" onClick={onSave}>保存开关</button>
 </fieldset>;
}
