import type {CodexAction} from '../../../web-agent/shared/codex-activity';

export type CodexDetail = {displayKind:CodexAction; detail:string; preview?:string; suppressOutput?:boolean};
const privateText=/private[ _-]?key|authorization|bearer\s|(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|oauth|cookie|credential|id_rsa|id_ed25519|\.netrc)|(?:sk-|gh[pousr]_)[a-z\d_-]{10,}|:\/\/[^\s/]+:[^\s/]+@|BEGIN [A-Z ]*KEY|\.env\b|\.ssh\b|\.pem\b|\b(?:printenv|env|set -x)\b/i;
const credentialOption=/(?:^|\s)(?:--user|--pass|--password|--token|--api-key)(?:[=\s])|\bcurl\b[^\n]*?\s-u\s|\b(?:sshpass\s+-p|redis-cli\s+-a|mysql\s+-p\S)|\bBasic\s+[A-Za-z\d+/=]{6,}/i;
const privateCommand=(value:string)=>privateText.test(value)||credentialOption.test(value);
const controls=/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g;
const scrubLine=(s:string)=>s.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').replace(controls,' ').trim();
function label(value:unknown,fallback:string){
  if(typeof value!=='string'||!value.trim())return fallback;
  return privateText.test(value)?'内容已隐藏':scrubLine(value).slice(0,240);
}
const masked='[已脱敏]';
export const commandLimit=32768;

// Preserve line breaks and redact before taking an excerpt, including keys spanning multiple lines.
export function publicCommand(value:unknown,redact:(text:string)=>string=text=>text){
  if(typeof value!=='string'||!value.trim())return '执行命令';
  const clean=redact(value).replace(/\r\n?/g,'\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')
    .replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'').trim();
  let result=clean.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gi,masked)
    .replace(/(["'])Authorization:\s*[^'"\\\r\n]*\1(?=\s|$|[|;&])/gi,(_,quote:string)=>quote+'Authorization: '+masked+quote)
    .replace(/\b(?:sk-|gh[pousr]_)[a-z\d_-]{10,}/gi,masked)
    .replace(/(\b[a-z][a-z\d+.-]{0,30}:\/\/)[^\s/@]+:[^\s/@]+@/g,'$1'+masked+'@');
  if(privateCommand(result)){
    const shown:string[]=[];
    let pythonEnd:string|undefined;
    for(const line of result.split('\n')){
      if(line===pythonEnd)pythonEnd=undefined;
      const heredoc=/^\s*python(?:3(?:\.\d+)?)?\s+-\s+<<\s*'([A-Za-z_]\w*)'\s*$/.exec(line);
      if(heredoc)pythonEnd=heredoc[1];
      // Paths and environment variable names in read-only shell commands are public.
      if(!privateCommand(line.replace(/Authorization: \[已脱敏\]/gi,masked))||/^\s*(?:(?:cat|ls|stat|wc)(?:\s+[-\w.~/$]+)+|printenv(?:\s+[A-Z_][A-Z_0-9]*)?|env)\s*$/.test(line)){
        shown.push(line);continue;
      }
      // For an unambiguous one-line assignment, keep the name and later shell arguments.
      const assignment=/^(\s*(?:export\s+)?[A-Za-z_][\w]*=)(?:'[^'\n]*'|"[^"\\\n]*"|[\w.@/+:-]+)(?=\s|$)/.exec(line);
      if(assignment&&privateText.test(assignment[1])&&!privateCommand(line.slice(assignment[0].length))){
        shown.push(assignment[1]+masked+line.slice(assignment[0].length));continue;
      }
      const option=/^(.*?)(--(?:[\w-]*(?:token|password|secret)|api-key)(?:=|\s+))(?:'[^']*'|"[^"\\]*"|[\w.@/+:-]+)(?=\s|$)(.*)$/i.exec(line);
      if(option&&!privateCommand(option[1]+option[3])){
        shown.push(option[1]+option[2]+masked+option[3]);continue;
      }
      // A complete Python assignment inside a literal heredoc ends on this
      // line. Mask its expression and keep the following independent statements.
      const python=pythonEnd&&/^(\s*[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s*=\s*)(.+)$/.exec(line);
      if(python&&!/['"]{3}|\\\s*$/.test(python[2])){
        const syntax=python[2].replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g,'').split('#')[0]!;
        const closing:Record<string,string>={'(':')','[':']','{':'}'};
        const expected:string[]=[];
        let complete=!/['"]/.test(syntax);
        for(const char of syntax){
          if(closing[char])expected.push(closing[char]);
          else if(')]}'.includes(char)&&expected.pop()!==char)complete=false;
        }
        if(complete&&!expected.length){
          shown.push(python[1]+masked);
          continue;
        }
      }
      // Other shell and embedded-language expressions may continue on subsequent
      // lines. Keep completed lines and the executable, never fragments of a value.
      const executable=/^\s*(curl|ssh|mysql|redis-cli|python3?|bash|sh|env|docker|git|kubectl|openssl)\b/.exec(line);
      shown.push(executable?executable[1]+' '+masked:masked);
      break;
    }
    result=shown.join('\n');
  }
  return result.length<=commandLimit?result:result.slice(0,commandLimit-1)+'…';
}

export function outputLine(value:unknown){
  if(typeof value!=='string'||!value.trim())return;
  if(privateText.test(value))return '敏感输出已隐藏';
  const last=value.trimEnd().split(/[\r\n]/).filter(Boolean).at(-1);
  if(!last)return;
  return scrubLine(last).slice(0,200);
}
const internal=new Set(['work_finish','work_wait','work_read','recall_task_context','recall_memory','__lake_apply_user_supplement']);

export function codexToolDetail(item:any,redact?:(text:string)=>string):CodexDetail|undefined {
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
  if(action?.type==='read'||/^(?:read|read_file)$/i.test(name)){
    const path=action?.path??action?.name??args.file_path??args.path;
    const detail=label(path,'读取文件');
    return {displayKind:'read',detail,suppressOutput:true};
  }
  if(item.type==='fileChange'||/^(?:edit|write|edit_file|write_file)$/i.test(name))
    return {displayKind:'edit',detail:label(item.changes?.[0]?.path??args.file_path??args.path,'编辑文件')};
  if(native||/^(?:Bash|shell|terminal_execute_command|exec_command)$/i.test(name)){
    const command=item.command??args.command??args.cmd;
    const detail=publicCommand(command,redact);
    let result:unknown=item.aggregatedOutput;
    if(typeof command!=='string'||!command.trim()||privateCommand(command))return {displayKind:'command',detail,suppressOutput:true};
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
