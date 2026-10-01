export const UI_CATALOG = 'com.cleanlakes.lake:catalog-v1'
export type UISnapshot = { surfaceId: string; catalogId: string; revision: number; kind?: '' | 'ports'; components: Record<string, unknown>[]; data: Record<string, unknown>; deleted?: boolean }
export type UIAction = { surfaceId: string; sourceComponentId: string; name: string; context: Record<string, unknown>; revision: number }
const identifier = /^[A-Za-z0-9_-]{1,96}$/
const fields: Record<string, string[]> = {
 Column: ['children'], Row: ['children'], Card: ['title', 'children'], Tabs: ['labels', 'children', 'active'], Text: ['text', 'variant'],
 Markdown: ['text'], Code: ['text', 'label', 'language'], List: ['label', 'items', 'ordered', 'start'],
 Metric: ['label', 'value'], Chart: ['label', 'values', 'unit', 'max'], Button: ['label', 'action'], ChoicePicker: ['label', 'value', 'options'], TextField: ['label', 'value'], Table: ['columns', 'headers', 'rows', 'label', 'action'], Log: ['label', 'text'],
}
function validData(value: unknown, depth = 0): boolean {
 if (depth > 8) return false
 if (value === null || typeof value === 'boolean' || typeof value === 'number') return true
 if (typeof value === 'string') return value.length <= 16384
 if (Array.isArray(value)) return value.length <= 200 && value.every(item => validData(item, depth + 1))
 if (value && typeof value === 'object') return Object.entries(value).length <= 64 && Object.entries(value).every(([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && key.length <= 96 && validData(item, depth + 1))
 return false
}
export function parseUISnapshot(input: unknown): UISnapshot | null {
 try {
  const value = typeof input === 'string' ? JSON.parse(input) : input
  if (!value || typeof value !== 'object' || JSON.stringify(value).length > 48 * 1024 || !identifier.test(value.surfaceId) || value.catalogId !== UI_CATALOG || !Number.isSafeInteger(value.revision) || value.revision < 1 || !['', 'ports'].includes(value.kind ?? '')) return null
  if (value.deleted === true) return value as UISnapshot
  if (!Array.isArray(value.components) || value.components.length > 64 || !value.data || Array.isArray(value.data) || !validData(value.data)) return null
  const nodes = new Map<string, Record<string, unknown>>()
  for (const component of value.components) {
   if (!component || typeof component !== 'object' || !identifier.test(component.id) || nodes.has(component.id) || !fields[component.component]) return null
   for (const [key, item] of Object.entries(component)) {
    if (!['id', 'component', ...fields[component.component]].includes(key) || !validData(item)) return null
    if (key === 'action') {
     const action = item as { event?: { name?: string } }
     if (!action.event || !['continue', ...(value.kind === 'ports' ? ['inspect_ports', 'inspect_process'] : [])].includes(action.event.name ?? '')) return null
    }
   }
   nodes.set(component.id, component)
  }
  if (nodes.size && !nodes.has('root')) return null
  const visit = (id: string, ancestors: Set<string>): boolean => {
   const node = nodes.get(id)
   if (!node || ancestors.has(id) || ancestors.size >= 8) return false
   const children = node.children ?? []
   return Array.isArray(children) && children.every(child => typeof child === 'string' && visit(child, new Set([...ancestors, id])))
  }
  if ([...nodes.keys()].some(id => !visit(id, new Set()))) return null
  return value as UISnapshot
 } catch { return null }
}
export function upsertUISurface<T extends { id: string; role: string; ui?: UISnapshot }>(messages: T[], snapshot: UISnapshot, create: (ui: UISnapshot) => T): T[] {
 const index = messages.findIndex(message => message.ui?.surfaceId === snapshot.surfaceId)
 if (index >= 0 && (messages[index].ui?.revision ?? 0) >= snapshot.revision) return messages
 if (snapshot.deleted) return messages.filter(message => message.ui?.surfaceId !== snapshot.surfaceId)
 if (index < 0) return [...messages, create(snapshot)]
 return messages.map((message, i) => i === index ? { ...message, ui: snapshot } : message)
}
