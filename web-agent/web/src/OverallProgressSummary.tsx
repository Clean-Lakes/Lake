import {useEffect,useState} from 'react';
import type {OverallProgress} from './overall-progress-model';
import {api} from './api';

/** A single semantic summary, generated from authoritative current-turn records.
 * Resource paragraphs stay in their resource rows; they are never quoted here. */
export function OverallProgressSummary({summary,session,turnStartedAt,live=false}:{summary:OverallProgress;session?:string;turnStartedAt?:string;live?:boolean}){
 const scope=`${session??''}:${turnStartedAt??''}`;
 const [result,setResult]=useState({scope:'',text:''});
 const revision=JSON.stringify([summary.facts,summary.activity,summary.latest?.id,summary.latest?.card?.content,summary.latest?.message?.text]);
 useEffect(()=>{
  if(!live||!session||!turnStartedAt)return;
  let disposed=false;let timer:ReturnType<typeof setTimeout>;
  const update=async()=>{
   let delay=10000;
   try{
    const response=await api.progressSummary(session,turnStartedAt);
    if(disposed)return;
    if(response.text)setResult({scope,text:response.text});
    if(response.pending)delay=2000;
   }catch{/* Keep the last synthesis during a transient failure; never copy stage prose. */}
   if(!disposed)timer=setTimeout(()=>void update(),delay);
  };
  timer=setTimeout(()=>void update(),1000);
  return()=>{disposed=true;clearTimeout(timer);};
 },[scope,session,turnStartedAt,live,revision]);
 const text=result.scope===scope?result.text:'';
 return <div className="resource-stage-summary is-overall" aria-label="本轮进度">
  <p className="overall-progress-facts">{text||summary.activity}</p>
 </div>;
}
