import type {ReasoningSettings} from "../../shared/contracts";

export type ReasoningSaveRequest={session:string;modelId:string;effort:string};
const same=(a:ReasoningSaveRequest|null,b:ReasoningSaveRequest)=>!!a&&a.session===b.session&&a.modelId===b.modelId&&a.effort===b.effort;

/** Serialize writes, coalescing pending slider changes so an old response cannot win. */
export function reasoningSaveQueue(save:(request:ReasoningSaveRequest)=>Promise<ReasoningSettings>,events:{
  busy:(busy:boolean)=>void;
  saved:(request:ReasoningSaveRequest,result:ReasoningSettings,hasNext:boolean)=>void;
  failed:(request:ReasoningSaveRequest,error:unknown,hasNext:boolean)=>void;
}) {
  let active:ReasoningSaveRequest|null=null,pending:ReasoningSaveRequest|null=null;
  let running=false;
  async function flush() {
    try {
      while(pending) {
        const request:ReasoningSaveRequest=pending;pending=null;active=request;
        try {const result=await save(request);events.saved(request,result,pending!==null);}
        catch(error) {events.failed(request,error,pending!==null);}
      }
    } finally {active=null;running=false;events.busy(false);}
  }
  return {
    enqueue(request:ReasoningSaveRequest) {
      if(same(active,request)) {pending=null;return;}
      if(same(pending,request)) return;
      pending=request;
      if(running) return;
      running=true;events.busy(true);void flush();
    },
    get busy() {return running;},
  };
}
