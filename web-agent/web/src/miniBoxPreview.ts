import type {AICard,TerminalEntry} from '../../shared/contracts';

export type MiniOutputLine={text:string;count:number;index:number};
export type MiniAnomaly={text:string;context:string;index:number};
export type MiniPreview={lines:MiniOutputLine[];anomalies:MiniAnomaly[];lineCount:number;retainedOnly:boolean};

// Presentation only. Raw records and execution/exit status are never rewritten.
function miniCleanOutput(raw:string):string {
 return raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g,'')
  .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|$)/g,'')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b\[[0-?]*[ -/]*$/g,'').replace(/\x1b[()][0-2A-Z]/g,'')
  .replace(/\x1b[@-_]/g,'')
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
}
export function miniReadableOutput(raw:string):string {return miniCleanOutput(raw).replace(/\r\n/g,'\n').replace(/\r/g,'\n');}
const issue=/(?:\b(?:error|fatal|panic|exception|traceback|failed|failure|denied|timeout|refused|unreachable|OOMKilled|CrashLoopBackOff|ImagePullBackOff)\b|timed\s+out|not\s+found|no\s+such\s+file|segmentation\s+fault|错误|失败|异常|权限不足|拒绝访问|超时|连接中断|(?:password|passphrase|密码)\s*[:：]|\[(?:y\/n|yes\/no)\]|press\s+(?:enter|return))/i;
export function miniAnomalyLine(line:string):boolean {
 const text=line.trim();if(!text)return false;
 try {
  const value=JSON.parse(text) as Record<string,unknown>;
  if(value&&typeof value==='object'&&!Array.isArray(value)){
   if(typeof value.level==='string'&&/^(error|fatal|panic|critical)$/i.test(value.level))return true;
   if(value.error!==undefined&&value.error!==null&&value.error!==false&&value.error!==0&&value.error!=='')return true;
   return ['message','msg','detail'].some(key=>typeof value[key]==='string'&&miniAnomalyLine(value[key] as string));
  }
 }catch{/* Non-JSON output follows the same conservative text rule. */}
 return issue.test(text.replace(/\b(?:no\s+errors?|0\s+(?:errors?|failures?)|(?:errors?|failures?|failed)\s*[:=]\s*0)\b/gi,''));
}
export function miniPreview(output:string):MiniPreview {
 const cleaned=miniCleanOutput(output).replace(/\r\n/g,'\n');
 const raw=cleaned.split(/[\n\r]/);const separators=cleaned.match(/[\n\r]/g)??[];
 const lines:MiniOutputLine[]=[];const anomalies:MiniAnomaly[]=[];
 const contexts:string[]=[];let next='';for(let i=raw.length-1;i>=0;i--){contexts[i]=next;if(raw[i]!.trim())next=raw[i]!;}
 raw.forEach((text,index)=>{
  if(!text.trim())return;
  if(miniAnomalyLine(text))anomalies.push({text,context:contexts[index]===text?'':contexts[index]??'',index});
  const last=lines.at(-1);
  if(last?.text===text){last.count++;last.index=index;}
  else if(separators[index-1]==='\r'&&last&&last.index===index-1&&!miniAnomalyLine(last.text)&&!miniAnomalyLine(text))lines[lines.length-1]={text,count:1,index};
  else lines.push({text,count:1,index});
 });
 return {lines,anomalies,lineCount:raw.filter(line=>line.trim()).length,retainedOnly:new TextEncoder().encode(output).length>=32764};
}
export function retainMiniPreview(previous:{output:string;preview:MiniPreview}|undefined,output:string):MiniPreview {
 if(previous?.output===output)return previous.preview;
 const preview=miniPreview(output);
 if(previous&&(previous.preview.retainedOnly||!output.startsWith(previous.output))){
  const pinned=new Map<string,MiniAnomaly>();
  for(const anomaly of [...previous.preview.anomalies,...preview.anomalies])if(!pinned.has(anomaly.text)||!pinned.get(anomaly.text)!.context)pinned.set(anomaly.text,anomaly);
  preview.anomalies=[...pinned.values()];
  preview.retainedOnly=true;
 }
 return preview;
}
export function miniPreviewRows(preview:MiniPreview,pinned:MiniAnomaly|undefined):Array<MiniOutputLine&{anomaly?:boolean}> {
 if(!pinned)return preview.lines.slice(-3);
 const rows:Array<MiniOutputLine&{anomaly?:boolean}>=[{text:pinned.text,count:1,index:pinned.index,anomaly:true}];
 if(pinned.context)rows.push({text:pinned.context,count:1,index:pinned.index+1});
 const remaining=3-rows.length;
 return [...rows,...preview.lines.filter(line=>!rows.some(row=>row.text===line.text)).slice(-remaining)];
}
export function miniRecordedEntry(card:AICard|undefined):Pick<TerminalEntry,'id'|'command'|'output'|'exitCode'|'status'|'stopRequestedAt'>|undefined {
 if(!card)return;
 const args=(card.data as {arguments?:{command?:unknown}}|undefined)?.arguments;
 let command=typeof args?.command==='string'?args.command:'';let output=card.content??'',exitCode:number|null=null;
 try {
  const result=JSON.parse(output);
  const check=Array.isArray(result.checks)?result.checks.at(-1):result;
  if(check&&typeof check==='object'){
   if(typeof check.command==='string')command=check.command;
   if(typeof check.output==='string')output=check.output;
   if(typeof check.exitCode==='number')exitCode=check.exitCode;
   else if(typeof check.exit_code==='number')exitCode=check.exit_code;
  }
 }catch{/* The recorded output is still readable when no structured result exists. */}
 return {id:card.id,command,output,exitCode,status:exitCode!==null?'completed':card.status==='running'?'running':card.status==='failed'||card.status==='interrupted'?'unknown':'completed'};
}

export function miniExecutionStatus({entry,card,stale,stopping,active,anomalies,dispatching}:{entry:ReturnType<typeof miniRecordedEntry>;card:AICard|undefined;stale:boolean;stopping:boolean;active:boolean;anomalies:number;dispatching:boolean}):string {
 if(stale)return '连接暂时中断';
 if(stopping)return entry?.status==='running'?'正在终止…':'用户已终止 · 结果待核查';
 if(dispatching)return '等待命令派发';
 if(entry?.status==='unknown')return '结果待核查';
 if(entry?.status==='completed'&&entry.exitCode!=null)return entry.exitCode!==0?'执行失败':anomalies?'命令已退出 · 有异常线索':'已完成';
 if(active)return 'AI 正在执行';
 if(entry?.status==='running')return '命令仍在运行';
 if(entry&&card?.status!=='pending')return entry.exitCode===null?'退出状态待核查':'记录输出';
 return card?.status==='running'?'等待命令派发':card?.status==='pending'?'等待确认':card?.status==='failed'?'执行失败':'记录输出';
}

export function miniRecordedEntries(cards:AICard[]):Array<NonNullable<ReturnType<typeof miniRecordedEntry>>> {
 return cards.flatMap(card=>{
  try {
   const result=JSON.parse(card.content??'');
   if(Array.isArray(result.checks)&&result.checks.length)return result.checks.flatMap((check:unknown,index:number)=>{
    const entry=miniRecordedEntry({...card,id:`${card.id}:check:${index}`,content:JSON.stringify(check)});return entry?[entry]:[];
   });
  }catch{/* Keep unstructured records readable too. */}
  const entry=miniRecordedEntry(card);return entry?[entry]:[];
 });
}
