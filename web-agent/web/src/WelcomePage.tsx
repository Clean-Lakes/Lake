import {Glyph} from './Icons';
import {LakeLogo} from './LakeLogo';
import './welcomePage.css';

type Props = {hasProjects:boolean;projectName?:string;modelConfigured:boolean;modelName?:string|null;disabled:boolean;onCreateProject:()=>void;onNewSession:()=>void;onModels:()=>void};

export function WelcomeSidebar({disabled,onCreate}:{disabled:boolean;onCreate:()=>void}){
 return <div className="welcome-sidebar"><div className="welcome-sidebar-heading"><span>项目</span><button type="button" className="icon-button" aria-label="创建第一个项目" disabled={disabled} onClick={onCreate}><Glyph name="plus" size={16}/></button></div><p>暂无项目</p><small>创建项目后，可添加资源和会话。</small></div>;
}

export function WelcomePage({hasProjects,projectName,modelConfigured,modelName,disabled,onCreateProject,onNewSession,onModels}:Props){
 return <section className="welcome-start" aria-labelledby="welcome-title">
  <div className="welcome-start-inner">
   <header className="welcome-intro"><LakeLogo size={80} decorative/><h1 id="welcome-title">{hasProjects?'Lake 工作台':'欢迎使用 Lake'}</h1><p>{hasProjects?`当前项目：${projectName||'未选择项目'}`:'连接模型，创建项目，开始使用。'}</p></header>
   <div className="welcome-setup-actions">
    <button type="button" className="welcome-setup-row" aria-label={modelConfigured?'管理模型':'连接模型'} disabled={disabled} onClick={onModels}>
     <span className="welcome-row-icon"><Glyph name="plug" size={21}/></span>
     <span className="welcome-row-copy"><strong>{modelConfigured?'管理模型':'连接模型'}</strong><span>{modelConfigured?modelName||'修改模型配置':'配置模型供应商与访问密钥'}</span></span>
     {modelConfigured&&<span className="welcome-row-state"><Glyph name="check" size={13}/>已配置</span>}
     <Glyph name="next" size={16} className="welcome-row-arrow"/>
    </button>
    <button type="button" className="welcome-setup-row" aria-label={hasProjects?'开始新会话':'创建项目'} disabled={disabled} onClick={hasProjects?onNewSession:onCreateProject}>
     <span className="welcome-row-icon"><Glyph name={hasProjects?'chatAdd':'folder'} size={21}/></span>
     <span className="welcome-row-copy"><strong>{hasProjects?'开始新会话':'创建项目'}</strong><span>{hasProjects?'在当前项目中开启会话':'管理相关的资源和会话'}</span></span>
     <Glyph name="next" size={16} className="welcome-row-arrow"/>
    </button>
   </div>
   {!modelConfigured&&<p className="welcome-start-note">也可以先创建项目，稍后再连接模型。</p>}
  </div>
 </section>;
}
