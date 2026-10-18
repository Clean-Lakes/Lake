// Isolated permissions UI: state stays in memory; no backend or resource operations.
import {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PermissionSettings,permissionDefaults} from '../../src/PermissionSettings';
import {setThemePreference} from '../../src/appearance';
import '../../src/styles.css';
const params=new URLSearchParams(location.search);
setThemePreference(params.get('theme')==='dark'?'dark':'light');
function Fixture(){
 const anchor=useRef<HTMLButtonElement>(null);
 const [open,setOpen]=useState(false),[options,setOptions]=useState({...permissionDefaults});
 const [busy,setBusy]=useState(params.has('busy'));
 return <main style={{height:'100dvh',padding:24,display:'flex',flexDirection:'column',justifyContent:'space-between'}}>
  <div><h2>Lake · 执行偏好</h2><p>隔离交互验证，不连接资源。</p><button type="button" onClick={()=>setBusy(value=>!value)}>模拟执行状态：{busy?'进行中':'空闲'}</button></div>
  <div><button type="button" className="composer-permission-button" ref={anchor} aria-label="会话权限" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>权限</button></div>
  {open&&<PermissionSettings anchor={anchor} options={options} disabled={busy} error={params.has('error')?'保存失败，请重试。':undefined} onClose={()=>setOpen(false)} onChange={(key,value)=>setOptions(current=>({...current,[key]:value}))}/>}
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
