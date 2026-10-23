import {KubernetesResourceFields} from './KubernetesResourceFields';
import './serviceResourceFields.css';
import {AppSelect} from './AppSelect';
import {useState} from 'react';
import type {ResourceInputType,ServiceDraft} from './serviceResourceModel';
export function ServiceResourceFields({type,value,onChange,disabled,projectId}:{type:ResourceInputType;value:ServiceDraft;onChange:(value:ServiceDraft)=>void;disabled:boolean;projectId:string}) {
 const [auth,setAuth]=useState('none');
 const set=<K extends keyof ServiceDraft>(key:K,next:ServiceDraft[K])=>onChange({...value,[key]:next});
 const database=type==='mysql'||type==='postgres';
 const metrics=type==='prometheus'||type==='victoriametrics';
 const endpoints={kubernetes:'https://cluster.example.com:6443',apisix:'http://127.0.0.1:9180',prometheus:'http://127.0.0.1:9090',victoriametrics:'http://127.0.0.1:8428'};
 return <fieldset disabled={disabled} className="service-resource-fields">
 {type==='kubernetes'?<KubernetesResourceFields value={value} onChange={onChange} disabled={disabled} projectId={projectId}/>:database||type==='redis'?<>
 <label className="field-label">主机地址<input required value={value.host} onChange={e=>set('host',e.target.value)} placeholder="主机名或 IP"/></label>
 <label className="field-label">端口<input required type="number" min={1} max={65535} step={1} value={value.port} onChange={e=>set('port',Number(e.target.value))}/></label>
 <label className="field-label">{type==='redis'?'ACL 用户名（可选）':'用户名'}<input required={database} autoComplete="off" value={value.username} onChange={e=>set('username',e.target.value)}/></label>
 <label className="field-label">密码（可选）<input type="password" autoComplete="new-password" value={value.password} onChange={e=>set('password',e.target.value)}/></label>
 {database?<label className="field-label">数据库（可选）<input value={value.database} onChange={e=>set('database',e.target.value)}/></label>:<label className="field-label">数据库编号<input required type="number" min={0} max={65535} step={1} value={value.db} onChange={e=>set('db',Number(e.target.value))}/></label>}
 <label className="check-row"><input type="checkbox" checked={value.tls} onChange={e=>set('tls',e.target.checked)}/>使用 TLS 并验证证书</label>
 </>:<>
 <label className="field-label">{type==='apisix'?'Admin API 地址':'查询端点'}<input required type="url" value={value.endpoint} onChange={e=>set('endpoint',e.target.value)} placeholder={endpoints[type as keyof typeof endpoints]}/></label>
 {type==='victoriametrics'&&<p className="settings-note">单机填写服务地址；集群填写 vmselect 查询前缀，例如 https://vm.example.com/select/0/prometheus。</p>}
 {type==='apisix'&&<label className="field-label">Admin API Key（可选）<input type="password" autoComplete="new-password" value={value.apiKey} onChange={e=>set('apiKey',e.target.value)}/></label>}
 {metrics&&<><label className="field-label">认证方式<AppSelect value={auth} onChange={e=>{setAuth(e.target.value);onChange({...value,username:'',password:'',token:''});}}><option value="none">无需认证</option><option value="basic">用户名和密码</option><option value="bearer">Bearer Token</option></AppSelect></label>{auth==='basic'&&<><label className="field-label">用户名<input required value={value.username} onChange={e=>set('username',e.target.value)}/></label><label className="field-label">密码<input required type="password" autoComplete="new-password" value={value.password} onChange={e=>set('password',e.target.value)}/></label></>}{auth==='bearer'&&<label className="field-label">Bearer Token<input required type="password" autoComplete="new-password" value={value.token} onChange={e=>set('token',e.target.value)}/></label>}</>}
 <p className="settings-note">端点不包含用户名、密码或查询参数。此版本保存资源配置并支持会话引用，专用连接、查询和操作工具后续提供；保存时不测试连接。</p>
 </>}
 <p className="settings-note">凭据仅保存在当前 Lake Home 的私有 secrets 文件中，不回填页面。</p>
 </fieldset>;
}
