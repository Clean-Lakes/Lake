import type {SRETask} from '../../shared/contracts';
import {sreNeedsVerification} from './sreOperationPolicy';
export function sreTaskInFlight(task:SRETask){return !!task.attempts?.some(a=>a.operations?.some(op=>op.status==='dispatched'||sreNeedsVerification(op)))}
export function sreTaskOwnsTurn(task:SRETask,startedAt?:string){
 if(sreTaskInFlight(task)||['active','waiting_approval'].includes(task.status))return true;
 const start=Date.parse(startedAt??''),updated=Date.parse(task.updatedAt);
 return !Number.isFinite(start)||!Number.isFinite(updated)||updated>=start;
}
