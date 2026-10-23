import type {WorkSession} from '../../shared/contracts';

export function sortSessionNavigation(sessions:WorkSession[]) {
 return [...sessions].sort((a,b)=>{
  if(!!a.pinned!==!!b.pinned)return a.pinned?-1:1;
  if((a.navigationPosition===undefined)!==(b.navigationPosition===undefined))return a.navigationPosition===undefined?-1:1;
  if(a.navigationPosition!==undefined&&b.navigationPosition!==undefined&&a.navigationPosition!==b.navigationPosition)return a.navigationPosition-b.navigationPosition;
  return b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id);
 });
}

/** Drop relative to the full group, including older rows hidden by the recent limit. */
export function sessionDropBefore(sessions:WorkSession[],source:string,target:string,after:boolean) {
 const rows=sessions.filter(session=>session.id!==source);
 const index=rows.findIndex(session=>session.id===target);
 return index<0?null:rows[index+(after?1:0)]?.id??null;
}
