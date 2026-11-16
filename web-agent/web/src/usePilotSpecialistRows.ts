import {useCallback,useLayoutEffect,useRef,useState} from 'react';
import type {Message,SuperWorkspace} from '../../shared/contracts';
import {continuousPilotDispatchRows,pilotSpecialistBinding,type PilotSpecialistRow} from './pilotSpecialistReplies';

/** Cache only committed, exactly bound slots. Missing workspaces/workers clear it. */
export function usePilotSpecialistRows(workspace:SuperWorkspace|null|undefined,sessionId:string,messages:Message[]){
 const previous=useRef<PilotSpecialistRow[]>([]),observedRoots=useRef(new Map<string,string>());
 const [,setObservedRevision]=useState(0);
 const rows=continuousPilotDispatchRows(previous.current,workspace,sessionId,messages,observedRoots.current);
 const onObservedTurn=useCallback((row:PilotSpecialistRow,root:string)=>{
  const binding=pilotSpecialistBinding(row);
  if(!root||observedRoots.current.get(binding)===root)return;
  // Publish root changes once so an already-arrived report is adopted and its
  // standalone copy filtered together, without waiting for another snapshot.
  observedRoots.current.set(binding,root);setObservedRevision(revision=>revision+1);
 },[]);
 useLayoutEffect(()=>{
  previous.current=rows;
  const current=new Set(rows.map(pilotSpecialistBinding));
  for(const key of observedRoots.current.keys())if(!current.has(key))observedRoots.current.delete(key);
 });
 return {rows,onObservedTurn};
}
