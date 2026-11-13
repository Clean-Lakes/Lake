/** Redact structured model/tool values without corrupting numeric metadata or
 * JSON syntax. Keep schema keys, primitives and Date values; redact string
 * values before serialization, including Error messages and causes.
 * Redact model values without turning Error instances into empty records.
 * The SDK uses non-enumerable messages/causes and error brands to classify
 * failures. Keep descriptors and prototypes; never mutate the provider error. */
export function redactModelValue<T>(value:T, redact:(text:string)=>string, seen=new WeakMap<object,unknown>()):T {
  if(typeof value==='string')return redact(value) as T;
  if(!value||typeof value!=='object'||value instanceof Date)return value;
  if(seen.has(value))return seen.get(value) as T;
  if(value instanceof Error){
    const result=new Error(redact(value.message));Object.setPrototypeOf(result,Object.getPrototypeOf(value));seen.set(value,result);
    for(const key of Reflect.ownKeys(value)){
      const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
      if('value' in descriptor)Object.defineProperty(result,key,{...descriptor,value:redactModelValue(descriptor.value,redact,seen)});
      else if(key==='stack')Object.defineProperty(result,key,{configurable:true,enumerable:false,writable:true,value:redact(String(value.stack??''))});
    }
    // DOMException's name/code are prototype accessors backed by private slots.
    // Snapshot them from the original so a cloned AbortError stays readable.
    for(const key of ['name','code'] as const)if(!Object.hasOwn(result,key)&&key in value)
      Object.defineProperty(result,key,{configurable:true,writable:true,value:redactModelValue((value as any)[key],redact,seen)});
    return result as T;
  }
  const result:any=Array.isArray(value)?[]:{};seen.set(value,result);
  for(const [key,item] of Object.entries(value))Object.defineProperty(result,key,{configurable:true,enumerable:true,writable:true,value:redactModelValue(item,redact,seen)});
  return result;
}

/** Tool arguments are JSON text inside the approval schema. Redact their
 * values before serializing, and keep legacy invalid text displayable. */
export function redactJSONText(value:string,redact:(text:string)=>string):string {
  let parsed:unknown;
  try{parsed=JSON.parse(value);}catch{return redact(value);}
  return JSON.stringify(redactModelValue(parsed,redact));
}

const generic=/^(?:Turn execution failed|Model request failed|Model stream failed|Unknown error)\.?$/i;
const record=(value:unknown):Record<string,any>=>value&&typeof value==='object'?value as Record<string,any>:{};
export type TurnFailure={message:string;source?:string;code?:string;statusCode?:number;phase?:string;retryable?:boolean};

/** A bounded public projection, never a serialization of request headers,
 * response bodies, stacks or the whole exception. */
export function describeTurnFailure(error:unknown,redact:(text:string)=>string):TurnFailure {
  const frames:Record<string,any>[]=[],seen=new Set<object>();let current=error;
  for(let depth=0;depth<12&&current&&typeof current==='object'&&!seen.has(current);depth++){
    seen.add(current);const frame=record(current);frames.push(frame);current=frame.cause??frame.lastError??frame.error;
  }
  const messages=frames.flatMap(frame=>[frame.message,record(frame.data).message]).filter((value):value is string=>typeof value==='string'&&!!value.trim());
  if(typeof error==='string')messages.unshift(error);
  const text=messages.find(message=>!generic.test(message.trim()));
  const result:TurnFailure={message:''};
  for(const frame of frames){
    const context={...record(frame.context),...record(frame.attribution),...record(record(frame.data).attribution)};
    if(!result.source&&['provider','network','runtime','tool'].includes(context.source))result.source=context.source;
    if(!result.phase&&['prepare','configuration','connect','response','stream','parse','validation','unhandled'].includes(context.errorPhase))result.phase=context.errorPhase;
    const status=context.statusCode??frame.statusCode;
    if(result.statusCode===undefined&&Number.isInteger(status)&&status>=100&&status<=599)result.statusCode=status;
    const code=context.providerCode??frame.code??record(frame.data).code;
    if(!result.code&&typeof code==='string')result.code=redact(code).slice(0,160);
    if(result.retryable===undefined&&typeof context.retryable==='boolean')result.retryable=context.retryable;
  }
  const model=['provider','network'].includes(result.source??'')||result.code?.startsWith('model_');
  result.message=redact(text?`${model?'模型调用失败：':''}${text.trim()}`:
    model?result.statusCode===401||result.statusCode===403?'模型服务认证失败，请检查当前供应商配置。':
      result.statusCode===429?'模型服务暂时限流，请稍后重试。':
      result.phase==='stream'?'接收模型响应时失败，本轮未完成。请稍后重试。':'模型调用失败，本轮未完成。请查看执行详情。':
      '本轮执行失败，尚未完成。请查看执行详情。').slice(0,2048);
  return result;
}
