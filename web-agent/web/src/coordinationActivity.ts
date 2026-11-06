import type {AICard} from '../../shared/contracts';

// Exact host coordination tools do not execute a resource operation. Preserve
// every card for inspection, including exceptional states that need attention.
const coordinationTools=new Set([
 'list_specialists','manage_specialist','search_super_tasks','route_work','read_super_object',
 'work_begin','work_read','work_update','work_wait','work_finish','recall_task_context','recall_memory','__lake_apply_user_supplement',
]);
const normal=new Set(['running','completed','succeeded','success']);
export function quietCoordination(card:AICard):boolean {
 return card.type==='operation'&&coordinationTools.has(card.title??'')&&normal.has(card.status);
}
