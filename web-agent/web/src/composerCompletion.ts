export const completionDelay=650;
const commonPrompts=[
 "帮我检查服务运行状态，分析异常原因并给出处理建议。",
 "帮我查看 CPU、内存和磁盘使用情况。",
 "请分析这段日志，找出错误原因和排查步骤。",
 "请帮我排查服务无法访问的原因。",
];
export function completionEligible(value:string,start:number,end:number,focused:boolean,composing:boolean,blocked:boolean):boolean {
 const length=Array.from(value.trim()).length;
 return focused&&!composing&&!blocked&&start===value.length&&end===value.length&&length>=4&&length<=2000&&!/[。！？.!?]\s*$/.test(value)&&!value.endsWith("\n")&&!/-----BEGIN|(?:api[_-]?key|password|secret|token)\s*[:=]/i.test(value);
}
export function validCompletion(suffix:unknown):suffix is string {
 return typeof suffix==="string"&&suffix.trim().length>0&&Array.from(suffix).length<=120&&!/[\r\n\x00@]/.test(suffix);
}
export function localCompletion(value:string,history:string[]):string {
 const candidates=[...history.slice(-8).reverse(),...commonPrompts];
 for(const candidate of candidates) {
  if(candidate.length>320||/[\r\n@]|-----BEGIN|(?:api[_-]?key|password|secret|token)\s*[:=]/i.test(candidate)||!candidate.toLocaleLowerCase().startsWith(value.toLocaleLowerCase())) continue;
  const suffix=Array.from(candidate.slice(value.length)).slice(0,80).join("");
  if(validCompletion(suffix)) return suffix;
 }
 return "";
}
