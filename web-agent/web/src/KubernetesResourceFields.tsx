import {useEffect,useRef,useState} from 'react';
import {AppSelect} from './AppSelect';
import {Glyph} from './Icons';
import {api,readableError} from './api';
import {serviceResourceInput,type ServiceDraft} from './serviceResourceModel';

export function KubernetesResourceFields({value,onChange,projectId,disabled}:{value:ServiceDraft;onChange:(value:ServiceDraft)=>void;projectId:string;disabled:boolean}) {
 const [advanced,setAdvanced]=useState(false),[visible,setVisible]=useState(false),[reading,setReading]=useState(false),[testing,setTesting]=useState(false);
 const [error,setError]=useState(''),[result,setResult]=useState<{version:string;message:string}|null>(null);
 const fileInput=useRef<HTMLInputElement>(null),readVersion=useRef(0),testVersion=useRef(0),testAbort=useRef<AbortController|null>(null),latest=useRef(value);
 latest.current=value;
 useEffect(()=>()=>{readVersion.current++;testVersion.current++;testAbort.current?.abort();},[]);
 const invalidate=()=>{readVersion.current++;testVersion.current++;testAbort.current?.abort();setReading(false);setTesting(false);setError('');setResult(null);};
 const set=(patch:Partial<ServiceDraft>)=>{invalidate();onChange({...value,...patch});};
 async function chooseFile(input:HTMLInputElement) {
  const file=input.files?.[0];input.value='';if(!file)return;
  invalidate();const revision=readVersion.current;
  onChange({...value,kubeconfig:'',kubeconfigFileName:''});
  if(!file.size||file.size>1024*1024){setError('请选择非空的 Kubeconfig 文件，最大 1 MB');return;}
  setReading(true);
  try{
   const text=await file.text();if(revision!==readVersion.current)return;
   if(!text.trim()||text.includes('\0'))throw new Error();
   onChange({...latest.current,kubeconfig:text,kubeconfigFileName:file.name});
  }catch{if(revision===readVersion.current)setError('无法读取有效的 Kubeconfig 文件，请重新选择或粘贴内容');}
  finally{if(revision===readVersion.current)setReading(false);}
 }
 async function testConnection() {
  testAbort.current?.abort();const controller=new AbortController();testAbort.current=controller;const revision=++testVersion.current;
  setTesting(true);setError('');setResult(null);
  try{const input=serviceResourceInput('kubernetes',value);const response=await api.testKubernetesResource(projectId,input.settings,controller.signal);if(revision===testVersion.current)setResult(response);}
  catch(cause){if(revision===testVersion.current&&!controller.signal.aborted)setError(readableError(cause));}
  finally{if(revision===testVersion.current)setTesting(false);}
 }
 return <>
  <label className="field-label">认证方式<AppSelect label="Kubernetes 认证方式" value={value.kubeAuthMethod} onChange={e=>{setVisible(false);set({kubeAuthMethod:e.target.value as ServiceDraft['kubeAuthMethod'],kubeconfig:'',kubeconfigFileName:'',token:'',endpoint:'',context:'',namespace:''});}}><option value="kubeconfig">Kubeconfig</option><option value="token">Bearer Token</option></AppSelect></label>
  {value.kubeAuthMethod==='kubeconfig'?<>
   <div className="field-label kubeconfig-file-field">配置文件<div className="kubeconfig-file-row"><input aria-label="Kubeconfig 文件名" readOnly value={value.kubeconfigFileName} placeholder="选择本地 Kubeconfig 文件"/><button type="button" className="button secondary" disabled={disabled||reading} onClick={()=>fileInput.current?.click()}><Glyph name="folder" size={14}/>选择文件…</button></div><input ref={fileInput} type="file" hidden aria-label="选择 Kubeconfig 文件" onChange={e=>void chooseFile(e.currentTarget)}/></div>
   <label className="field-label" htmlFor="resource-kubeconfig">Kubeconfig</label><div className="kubeconfig-editor"><textarea id="resource-kubeconfig" aria-describedby="kubeconfig-upload-note" required maxLength={1024*1024} rows={7} spellCheck={false} autoComplete="off" className={visible?'':'kubeconfig-masked'} placeholder="粘贴 Kubeconfig YAML 或 JSON" value={value.kubeconfig} onChange={e=>set({kubeconfig:e.target.value,kubeconfigFileName:''})}/><button type="button" className="icon-button" aria-label={visible?'隐藏 Kubeconfig':'显示 Kubeconfig'} aria-pressed={visible} onClick={()=>setVisible(!visible)}><Glyph name={visible?'eyeOff':'eye'} size={16}/></button></div>
   <p id="kubeconfig-upload-note" className="settings-note">选择文件会自动填入内容，也可直接粘贴。支持内嵌 Token 或客户端证书的 Kubeconfig，最大 1 MB。</p>
  </>:<><label className="field-label">API Server 地址<input required type="url" value={value.endpoint} onChange={e=>set({endpoint:e.target.value})} placeholder="https://cluster.example.com:6443"/></label><label className="field-label">Bearer Token（可选）<input type="password" autoComplete="new-password" value={value.token} onChange={e=>set({token:e.target.value})}/></label></>}
  {reading&&<p className="settings-note" role="status">正在读取 Kubeconfig…</p>}
  <label className="check-row kubeconfig-advanced-toggle"><input type="checkbox" checked={advanced} onChange={e=>setAdvanced(e.target.checked)}/>显示高级选项</label>
  {advanced&&<div className="kubeconfig-advanced-fields"><label className="field-label">Context（可选）<input value={value.context} onChange={e=>set({context:e.target.value})} placeholder="使用 Kubeconfig 的 current-context"/></label><label className="field-label">命名空间（可选）<input value={value.namespace} onChange={e=>set({namespace:e.target.value})} placeholder="使用 Context 中的命名空间"/></label><label className="field-label">连接超时（秒）<input required type="number" min={1} max={60} step={1} value={value.requestTimeout} onChange={e=>set({requestTimeout:Number(e.target.value)})}/></label><label className="field-label">TLS 证书验证<AppSelect label="Kubernetes TLS 验证" value={value.tlsMode} onChange={e=>set({tlsMode:e.target.value as ServiceDraft['tlsMode']})}><option value="config">遵循 Kubeconfig（Token 方式默认验证）</option><option value="verify">验证证书</option><option value="skip">跳过证书验证（不安全）</option></AppSelect></label></div>}
  <div className="kubeconfig-test-row"><button type="button" className="button secondary" disabled={disabled||reading||testing||(value.kubeAuthMethod==='kubeconfig'?!value.kubeconfig.trim():!value.endpoint.trim())} onClick={()=>void testConnection()}>{testing?'正在测试…':'测试连接'}</button><span className="settings-note">仅点击测试时读取集群版本，保存不会自动连接。</span></div>
  {error&&<p className="form-error" role="alert">{error}</p>}{result&&<p className="settings-note kubeconfig-test-success" role="status">{result.message} · {result.version}</p>}
 </>;
}
