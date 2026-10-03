import { useEffect, useMemo, useState } from 'react';
import { Database, Plus, RefreshCw } from 'lucide-react';
import type { LakeJournalEntry, LakeWorkspaceBinding } from '@zcode/shared';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { usePlatform } from '@/hooks/usePlatform.js';
import { SavedWorkflowsSection } from '@/settings/saved-workflows/SavedWorkflowsSection.js';
import type { ComponentProps } from 'react';
import { useLakeData } from './useLakeData.js';
import { useLakeGlobalWorkflows } from './useLakeGlobalWorkflows.js';

type WorkflowProps = Pick<ComponentProps<typeof SavedWorkflowsSection>, 'onNavigateToLaunchedRun' | 'onCreateViaChat' | 'onOpenWorkflowRun' | 'onOpenWorkflowArtifact'>;

export function LakePanel({ open, onOpenChange, workspacePath, workspaceIdentity, ...workflowProps }: WorkflowProps & {
  open: boolean; onOpenChange: (open: boolean) => void; workspacePath?: string | null; workspaceIdentity?: string;
}) {
  const platform = usePlatform();
  const { overview, error, loading, refresh, mutate, request } = useLakeData();
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState<'resources' | 'workflows' | 'journal'>('resources');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  const [port, setPort] = useState('22');
  const [globalName, setGlobalName] = useState('');
  const [resourceName, setResourceName] = useState('');
  const [journal, setJournal] = useState<LakeJournalEntry[]>([]);
  const [journalError, setJournalError] = useState('');
  const lake = overview.lakes.find(item => item.id === selected) ?? overview.lakes[0];
  const bindings = useMemo(() => overview.bindings.filter(item => item.lakeID === lake?.id), [overview.bindings, lake?.id]);
  const projects = useMemo(() => bindings.map(item => ({ workspacePath: item.workspacePath, workspaceIdentity: item.workspaceIdentity, label: `${item.lakeName} · ${item.workspacePath.split('/').pop()}` })), [bindings]);
  const global = useLakeGlobalWorkflows(open && tab === 'workflows' && bindings.length > 0);
  const globalNames = useMemo(() => overview.workflowLinks.filter(item => item.lakeID === lake?.id && item.scope === 'global').map(item => item.name), [overview.workflowLinks, lake?.id]);
  useEffect(() => {
    setJournal([]); setJournalError('');
    if (!open || tab !== 'journal' || !lake) return;
    let active = true;
    void request({ action: 'journal.list', lakeID: lake.id }).then(result => { if (active) setJournal(result as LakeJournalEntry[]); }).catch(() => { if (active) setJournalError('湖志读取失败'); });
    return () => { active = false; };
  }, [open, tab, lake?.id, request]);
  const enter = (binding: LakeWorkspaceBinding) => {
    workflowProps.onCreateViaChat?.('', binding); onOpenChange(false);
  };
  const bindProject = async () => {
    const path = await platform.selectDirectory();
    if (lake && path) await mutate({ action: 'workspace.bind', lakeID: lake.id, workspacePath: path });
  };
  const closeAfter = <T,>(callback: ((params: T) => void) | undefined) => (params: T) => { callback?.(params); onOpenChange(false); };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex h-[85vh] max-h-[900px] w-[90vw] max-w-6xl flex-col overflow-hidden bg-background">
      <DialogHeader><DialogTitle className="flex items-center gap-2"><Database className="size-5" />LAKE 湖</DialogTitle></DialogHeader>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="选择湖" data-testid="lake-select" value={lake?.id ?? ''} onChange={event => { setSelected(event.target.value); setJournal([]); setTab('resources'); }} className="rounded-md border border-border bg-background px-3 py-2 text-foreground">
          {overview.lakes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <Input aria-label="新湖名称" placeholder="新湖名称" value={name} onChange={event => setName(event.target.value)} className="w-40" />
        <Button disabled={loading || !name.trim()} onClick={() => { void mutate({ action: 'lake.add', name }).then(result => { if (result && 'id' in result) { setSelected(String(result.id)); setName(''); } }); }}><Plus className="size-4" />新建湖</Button>
        <Button variant="ghost" aria-label="刷新湖数据" onClick={() => { void refresh(); }}><RefreshCw className="size-4" /></Button>
      </div>
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      {lake ? <>
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
          {(['resources', 'workflows', 'journal'] as const).map((value, index) => <Button key={value} variant={tab === value ? 'secondary' : 'ghost'} onClick={() => setTab(value)}>{['资源', '工作流', '湖志'][index]}</Button>)}
          <Button variant="outline" disabled={loading} onClick={() => { void bindProject(); }}>关联项目</Button>
          <Button variant="outline" disabled={loading} onClick={() => { void mutate({ action: 'workspace.ensure', lakeID: lake.id }).then(result => { if (result && 'workspacePath' in result) enter(result as LakeWorkspaceBinding); }); }}>进入湖工作空间</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {tab === 'workflows' ? <>
            {bindings.length ? <div className="flex flex-wrap items-center gap-2 py-3">
              <select aria-label="关联全局工作流" value={globalName} onChange={event => setGlobalName(event.target.value)} className="rounded-md border border-border bg-background px-3 py-2 text-foreground">
                <option value="">选择全局工作流</option>{global.names.filter(value => !globalNames.includes(value)).map(value => <option key={value} value={value}>{value}</option>)}
              </select>
              <Button variant="outline" disabled={!globalName || loading} onClick={() => { void mutate({ action: 'workflow.bind', lakeID: lake.id, workspacePath: bindings[0]!.workspacePath, name: globalName, scope: 'global' }).then(result => { if (result) setGlobalName(''); }); }}>关联到当前湖</Button>
              {global.error ? <p role="alert">{global.error}</p> : null}
            </div> : null}
            <SavedWorkflowsSection key={lake.id} projects={projects} includeGlobal={globalNames.length > 0} globalNames={globalNames} workspacePath={workspacePath} workspaceIdentity={workspaceIdentity}
            header={<div><h2 className="text-lg font-medium">{lake.name} · 工作流</h2><p className="text-foreground-subtlest">关联项目的原生工作流</p></div>}
            onCreateViaChat={(prompt, target) => { workflowProps.onCreateViaChat?.(prompt, target); onOpenChange(false); }}
            onNavigateToLaunchedRun={(target, session) => { workflowProps.onNavigateToLaunchedRun?.(target, session); onOpenChange(false); }}
            onOpenWorkflowRun={closeAfter(workflowProps.onOpenWorkflowRun)} onOpenWorkflowArtifact={closeAfter(workflowProps.onOpenWorkflowArtifact)} />
          </> : null}
          {tab === 'resources' ? <div className="space-y-4 py-3">
            <div className="flex flex-wrap gap-2">
              <Input aria-label="资源名称" placeholder="资源名称" value={resourceName} onChange={event => setResourceName(event.target.value)} className="w-40" />
              <Input aria-label="主机地址" placeholder="主机地址" value={host} onChange={event => setHost(event.target.value)} className="w-48" />
              <Input aria-label="SSH 用户名" placeholder="SSH 用户名" value={username} onChange={event => setUsername(event.target.value)} className="w-40" />
              <Input aria-label="SSH 端口" type="number" min={1} max={65535} value={port} onChange={event => setPort(event.target.value)} className="w-24" />
              <Button disabled={loading || !resourceName || !host || !username || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535} onClick={() => { void mutate({ action: 'resource.add', lakeID: lake.id, name: resourceName, host, port: Number(port), username }).then(result => { if (result) { setResourceName(''); setHost(''); setUsername(''); } }); }}>添加资源</Button>
            </div>
            {overview.resources.filter(item => item.lake === lake.name).map(item => <div key={item.id} className="rounded-lg border border-border p-3"><div className="font-medium">{item.name}</div><p className="text-foreground-subtlest">{item.kind} {item.ssh ? `· ${item.ssh.username}@${item.ssh.host}:${item.ssh.port}` : ''}</p></div>)}
            <h3 className="font-medium">关联工作空间</h3>
            {bindings.map(item => <div key={item.workspaceIdentity || item.workspacePath} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"><span className="truncate">{item.workspacePath}</span><Button variant="outline" onClick={() => enter(item)}>打开</Button></div>)}
            {!bindings.length ? <p className="text-foreground-subtlest">关联项目或进入湖工作空间后，可创建和查看原生工作流。</p> : null}
          </div> : null}
          {tab === 'journal' ? <div className="space-y-2 py-3">{journalError ? <p role="alert">{journalError}</p> : null}{journal.map((item, index) => <div key={index} className="rounded-lg border border-border p-3 text-sm"><div>{item.tool} · {item.event === 'completed' ? '已完成' : item.event}</div><time className="text-foreground-subtlest">{new Date(item.timestamp).toLocaleString()}</time><div className="truncate text-foreground-subtle">{item.target_path}</div></div>)}{!journal.length && !journalError ? <p className="text-foreground-subtlest">暂无湖志</p> : null}</div> : null}
        </div>
      </> : !loading ? <p>创建一个湖，关联资源和原生工作流。</p> : <p>读取湖数据…</p>}
    </DialogContent>
  </Dialog>;
}
