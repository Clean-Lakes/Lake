import {useEffect,useRef,useState} from 'react';
import type {TerminalHistory} from '../../shared/contracts';
import {api,ApiRequestError} from './api';
import {miniEntries,type MiniBoxScope} from './miniBoxModel';

export function useMiniBox(scope:MiniBoxScope,resource:string) {
  const key=JSON.stringify([scope.session,resource,scope.startedAt,scope.endedAt]);
  const candidates=JSON.stringify(scope.terminals.filter(term=>term.resourceId===resource&&term.generation).map(({id,generation})=>({id,generation})));
  const commandScope=JSON.stringify(scope.commandScope??null);
  const [state,setState]=useState<{key:string;histories:TerminalHistory[];stale:boolean}>({key:'',histories:[],stale:false});
  const refreshRef=useRef(()=>{});
  useEffect(()=>{
    if(!scope.connected)return;
    const terms=JSON.parse(candidates) as Array<{id:string;generation:string}>;
    const controller=new AbortController();let disposed=false,syncing=false,queued=false;
    const refresh=async()=>{
      if(disposed||document.hidden)return;
      if(syncing){queued=true;return;}
      syncing=true;
      const results=await Promise.allSettled(terms.map(async term=>{
        const history=await api.terminalHistory(scope.session,term.id,controller.signal);
        if(history.terminal.id!==term.id||history.terminal.generation!==term.generation)return null;
        return {...history,output:'',entries:miniEntries(history,scope,resource)};
      }));
      if(!disposed)setState(previous=>({key,stale:results.some(result=>result.status==='rejected'),histories:results.flatMap((result,i)=>{
        if(result.status==='fulfilled')return result.value?.entries.length?[result.value]:[];
        const denied=result.reason instanceof ApiRequestError&&[401,403,404,409].includes(result.reason.status);
        return !denied&&previous.key===key?previous.histories.filter(history=>history.terminal.id===terms[i]!.id&&history.terminal.generation===terms[i]!.generation):[];
      })}));
      syncing=false;if(queued&&!disposed){queued=false;void refresh();}
    };
    refreshRef.current=()=>{void refresh();};void refresh();
    const timer=scope.live?setInterval(()=>void refresh(),650):undefined;
    const visibility=()=>{if(!document.hidden)void refresh();};document.addEventListener('visibilitychange',visibility);
    return()=>{disposed=true;controller.abort();clearInterval(timer);refreshRef.current=()=>{};document.removeEventListener('visibilitychange',visibility);};
  },[key,candidates,scope.live,scope.connected,commandScope]);
  const currentTerminals=JSON.parse(candidates) as Array<{id:string;generation:string}>;
  const histories=state.key===key?state.histories.filter(history=>currentTerminals.some(term=>term.id===history.terminal.id&&term.generation===history.terminal.generation)).map(history=>({...history,entries:miniEntries(history,scope,resource)})).filter(history=>history.entries.length>0):[];
  return {histories,stale:!scope.connected||state.key===key&&state.stale,refresh:()=>refreshRef.current()};
}
