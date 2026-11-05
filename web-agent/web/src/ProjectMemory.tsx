import {useEffect,useState} from "react";
import type {Project} from "../../shared/contracts";
import {api,readableError} from "./api";
import {ProjectMemoryLegacy} from "./ProjectMemoryLegacy";
import {ProjectMemoryGate} from "./ProjectMemoryGate";
export function ProjectMemory({project,onClose}:{project:Project;onClose:()=>void}) {
 const [result,setResult]=useState<{projectId:string;version:number|null;error:string}|null>(null);
 useEffect(()=>{const controller=new AbortController();setResult(null);api.projectMemorySettings(project.id,controller.signal).then(settings=>{if(!controller.signal.aborted)setResult({projectId:project.id,version:settings.memorySchemaVersion??1,error:""})}).catch(err=>{if(!controller.signal.aborted)setResult({projectId:project.id,version:null,error:readableError(err)})});return()=>controller.abort()},[project.id]);
 const current=result?.projectId===project.id?result:null;
 return <ProjectMemoryGate version={current?.version??null} error={current?.error} onClose={onClose}><ProjectMemoryLegacy key={project.id} project={project} onClose={onClose}/></ProjectMemoryGate>;
}
