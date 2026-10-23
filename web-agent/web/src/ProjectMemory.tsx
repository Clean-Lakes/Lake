import {useEffect,useState} from "react";
import type {Project,Resource} from "../../shared/contracts";
import {api,readableError} from "./api";
import {ProjectMemoryLegacy} from "./ProjectMemoryLegacy";
import {ProjectMemoryV2} from "./ProjectMemoryV2";
export function ProjectMemory({project,resources=[],onClose,onOpenSource}:{project:Project;resources?:Resource[];onClose:()=>void;onOpenSource?:(sessionId:string,turnId?:string)=>void}) {
 const [version,setVersion]=useState(0);const [error,setError]=useState("");
 useEffect(()=>{const controller=new AbortController();setVersion(0);setError("");api.projectMemorySettings(project.id,controller.signal).then(settings=>{if(!controller.signal.aborted)setVersion(settings.memorySchemaVersion||1)}).catch(err=>{if(!controller.signal.aborted)setError(readableError(err))});return()=>controller.abort()},[project.id]);
 if(version===2)return <ProjectMemoryV2 key={project.id} project={project} resources={resources} onClose={onClose} onOpenSource={onOpenSource}/>;
 if(version===1)return <ProjectMemoryLegacy key={project.id} project={project} onClose={onClose}/>;
 return <div className="modal-scrim"><section className="modal" role="dialog" aria-modal="true" aria-label="项目记忆"><p role="status">{error||"正在读取项目记忆…"}</p><button className="button secondary" onClick={onClose}>关闭</button></section></div>;
}
