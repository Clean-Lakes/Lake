import {Glyph} from './Icons';
import {ProviderIcon} from './ProviderIcon';
import './welcomePage.css';

type Props = {hasProjects:boolean;projectName?:string;modelConfigured:boolean;modelName?:string|null;disabled:boolean;onCreateProject:()=>void;onNewSession:()=>void;onModels:()=>void};

function WelcomeIllustration(){
 return <div className="welcome-illustration" aria-hidden="true">
  <div className="welcome-contours">{Array.from({length:7},(_,i)=><i key={i} style={{inset:`${i*12}px ${i*8}px`}}/>)}</div>
  <span className="welcome-orbit-node is-model"><Glyph name="brain" size={18}/><span>模型</span></span>
  <span className="welcome-orbit-node is-resource"><Glyph name="server" size={18}/><span>资源</span></span>
  <span className="welcome-orbit-node is-evidence"><Glyph name="document" size={18}/><span>证据</span></span>
  <div className="welcome-lake-mark"><Glyph name="lakeProcess" size={44}/></div>
  <span className="welcome-orbit-caption">LAKE</span>
 </div>;
}

export function WelcomeSidebar({disabled,onCreate}:{disabled:boolean;onCreate:()=>void}){
 return <div className="welcome-sidebar"><div className="welcome-sidebar-heading"><span>项目</span><button type="button" className="icon-button" aria-label="创建第一个项目" disabled={disabled} onClick={onCreate}><Glyph name="plus" size={16}/></button></div><div className="welcome-sidebar-guide" aria-hidden="true"><span><Glyph name="folder" size={15}/><i/></span><span><Glyph name="chat" size={14}/><i/></span><span><Glyph name="server" size={14}/><i/></span></div><p>为你的环境，留一个位置。</p><small>项目、资源与会话将在这里归集。</small></div>;
}

export function WelcomePage({hasProjects,projectName,modelConfigured,modelName,disabled,onCreateProject,onNewSession,onModels}:Props){
 return <section className="welcome-start" aria-labelledby="welcome-title">
  <div className="welcome-start-inner">
   <div className="welcome-start-eyebrow"><span/>YOUR OPERATIONS, IN FOCUS</div>
   <div className="welcome-hero"><div className="welcome-hero-copy"><h1 id="welcome-title">{hasProjects?<>今天，从哪里<span>开始？</span></>:<>复杂运维，<span>从容开始。</span></>}</h1><p>{hasProjects?<>从「{projectName||'你的项目'}」开启会话，<br/>让每一次调查和行动，都有迹可循。</>:<>连接模型，组织你的基础设施。<br/>让调查、执行与复核，在同一处自然衔接。</>}</p><div className="welcome-principles"><span><Glyph name="search" size={14}/>洞察问题</span><i/><span><Glyph name="terminal" size={14}/>推进操作</span><i/><span><Glyph name="check" size={14}/>验证结果</span></div></div><WelcomeIllustration/></div>
   <div className="welcome-setup-heading"><span>{hasProjects?'继续你的工作':'为你的工作台，完成两项准备'}</span><span>{hasProjects?'WORKSPACE':'GET STARTED'}</span></div>
   <div className="welcome-setup-actions">
    <button type="button" className={`welcome-setup-card${modelConfigured?' is-configured':''}`} aria-label={modelConfigured?"管理模型":"连接模型"} disabled={disabled} onClick={onModels}>
     <span className="welcome-card-top"><span className="welcome-card-icon"><Glyph name={modelConfigured?'check':'plug'} size={20}/></span><span className="welcome-card-step">{modelConfigured?'已配置':'01'}</span></span>
     <span className="welcome-card-title">{modelConfigured?'管理模型':'连接模型'}<Glyph name="arrow" size={18}/></span>
     <span className="welcome-card-description">{modelConfigured?modelName||'管理你的模型与供应商':'接入常用的模型，或使用本地模型。'}</span>
     <span className="welcome-model-brands" aria-hidden="true"><ProviderIcon brand="openai" size={14}/><ProviderIcon brand="anthropic" size={14}/><ProviderIcon brand="deepseek" size={14}/><span>与你熟悉的 AI 一起工作</span></span>
    </button>
    <button type="button" className="welcome-setup-card is-project" aria-label={hasProjects?"开始新会话":"创建第一个项目"} disabled={disabled} onClick={hasProjects?onNewSession:onCreateProject}>
     <span className="welcome-card-top"><span className="welcome-card-icon"><Glyph name={hasProjects?'chatAdd':'folder'} size={20}/></span><span className="welcome-card-step">{hasProjects?'下一步':'02'}</span></span>
     <span className="welcome-card-title">{hasProjects?'开始新会话':'创建第一个项目'}<Glyph name="arrow" size={18}/></span>
     <span className="welcome-card-description">{hasProjects?'描述你要检查的问题，Lake 会陪你推进。':'把相关的资源与会话，放在同一个空间。'}</span>
     <span className="welcome-project-hint"><Glyph name="plus" size={13}/>{hasProjects?'保留过程，也保留每一步的依据':'从一个名字开始，随时扩展你的环境'}</span>
    </button>
   </div>
   <footer className="welcome-start-footer"><Glyph name="lakeProcess" size={17}/><span>调查有依据，行动有边界。</span><span className="welcome-footer-wordmark">Lake</span></footer>
  </div>
 </section>;
}
