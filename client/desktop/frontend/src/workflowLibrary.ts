export type WorkflowLibraryEntry = {
  kind: 'folder' | 'v1' | 'v2'
  id: string
  lake_id: string
  lake: string
  parent_id: string
  position: number
  name: string
  description: string
  enabled: boolean
}

export type WorkflowLibrary = { entries: WorkflowLibraryEntry[]; created_id?: string }
export type WorkflowLibraryRequest = { action: 'list' | 'create_folder' | 'rename_folder' | 'delete_folder' | 'move'; lake?: string; kind?: string; id?: string; name?: string; parent_id?: string; before_kind?: string; before_id?: string }
export type WorkflowDropEdge = 'before' | 'inside' | 'after'
export const workflowEntryKey = (entry: WorkflowLibraryEntry) => `${entry.kind}:${entry.id}`

export function workflowChildren(entries: WorkflowLibraryEntry[], lakeID: string, parentID: string): WorkflowLibraryEntry[] {
  // The server returns the persisted order, including unfiled legacy definitions.
  return entries.filter(entry => entry.lake_id === lakeID && entry.parent_id === parentID)
}

export function canMoveWorkflow(entries: WorkflowLibraryEntry[], moving: WorkflowLibraryEntry, lakeID: string, parentID: string): boolean {
  if (moving.lake_id !== lakeID) return false
  const visited = new Set<string>()
  let parent = parentID
  while (parent) {
    if (visited.has(parent) || (moving.kind === 'folder' && moving.id === parent)) return false
    visited.add(parent)
    const folder = entries.find(entry => entry.kind === 'folder' && entry.id === parent && entry.lake_id === lakeID)
    if (!folder) return false
    parent = folder.parent_id
  }
  return true
}

export function workflowDropRequest(entries: WorkflowLibraryEntry[], moving: WorkflowLibraryEntry, target: WorkflowLibraryEntry, edge: WorkflowDropEdge): WorkflowLibraryRequest | null {
  if (workflowEntryKey(moving) === workflowEntryKey(target) || (edge === 'inside' && target.kind !== 'folder')) return null
  const parentID = edge === 'inside' ? target.id : target.parent_id
  if (!canMoveWorkflow(entries, moving, target.lake_id, parentID)) return null
  let before: WorkflowLibraryEntry | undefined
  if (edge === 'before') before = target
  if (edge === 'after') {
    const siblings = workflowChildren(entries, target.lake_id, parentID).filter(entry => workflowEntryKey(entry) !== workflowEntryKey(moving))
    before = siblings[siblings.findIndex(entry => workflowEntryKey(entry) === workflowEntryKey(target)) + 1]
  }
  return { action: 'move', lake: moving.lake, kind: moving.kind, id: moving.id, parent_id: parentID, before_kind: before?.kind, before_id: before?.id }
}
