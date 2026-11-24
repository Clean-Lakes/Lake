import {useEffect,useRef,useState} from "react";
import type {SkillCatalog,SkillConfig} from "../../shared/contracts";
import {api,readableError} from "./api";
import {Glyph} from "./Icons";
import {WorkspaceSettingSection} from "./WorkspacePage";
import "./extensionSettings.css";

const skillTemplate="---\nname: new-skill\ndescription: 描述适合使用这个 Skill 的场景\n---\n\n# 操作流程\n\n1. 明确目标与范围。\n2. 收集事实，再给出处理步骤。\n3. 完成后核实结果。\n";
export {MCPSettings} from "./MCPSettings";

export function SkillSettings({onBusyChange}:{onBusyChange:(busy:boolean)=>void}){
 const detail=useRef<HTMLDivElement>(null);
 const [catalog,setCatalog]=useState<SkillCatalog>({skills:[],roots:[],defaultRoot:""}),[selected,setSelected]=useState<SkillConfig|null>(null),[content,setContent]=useState(""),[name,setName]=useState(""),[enabled,setEnabled]=useState(true),[creating,setCreating]=useState(false),[rootsOpen,setRootsOpen]=useState(false),[root,setRoot]=useState("");
 const [busy,setBusy]=useState(""),[loading,setLoading]=useState(true),[dirty,setDirty]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 async function load(){const data=await api.skills();setCatalog(data);return data;}
 useEffect(()=>{void load().catch(e=>setError(readableError(e))).finally(()=>setLoading(false));},[]);
 async function run(kind:string,task:()=>Promise<void>){setBusy(kind);onBusyChange(true);setError("");setNotice("");try{await task();}catch(e){setError(readableError(e));detail.current?.scrollIntoView({block:"start"});}finally{setBusy("");onBusyChange(false);}}
 function create(){detail.current?.scrollIntoView({block:"start"});setCreating(true);setRootsOpen(false);setSelected(null);setName("");setContent(skillTemplate);setEnabled(true);setDirty(true);setError("");setNotice("");}
 async function choose(skill:SkillConfig){const data=await api.skill(skill.name);detail.current?.scrollIntoView({block:"start"});setSelected(data.skill);setContent(data.content);setName(data.skill.name);setEnabled(data.skill.enabled);setCreating(false);setRootsOpen(false);setDirty(false);}
 return <section id="skills-settings-panel" role="tabpanel" aria-labelledby="skills-settings-tab" className="extension-settings skill-settings">
 <WorkspaceSettingSection id="skills-library-title" title="已安装的 Skills" actions={<>
    <span className="workspace-directory-count">{catalog.skills.length} 个</span>
    <button type="button" className="icon-button" aria-label="刷新 Skills" title="刷新 Skills" disabled={!!busy} onClick={()=>void run("refresh",async()=>{await load();})}><Glyph name="refresh" size={15}/></button>
    <button type="button" className="button secondary" disabled={!!busy} onClick={()=>{setRootsOpen(true);setError("");setNotice("");}}>管理 Skill 目录</button>
    <button type="button" className="button primary" disabled={!!busy} onClick={create}><Glyph name="plus" size={14}/>新建 Skill</button>
  </>}>
  {loading ? <p className="settings-note" role="status">正在加载…</p> : catalog.skills.length ? <div className="extension-list workspace-setting-card" aria-label="已安装的 Skills">
   {catalog.skills.map(skill => {
    const active=selected?.name===skill.name&&!creating&&!rootsOpen;
    return <button key={skill.name} type="button" className="extension-item" aria-pressed={active} disabled={!!busy} onClick={()=>void run("read",()=>choose(skill))}>
     <span className="provider-avatar"><Glyph name="book" size={18}/></span>
     <span><strong title={skill.name}>{skill.name}</strong><small>{skill.source} · {skill.enabled?"已启用":"已停用"}</small></span>
     <i className={`provider-state ${skill.enabled?"enabled":""}`}/>
    </button>;
   })}
  </div> : <div className="extension-empty workspace-setting-card">
   <h3>暂无 Skills</h3><p>新建一个 Skill，或在「管理 Skill 目录」中导入已有流程。</p>
  </div>}
 </WorkspaceSettingSection>
 <div ref={detail} className="extension-detail">
  {error&&<p className="form-error" role="alert">{error}</p>}
  {notice&&<p className="provider-success" role="status">{notice}</p>}
  {rootsOpen?<WorkspaceSettingSection id="skills-roots-title" title="Skill 目录">
   <div className="workspace-setting-card">
    <div className="workspace-setting-row">
     <div className="workspace-setting-copy">
      <strong>Lake 默认目录</strong><p className="settings-note"><code>{catalog.defaultRoot}</code></p>
     </div>
    </div>
    <form className="workspace-setting-row" onSubmit={e=>{
     e.preventDefault();
     void run("root",async()=>{await api.skillRoot(root.trim());await load();setRoot("");setNotice("目录已导入，已扫描可用 Skills。");});
    }}>
     <div className="workspace-setting-copy">
      <label htmlFor="skill-root-path">导入本机目录</label>
      <p className="settings-note">扫描一级子目录中的 SKILL.md，也可导入单个 Skill。外部内容请在原文件中编辑，再回到这里刷新。</p>
     </div>
     <div className="workspace-setting-field extension-root-field">
      <input id="skill-root-path" placeholder="包含 SKILL.md 的目录，或其父目录" value={root} disabled={!!busy} onChange={e=>setRoot(e.target.value)}/>
      <button type="submit" className="button primary" disabled={!!busy||!root.trim()}>导入目录</button>
     </div>
    </form>
    {catalog.roots.map(path=><div className="workspace-setting-row" key={path}>
     <div className="workspace-setting-copy"><code>{path}</code></div>
     <button type="button" className="provider-text-button" disabled={!!busy} onClick={()=>void run("root",async()=>{await api.skillRoot(path,true);await load();setNotice("已移除目录配置，原文件仍保留。");})}>移除</button>
    </div>)}
   </div>
  </WorkspaceSettingSection>:creating||selected?<WorkspaceSettingSection id="skill-detail-title" title={creating?"新建 Skill":name}>
   <div className="workspace-setting-card">
    <div className="workspace-setting-row">
     <div className="workspace-setting-copy">
      <label htmlFor="skill-name">Skill 名称</label>
      {(dirty||selected)&&<p className="settings-note">{dirty?"有未保存的更改":selected?.source}</p>}
      {selected&&<p className="settings-note" title={selected.path}>{selected.path}</p>}
     </div>
     <input className="workspace-setting-field" id="skill-name" value={name} readOnly={!creating} disabled={!!busy} maxLength={80} placeholder="例如 service-check" onChange={e=>{setName(e.target.value);setDirty(true);}}/>
    </div>
    <label className="workspace-setting-row extension-switch-row">
     <span className="workspace-setting-copy"><strong>启用 Skill</strong><span className="settings-note">启用后，Lake 会在对话中按需加载，并遵循当前会话权限。</span></span>
     <input className="provider-switch" type="checkbox" role="switch" aria-label="启用 Skill" checked={enabled} disabled={!!busy} onChange={e=>{setEnabled(e.target.checked);setDirty(true);}}/>
    </label>
    <div className="workspace-setting-row extension-editor-block">
     <label className="field-label">SKILL.md
      <textarea className="extension-code extension-skill-content" rows={14} value={content} readOnly={!creating&&!selected?.managed} disabled={!!busy} spellCheck={false} onChange={e=>{setContent(e.target.value);setDirty(true);}}/>
     </label>
    </div>
    <div className="workspace-setting-row extension-editor-actions">
     <button type="button" className="button primary" disabled={!!busy||!dirty||!name.trim()} onClick={()=>void run("save",async()=>{
      await api.saveSkill(name.trim(),{enabled,create:creating,...(creating||selected?.managed?{content:creating?content.replace(/^name:.*$/m,`name: ${name.trim()}`):content}:{})});
      const data=await load();const skill=data.skills.find(v=>v.name===name.trim());if(skill)await choose(skill);
      setNotice(enabled?"Skill 已保存，聊天中即可按需使用。":"Skill 已停用，不再加载。");
     })}>{busy==="save"?"保存中…":"保存 Skill"}</button>
    </div>
   </div>
  </WorkspaceSettingSection>:null}
 </div></section>;
}
