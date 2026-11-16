import {useCallback,useLayoutEffect,useRef} from 'react';
import type {Message,SuperWorkspace} from '../../shared/contracts';
import {continuousPilotDispatchRows,pilotSpecialistBinding,type PilotSpecialistRow} from './pilotSpecialistReplies';

/** Cache only committed, exactly bound slots. Missing workspaces/workers clear it. */
export function usePilotSpecialistRows(workspace:SuperWorkspace|null|undefined,sessionId:string,messages:Message[]){
 const previous=useRef<PilotSpecialistRow[]>([]),observedRoots=useRef(new Map<string,string>());
 const rows=continuousPilotDispatchRows(previous.current,workspace,sessionId,messages,observedRoots.current);
 const onObservedTurn=useCallback((row:PilotSpecialistRow,root:string)=>{
  // Snapshot observation needs no parent render. The next workspace or report
  // refresh will use this exact SDK root, including an otherwise empty reply.
  if(root)observedRoots.current.set(pilotSpecialistBinding(row),root);
 },[]);
 useLayoutEffect(()=>{
  previous.current=rows;
  const current=new Set(rows.map(pilotSpecialistBinding));
  for(const key of observedRoots.current.keys())if(!current.has(key))observedRoots.current.delete(key);
 });
 return {rows,onObservedTurn};
}
