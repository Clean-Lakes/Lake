import type {CodexAction} from '../../../web-agent/shared/codex-activity';

export type CodexDetail = {displayKind:CodexAction; detail:string; preview?:string};
const privateText=/private[ _-]?key|authorization|bearer\s|(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|oauth|cookie|credential|id_rsa|id_ed25519|\.netrc)|(?:sk-|gh[pousr]_)[a-z\d_-]{10,}|:\/\/[^\s/]+:[^\s/]+@|BEGIN [A-Z ]*KEY|\.env\b|\.ssh\b|\.pem\b|\b(?:printenv|env|set -x)\b/i;
const controls=/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g;
const scrubLine=(s:string)=>s.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').replace(controls,' ').trim();
function label(value:unknown,fallback:string){
  if(typeof value!=='string'||!value.trim())return fallback;
  return privateText.test(value)?'内容已隐藏':scrubLine(value).slice(0,240);
}
export function outputLine(value:unknown){
  if(typeof value!=='string'||!value.trim())return;
  if(privateText.test(value))return '敏感输出已隐藏';
  const last=value.trimEnd().split(/[\r\n]/).filter(Boolean).at(-1);
  if(!last)return;
  return scrubLine(last).slice(0,200);
}
const internal=new Set(['work_finish','work_wait','work_read','recall_task_context','recall_memory','__lake_apply_user_supplement']);

export function codexToolDetail(item:any):CodexDetail|undefined {
  const native=item.type==='commandExecution';
  const action=native&&item.commandActions?.length===1?item.commandActions[0]:undefined;
  const name=String(item.tool??item.type);
  if(internal.has(name))return;
  const args=item.arguments??{};
  if(name==='TaskCreate'||name==='TodoWrite'||name==='work_begin'||name==='work_update'){
    const tasks=Array.isArray(args.todos)?args.todos:Array.isArray(args.items)?args.items:[];
    const current=tasks.find((t:any)=>t?.status==='in_progress')??tasks[0];
    return {displayKind:'task',detail:label(args.subject??args.title??current?.content??current?.title??current,'更新任务计划')};
  }
  if(action?.type==='read'||/^(?:read|read_file)$/i.test(name))
    return {displayKind:'read',detail:label(action?.path??action?.name??args.file_path??args.path,'读取文件')};
  if(item.type==='fileChange'||/^(?:edit|write|edit_file|write_file)$/i.test(name))
    return {displayKind:'edit',detail:label(item.changes?.[0]?.path??args.file_path??args.path,'编辑文件')};
  if(native||/^(?:Bash|shell|terminal_execute_command|exec_command)$/i.test(name)){
    const detail=label(item.command??args.command??args.cmd,'执行命令');
    let result:unknown=item.aggregatedOutput;
    if(detail==='内容已隐藏')return {displayKind:'command',detail};
    if(!native && Array.isArray(item.result?.content)){
      const entry=item.result.content.find((c:any)=>c?.type==='text'&&typeof c.text==='string');
      if(entry && entry.text.length<=131072){
        try {
          const parsed=JSON.parse(entry.text);
          result=typeof parsed==='string'?parsed:parsed?.stdout?.text??parsed?.stdout??parsed?.output??parsed?.stderr?.text;
        }catch{/* Only the structured shell result enters the conversation. */}
      }
    }
    const preview=outputLine(result);
    return {displayKind:'command',detail,...(preview&&{preview})};
  }
  const tool=name==='call_mcp_tool'?args.tool:name;
  const detail=item.server&&item.server!=='lake'?item.server+' / '+tool:tool;
  return {displayKind:'integration',detail:label(detail,'调用工具')};
}

/** Accumulate complete lines before publication. Never expose fragments of a PEM block. */
export class CodexOutputBuffer {
  private tail='';
  private hidden=false;
  private discard=false;
  append(delta:string){
    let last:string|undefined;
    const lines=(this.tail+delta).split(/\r?\n/);
    this.tail=lines.pop()??'';
    for(const line of lines){
      if(/-----BEGIN .*PRIVATE KEY-----/.test(line))this.hidden=true;
      if(this.discard){this.discard=false;}
      else if(this.hidden)last='敏感输出已隐藏';
      else last=outputLine(line)??last;
      if(/-----END .*PRIVATE KEY-----/.test(line))this.hidden=false;
    }
    if(this.tail.length>8192){this.hidden||=/-----BEGIN .*PRIVATE KEY-----/.test(this.tail);this.tail=this.tail.slice(-80);this.discard=true;}
    return last;
  }
}
