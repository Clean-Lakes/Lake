import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SuperRoleAvatar,greetRoleAvatar} from '../../src/SuperRoleAvatar';
import {lakeAvatarCatalog} from '../../src/lakeAvatarCatalog';
import {lakeAvatarMotions} from '../../src/lakeAvatarMotion';
import {superWorkerAppearance,type AvatarMotion} from '../../src/superAgentPresentation';
import {AppSelect} from '../../src/AppSelect';
import '../../src/styles.css';
import '../../src/pilotWorkspace.css';
import '../../src/appSelect.css';
import '../../src/specialistAvatars.css';
import './refined-avatars.css';

const roles=new Map();
for(let i=0;roles.size<100;i++){const id=`refined-avatar-${i}`,look=superWorkerAppearance({roleId:id,roleName:''});if(!roles.has(look.icon))roles.set(look.icon,id);}
function Gallery(){
 const [motion,setMotion]=useState<AvatarMotion>('idle'),[small,setSmall]=useState(false),[dark,setDark]=useState(false);
 return <main className="refined-gallery" data-small={small||undefined}>
  <header><div><h1>Lake · 精细化专员头像</h1><p>100 个原角色 · 自然分色 · 分部件动作 · 独立界面验收，不连接模型或资源</p></div><button className="button" onClick={()=>{document.documentElement.dataset.theme=dark?'light':'dark';setDark(!dark);}}>{dark?'切换浅色':'切换深色'}</button></header>
  <div className="refined-controls"><label>会话状态<AppSelect aria-label="头像状态" value={motion} onChange={event=>setMotion(event.target.value as AvatarMotion)}><option value="idle">闲时</option><option value="working">正在会话</option><option value="still">静止</option></AppSelect></label><button className="button" onClick={()=>setSmall(!small)}>{small?'查看 64px':'查看 22px'}</button><button className="button" onClick={()=>document.querySelectorAll<HTMLElement>('.refined-tile').forEach(tile=>greetRoleAvatar(tile))}>播放所有回应</button></div>
  <div className="refined-grid">{lakeAvatarCatalog.map(avatar=><button className="refined-tile" key={avatar.id} data-avatar-id={avatar.id} onClick={event=>greetRoleAvatar(event.currentTarget)} aria-label={`${avatar.name}，${lakeAvatarMotions[avatar.id].label}，点击回应`}>
   <span className="refined-art"><SuperRoleAvatar roleId={roles.get(avatar.id)} name={avatar.name} motion={motion}/></span><strong>{avatar.name}</strong><span>{lakeAvatarMotions[avatar.id].label}</span>
  </button>)}</div>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Gallery/>);
