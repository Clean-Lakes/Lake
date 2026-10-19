import {DisclosureSummary} from './DisclosureSummary';
import type {AIApproval,TextFileAttachment} from '../../shared/contracts';
import {Glyph} from './Icons';
import {fileSize} from './fileAttachments';

export function attachmentApprovalInfo(approval:AIApproval,attachments:TextFileAttachment[]=[]){
 let args:Record<string,unknown>;
 try {args=JSON.parse(approval.call.arguments)} catch {return null}
 if(!args||typeof args!=='object'||Array.isArray(args)||typeof args.path!=='string'||!args.path.trim())return null;
 const file=attachments.find(file=>file.sourceId===args.source_id);
 return {args,file,path:args.path,overwrite:args.overwrite===true,container:args.runtime==='container'&&typeof args.container_id==='string'?args.container_id:undefined};
}

export function AttachmentApproval({approval,attachments,confirmation,onConfirmation,busy,error,remaining=0,onDecide}:{
 approval:AIApproval;attachments?:TextFileAttachment[];confirmation:string;onConfirmation:(value:string)=>void;
 busy:boolean;error:string;remaining?:number;onDecide:(accept:boolean)=>void;
}){
 const info=attachmentApprovalInfo(approval,attachments);
 if(!info)return null;
 const {file,path,overwrite,container}=info;
 return <section className="attachment-approval" aria-label="文件上传确认">
  <header><Glyph name="lakeConfirm" size={18}/><div><strong>上传文件</strong><p>将附件保存到目标位置</p></div><span>等待确认</span></header>
  <div className="attachment-approval-file"><span className="attachment-approval-file-icon"><Glyph name="document" size={21}/></span><div><strong>{file?.name||'所选附件'}</strong>{fileSize(file?.sizeBytes)&&<small>{fileSize(file?.sizeBytes)}</small>}</div></div>
  <dl className="attachment-approval-destination"><div><dt>目标</dt><dd>{approval.target}</dd></div>{container&&<div><dt>容器</dt><dd>{container}</dd></div>}<div><dt>保存到</dt><dd className="attachment-approval-path">{path}</dd></div></dl>
  <p className={`attachment-approval-effect${overwrite?' is-overwrite':''}`}><Glyph name={overwrite?'alert':'shield'} size={14}/>{overwrite?'若存在同名文件，将覆盖原文件。':'同名文件不会被覆盖。'}</p>
  <details className="attachment-approval-details"><DisclosureSummary>技术参数</DisclosureSummary><pre>{JSON.stringify(info.args,null,2)}</pre></details>
  {approval.confirmation&&<label className="attachment-approval-confirmation">请输入“{approval.confirmation}”确认目标<input value={confirmation} onChange={event=>onConfirmation(event.target.value)} autoComplete="off"/></label>}
  {error&&<p className="attachment-approval-error" role="alert">{error}</p>}
  <footer><small>{remaining>1?`${remaining} 项操作待确认`:'本次仅上传文件'}</small><div><button type="button" className="button secondary" disabled={busy} onClick={()=>onDecide(false)}>取消</button><button type="button" className="button primary" disabled={busy||!!approval.confirmation&&confirmation!==approval.confirmation} onClick={()=>onDecide(true)}>{busy?'处理中…':overwrite?'覆盖并上传':'上传文件'}</button></div></footer>
 </section>;
}
