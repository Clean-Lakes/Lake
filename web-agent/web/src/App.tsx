import {useSessionComposerDraft} from "./sessionComposerDrafts";
import {ScheduledTasks} from "./ScheduledTasks";
import {MessageText} from './MessageText';
import {SidebarScrollArea} from './SidebarScrollArea';
import {PlanModeToggle,planComposerDraft} from './PlanMode';
import './planMode.css';
import {DisclosureSummary} from './DisclosureSummary';
import {acceptSnapshot,applyConversationMode,reuseUnchanged} from './snapshotUpdates';
import {useAutoRefresh} from './useAutoRefresh';
import {applyLiveText} from './liveTextUpdates';
import {sreSessionPresentation} from './sreSessionPresentation';
import {ComposerMentions,useMentionExtensions,mentionOptionId} from "./ComposerMentions";
import {SREModeToggle} from './SREModeToggle';
import {appendResourceMention,composerMessage,composerResourceIds,selectComposerMention,filterMentions,mentionOptions,nextMentionCategory,type MentionCategory,type MentionOption} from "./composerMentionState";
import {ComposerTextInput,type ComposerInputHandle} from "./ComposerTextInput";
import {AppSelect} from "./AppSelect";
import {ComposerModelSelect} from "./ComposerModelSelect";
import {ProjectSwitcher} from "./ProjectSwitcher";
import {BulkCheckbox, BulkNavigationDelete, type BulkSelection} from "./BulkNavigationDelete";
import {addBulkTargets, bulkCatalogTargets, bulkKey, orderBulkDeletion, type BulkTarget, type BulkDeleteResult} from "./bulkNavigation";
import {NavigationDelete,NavigationTrash,NavigationMenu,type NavigationDeleteTarget} from "./NavigationDelete";
import {SessionEdit} from "./SessionEdit";
import {TerminalConfigEdit} from "./TerminalConfigEdit";
import { Workflows } from "./Workflows";
import { ProjectMemory } from "./ProjectMemory";
import {SidebarUtilities} from "./SidebarUtilities";
import { ActivityIndicator } from "./ActivityIndicator";
import { PendingMessages } from "./PendingMessages";
import { ModelSettings } from "./ModelSettings";
import { readImageSelection } from "./imageAttachments";
import {clipboardFiles,partitionAttachments,attachmentCountLimit,fileSize} from "./fileAttachments";
import { ResourceImport } from "./ResourceImport";
import { SSHResourceFields, emptySSH } from "./SSHResourceFields";
import type { SSHConnectionInput } from "../../shared/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type {
  Action,
  Catalog,
  Message,
  AvailableModels,
  AvailableModelEntry,
  Project,
  Resource,
  SessionEvent,
  SessionSnapshot,
  Specialist,
  TerminalHistory,
  TerminalSession,
  WorkSession,
} from "../../shared/contracts";
import { api, ApiRequestError, readableError, type Bootstrap } from "./api";
import {SessionPlansPage} from "./PlanList";
import {readWorkspaceRoute,workspaceURL,type WorkspaceRoute} from "./workspaceRoute";
import { AIControls, AITranscript } from "./AIPanel";
import { AgentIcon, type AgentIconName } from "./AgentIcon";
import { Glyph, ResourceIcon, type GlyphName } from "./Icons";
import {HeaderSweep} from "./HeaderSweep";
import { SessionActions, SessionListTags, TagManager, SessionStateBadge } from "./SessionPresentation";
import "./sessionPresentation.css";
import "./conversationDirectory.css";
import { ContextUsage } from "./ContextUsage";
import { uniqueTerminalRows } from "./terminalAIState";
import { TerminalPane, type TerminalHandle } from "./TerminalPane";
import { TerminalInputQueue } from "./terminalInputQueue";
import { TerminalSidePanel } from "./TerminalSidePanel";
import { reusableResourceTerminal, onlineTerminalOptions, panelTerminalSessions, ResourceTerminalConnections } from "./resourceTerminalState";
import { ResourceTree } from "./ResourceTree";
import { resourceSearchNodes } from "./navigationSearch";
import { ResourceTerminalMenu } from "./ResourceTerminalMenu";
import { initialSidebarProject, sidebarSessions } from "./sidebarState";
import { CompositionGuard, isSendKey, parseSendShortcut, sendShortcutStorageKey, type SendShortcut } from "./composerKeyboard";
import { HostKeyTrust } from "./HostKeyTrust";
import { conversationActive, sessionConnection, type StreamState } from "./connection";
import { atConversationTail, conversationCanScroll, pausesConversationFollow, FollowScroll } from "./followScroll";
import { type CommandPolicy, dangerConfirmation } from "../../shared/command-policy";
import "./styles.css";
import './fileOperationApproval.css';
import './operationApproval.css';
import "./messageMentions.css";
import "./agentTasks.css";
import "./statusText.css";
import "./floatingHeader.css";
import "./workbenchLayout.js";

// Keep the workflow editor available for later development without exposing it.
const showWorkflows = false;


const sessionLabels: Record<WorkSession["status"], string> = {
  idle: "待命中", investigating: "调查中", waiting_approval: "等待确认", completed: "回复结束", failed: "需要关注",
};
const actionLabels: Record<Action["status"], string> = {
  pending: "等待确认", rejected: "已拒绝", running: "执行中", succeeded: "命令已执行", failed: "执行失败", unknown: "状态待核查",
};
const terminalLabels: Record<TerminalSession["status"], string> = {
  connecting: "连接中", ready: "已连接", busy: "执行中", disconnected: "已断开", unknown: "状态待核查",
};
const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const timeFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });
function dateLabel(value: string, compact = false) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : (compact ? timeFormat : dateFormat).format(date);
}
const specialistLabels: Record<string, string> = { terminal: "终端专员", host: "主机专员", logs: "日志专员" };
function resourceLabel(resource?: Resource) { return resource?.name ?? "未知资源"; }
function initialRoute() {
  return readWorkspaceRoute(window.location.search);
}

type TimelineItem =
  | { kind: "message"; at: string; id: string; item: Message }
  | { kind: "specialist"; at: string; id: string; item: Specialist }
  | { kind: "action"; at: string; id: string; item: Action };

function timelineItems(snapshot: SessionSnapshot): TimelineItem[] {
  return [
    ...snapshot.messages.map(item => ({ kind: "message" as const, at: item.createdAt, id: item.id, item })),
    ...snapshot.specialists.map(item => ({ kind: "specialist" as const, at: item.createdAt, id: item.id, item })),
    ...snapshot.actions.map(item => ({ kind: "action" as const, at: item.createdAt, id: item.id, item })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [authInput, setAuthInput] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [booting, setBooting] = useState(true);
  const [bootLoadingVisible, setBootLoadingVisible] = useState(false);
  useEffect(() => {
    setBootLoadingVisible(false);
    if (!booting) return;
    const timer = setTimeout(() => setBootLoadingVisible(true), 250);
    return () => clearTimeout(timer);
  }, [booting]);
  const [route, setRoute] = useState(initialRoute);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const liveSnapshot=useRef(snapshot);liveSnapshot.current=snapshot;
  const [sessionError, setSessionError] = useState("");
  const [sessionReload, setSessionReload] = useState(0);
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const [streamSessionId, setStreamSessionId] = useState<string | null>(null);
  const [warningSessionId, setWarningSessionId] = useState<string | null>(null);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const snapshotCache = useRef(new Map<string, SessionSnapshot>());
  useLayoutEffect(() => {
    if (!snapshot) return;
    snapshotCache.current.delete(snapshot.session.id);
    snapshotCache.current.set(snapshot.session.id, snapshot);
    while (snapshotCache.current.size > 8) {
      snapshotCache.current.delete(snapshotCache.current.keys().next().value!);
    }
  }, [snapshot]);
  const [sidebarProjectId, setSidebarProjectId] = useState<string | null>(null);
  const [allSessionGroups, setAllSessionGroups] = useState<string[]>([]);
  const [closedSessionGroups, setClosedSessionGroups] = useState<string[]>(() => {
    try { const saved: unknown = JSON.parse(localStorage.getItem("lake.closed-session-groups") || "[]"); return Array.isArray(saved) ? saved.filter(id => typeof id === "string") : []; } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem("lake.closed-session-groups", JSON.stringify(closedSessionGroups)); } catch {} }, [closedSessionGroups]);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [dialog, setDialog] = useState<{ kind: "project" } | { kind: "session"; projectId: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkSession | null>(null);
  const [editSession, setEditSession] = useState<WorkSession | null>(null);
  const [editTerminalResource, setEditTerminalResource] = useState<Resource | null>(null);
  const [resourceConfigContext, setResourceConfigContext] = useState<{resource: Resource; x: number; y: number} | null>(null);
  const [sessionContext, setSessionContext] = useState<{session: WorkSession; x: number; y: number} | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [draftProject, setDraftProject] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [resourceKind, setResourceKind] = useState("ssh");
  const [serviceSettings, setServiceSettings] = useState({ driver: "postgres", host: "", port: 5432, username: "", database: "", path: "", credentialRef: "", endpoint: "unix:///var/run/docker.sock", ssh_asset_ref: "", tls: true });
  const [sshProject, setSshProject] = useState<string | null>(null);
  const [sshParent, setSshParent] = useState<string | null>(null);
  const [scheduleProject,setScheduleProject]=useState<Project|null>(null);
  const [workflowProject, setWorkflowProject] = useState<Project | null>(null);
  const [memoryProject, setMemoryProject] = useState<Project | null>(null);
  const [tagProject, setTagProject] = useState<Project | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  useEffect(()=>{if(selectedTag&&catalog&&!catalog.tags?.some(t=>t.id===selectedTag))setSelectedTag(null);},[catalog,selectedTag]);
  const [importProject, setImportProject] = useState<Project | null>(null);
  const [importHexhub, setImportHexhub] = useState(false);
  const [sshName, setSshName] = useState("");
  const [sshDraft, setSshDraft] = useState<SSHConnectionInput>(emptySSH());
  const [sshError, setSshError] = useState("");
  const [sshBusy, setSshBusy] = useState(false);
  const inputQueue = useRef<TerminalInputQueue | null>(null);
  const {draft: composerDraft, setMessageDraft, setMentionRefs, setImageDraft, setFileDraft, setIgnoreProjectMemory, clearSubmitted} = useSessionComposerDraft(route.sessionId);
  const {message: messageDraft, references: mentionRefs, images: imageDraft, files: fileDraft, ignoreProjectMemory} = composerDraft;
  const attachmentReading = useRef(false);
  const attachmentEpoch = useRef(0);
  useLayoutEffect(() => { attachmentEpoch.current++; }, [route.sessionId]);
  const [attachmentDragOver,setAttachmentDragOver] = useState(false);
  const [attachmentUploading,setAttachmentUploading] = useState("");
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const messageComposition = useRef(new CompositionGuard());
  const [sendShortcut, setSendShortcut] = useState<SendShortcut>(() => {
    try { return parseSendShortcut(localStorage.getItem(sendShortcutStorageKey)); } catch { return "enter"; }
  });
  useEffect(() => { try { localStorage.setItem(sendShortcutStorageKey, sendShortcut); } catch {} }, [sendShortcut]);
  const [completionEnabled,setCompletionEnabled] = useState(() => {try {return localStorage.getItem("lake.composer-completion")!=="off";} catch {return true;}});
  useEffect(() => {try {localStorage.setItem("lake.composer-completion",completionEnabled?"on":"off");} catch {}},[completionEnabled]);
  const sendShortcutLabel = sendShortcut === "command-enter" ? "Command / Ctrl + Enter" : "Enter";
  const [navigationDelete,setNavigationDelete]=useState<NavigationDeleteTarget|null>(null);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<BulkTarget[]>([]);
  const [bulkConfirmation, setBulkConfirmation] = useState<BulkTarget[] | null>(null);
  useEffect(() => {
    if (!catalog) return;
    const available = new Set(bulkCatalogTargets(catalog).map(bulkKey));
    setBulkSelected(current => current.every(target => available.has(bulkKey(target))) ? current : current.filter(target => available.has(bulkKey(target))));
  }, [catalog]);
  const [trashOpen,setTrashOpen]=useState(false);
  const [projectContext,setProjectContext]=useState<{project:Project;x:number;y:number}|null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [navigationQuery, setNavigationQuery] = useState("");
  const navigationInput = useRef<HTMLInputElement>(null);
  const newSessionButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.isComposing || event.repeat) return;
      if(event.key.toLowerCase()==="n"){
        if(/Mac/.test(navigator.platform)?!event.metaKey:!event.ctrlKey)return;
        const button=newSessionButton.current;
        if(!button||button.disabled||button.hidden||document.querySelector('[role="dialog"],.modal-scrim'))return;
        event.preventDefault();button.click();return;
      }
      if(event.key.toLowerCase()!=="k")return;
      event.preventDefault();
      if (matchMedia("(max-width:700px)").matches) setMobileMenu(true);
      requestAnimationFrame(() => navigationInput.current?.focus());
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const [compactNavigation, setCompactNavigation] = useState(() => matchMedia("(max-width: 700px)").matches);
  useEffect(() => {
    const media = matchMedia("(max-width: 700px)");
    const update = () => setCompactNavigation(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [conversationMode, setConversationMode] = useState<"conversation" | "activity" | "evidence">("conversation");
  useEffect(() => { setConversationMode("conversation"); }, [route.sessionId]);
  const [agentOptionsOpen, setAgentOptionsOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const permissionButtonRef = useRef<HTMLButtonElement>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [reasoningSaving,setReasoningSaving]=useState<ReadonlySet<string>>(()=>new Set());
  const [modeSaving,setModeSaving]=useState<ReadonlySet<string>>(()=>new Set());
  const modeSaveSessions=useRef(new Set<string>());
  const [modelMenu, setModelMenu] = useState<AvailableModels & { loading: boolean }>({ loading: false, models: [], message: "" });
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null);
  const messageInputRef = useRef<ComposerInputHandle>(null);
  const [pendingOperation, setPendingOperation] = useState("");
  const syncModels = useAutoRefresh(api.modelState, state => {
    const {available, providers: _providers, settings: _settings, ...model} = state;
    setBootstrap(current => current ? reuseUnchanged(current, {...current, ...model}) : current);
    // Legacy discovery remains on demand; background sync only reads local state.
    setModelMenu(current => available ? reuseUnchanged(current, {...available, loading: false}) : current.entries ? {models: [], loading: false} : current);
  }, !!bootstrap?.authenticated && !pendingOperation);
  const [stoppingTurn, setStoppingTurn] = useState(false);
  const [notice, setNotice] = useState("");
  const [resourceTerminalMenu, setResourceTerminalMenu] = useState<string | null>(null);
  const resourceMenuRef = useRef<HTMLDivElement>(null);
  const resourcePopupRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!resourceTerminalMenu) return;
    const dismiss = (event: Event) => { if (!resourceMenuRef.current?.contains(event.target as Node) && !resourcePopupRef.current?.contains(event.target as Node)) setResourceTerminalMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { document.getElementById(`resource-trigger-${resourceTerminalMenu}`)?.focus(); setResourceTerminalMenu(null); } };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("focusin", dismiss); document.removeEventListener("keydown", key); };
  }, [resourceTerminalMenu]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalContext, setTerminalContext] = useState<{sessionId: string; resourceId: string} | null>(null);
  const activeTerminalContext = useRef(terminalContext);
  activeTerminalContext.current = terminalContext;
  const [resourceTerminalSnapshot, setResourceTerminalSnapshot] = useState<SessionSnapshot | null>(null);
  const [resourceLiveTerminals, setResourceLiveTerminals] = useState<TerminalSession[]>([]);
  const [resourceTerminalConnected, setResourceTerminalConnected] = useState(false);
  const terminalSessionId = terminalContext?.sessionId ?? route.sessionId;
  const [terminalOpeningResource, setTerminalOpeningResource] = useState<string | null>(null);
  const terminalConnections = useRef(new ResourceTerminalConnections());
  const [connectingResources, setConnectingResources] = useState<string[]>([]);
  const [localShell,setLocalShell]=useState("bash");
  const terminalControlRef = useRef<TerminalHandle | null>(null);
  const terminalTabsRef = useRef<HTMLDivElement>(null);
  const [terminalOptionsOpen, setTerminalOptionsOpen] = useState(false);
  const [terminalListOpen, setTerminalListOpen] = useState(false);
  const [terminalTabContext, setTerminalTabContext] = useState<{terminal: TerminalSession; x: number; y: number} | null>(null);
  const [commandEditorOpen, setCommandEditorOpen] = useState(false);
  const [restoringStream, setRestoringStream] = useState(false);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [terminalHistory, setTerminalHistory] = useState<TerminalHistory | null>(null);
  const [terminalHistories, setTerminalHistories] = useState<Record<string, TerminalHistory>>({});
  const terminalHistoriesRef = useRef(terminalHistories);
  terminalHistoriesRef.current = terminalHistories;
  const refreshTerminalHistoryRef = useRef<() => void>(() => {});
  const seenTerminalRevision = useRef(0);
  const [terminalError, setTerminalError] = useState("");
  const [terminalRevision, setTerminalRevision] = useState(0);
  const [terminalRefresh, setTerminalRefresh] = useState(0);
  const [commandDraft, setCommandDraft] = useState("");
  const commandInputRef = useRef<HTMLTextAreaElement>(null);
  const [commandError, setCommandError] = useState("");
  const [confirmedCommand, setConfirmedCommand] = useState<string | null>(null);
  const [confirmedPolicy, setConfirmedPolicy] = useState<CommandPolicy | null>(null);
  const commandTargetRef = useRef({session: terminalSessionId, terminal: terminalId});
  commandTargetRef.current = {session: terminalSessionId, terminal: terminalId};
  const [dangerousAction, setDangerousAction] = useState<Action | null>(null);
  const [dangerText, setDangerText] = useState("");
  const [dangerStage, setDangerStage] = useState(false);
  const readonlyAttempts = useRef(new Set<string>());
  const [commandBusy, setCommandBusy] = useState(false);
  const streamCursor = useRef(0);
  const activeSession = useRef<string | null>(route.sessionId);
  const conversationRef = useRef<HTMLElement>(null);
  const conversationScroll = useRef({ key: "", following: true });
  const conversationFollower = useRef<FollowScroll | null>(null);
  const pauseFollowing = useCallback(() => {
    conversationScroll.current.following = false;
    conversationFollower.current?.stop();
  }, []);
  const conversationResume=useRef(new Map<string,{top:number;following:boolean}>());
  const inspectConversation = useCallback(() => {
    const box = conversationRef.current;
    if (box && conversationCanScroll(box)) pauseFollowing();
  }, [pauseFollowing]);
  const noticeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((message: string) => {
    setNotice(message);
    if (noticeRef.current) clearTimeout(noticeRef.current);
    noticeRef.current = setTimeout(() => setNotice(""), 5500);
  }, []);
  useEffect(() => () => { if (noticeRef.current) clearTimeout(noticeRef.current); }, []);

  const handleFailure = useCallback((error: unknown) => {
    if (error instanceof ApiRequestError && error.status === 401) {
      snapshotCache.current.clear();
      setAuthRequired(true);
      setAuthError("会话已失效。请重新输入访问令牌。");
      setBootstrap(null);
      setCatalog(null);
      setStreamState("disconnected");
      return;
    }
    notify(readableError(error));
  }, [notify]);
  if (!inputQueue.current) inputQueue.current = new TerminalInputQueue(api.terminalInput, error => handleFailure(error));

  const loadApp = useCallback(async (token?: string) => {
    setBooting(true);
    setCatalogError("");
    setAuthError("");
    try {
      const info = await api.bootstrap(token);
      const data = await api.catalog();
      setBootstrap(info);
      setAuthRequired(false);
      setAuthInput("");
      setCatalog(data);
      const initialProject = initialSidebarProject(data, initialRoute());
      setSidebarProjectId(previous => data.projects.some(project => project.id === previous) ? previous : initialProject);
      setRoute(previous => {
        const sessionId = previous.sessionId && data.sessions.some(session => session.id === previous.sessionId)
          ? previous.sessionId : [...data.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null;
        const resourceId=previous.resourceId && data.resources.some(resource => resource.id === previous.resourceId) ? previous.resourceId : null;
        return {sessionId,resourceId,...(previous.view==='plans'&&sessionId===previous.sessionId&&!resourceId?{view:'plans' as const}:{})};
      });
    } catch (error) {
      setBootstrap(null);
      setCatalog(null);
      if (error instanceof ApiRequestError && error.status === 401) {
        snapshotCache.current.clear();
        setAuthRequired(true);
        setAuthError(token ? "访问令牌无效。请检查后重试。" : "此服务需要访问令牌。请输入管理员提供的令牌。");
      } else {
        setCatalogError(readableError(error));
      }
    } finally {
      setBooting(false);
    }
  }, []);

  useEffect(() => { const token = new URLSearchParams(window.location.hash.slice(1)).get("token") || undefined;
    if (token) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    void loadApp(token); }, [loadApp]);
  useEffect(() => {
    const onPopState = () => setRoute(initialRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const navigate = useCallback((next: WorkspaceRoute) => {
    const url = workspaceURL(window.location.href,next);
    window.history.pushState(null, "", url);
    setRoute(next);
    setMobileMenu(false);
  }, []);
  const isPlansPage=route.view==='plans'&&!route.resourceId&&!!route.sessionId;
  const openSessionPlans=useCallback((targetSession:string)=>{
    const box=conversationRef.current;
    if(box&&activeSession.current===targetSession)conversationResume.current.set(targetSession,{top:box.scrollTop,following:conversationScroll.current.following});
    pauseFollowing();
    setConversationMode("conversation");
    setAgentOptionsOpen(false);setPermissionsOpen(false);setModelMenuOpen(false);
    navigate({sessionId:targetSession,resourceId:null,view:'plans'});
  },[navigate,pauseFollowing]);
  const openPlans=useCallback(()=>{if(route.sessionId)openSessionPlans(route.sessionId);},[route.sessionId,openSessionPlans]);
  const returnToConversation=useCallback(()=>{
    setConversationMode("conversation");
    navigate({sessionId:route.sessionId,resourceId:null});
    requestAnimationFrame(()=>conversationRef.current?.focus({preventScroll:true}));
  },[navigate,route.sessionId]);
  const sessionId = route.sessionId;
  useEffect(() => { activeSession.current = sessionId; }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !bootstrap || !catalog) {
      setSnapshot(null);
      setStreamSessionId(null);
      return;
    }
    let disposed = false;
    let stream: EventSource | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let textFrame:number|null=null;
    let textEvents:SessionEvent[]=[];
    let terminalRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const requests = new AbortController();
    const fetchSnapshot = () => api.snapshot(sessionId, AbortSignal.any([requests.signal, AbortSignal.timeout(12000)]));
    let syncing = false;
    let queued = false;
    let queuedRevision = false;
    let restoring = false;
    let everConnected = false;
    let pollingHealthy = false;
    setSnapshot(snapshotCache.current.get(sessionId) ?? null);
    setStreamSessionId(sessionId);
    setSessionError("");
    setStreamState("connecting");
    setRestoringStream(false);
    streamCursor.current = 0;

    const refresh = async () => {
      if (syncing) { queued = true; return; }
      syncing = true;
      try {
        const fresh = await fetchSnapshot();
        if (disposed || activeSession.current !== sessionId) return;
        setSnapshot(current=>acceptSnapshot(current,fresh));
        streamCursor.current = Math.max(streamCursor.current, fresh.cursor);
        setCatalog(current => current ? {
          ...current,
          resources: [...current.resources.filter(resource => resource.projectId !== fresh.session.projectId), ...fresh.resources],
          resourceTree: fresh.resourceTree ? [...(current.resourceTree ?? []).filter(node => node.projectId !== fresh.session.projectId), ...fresh.resourceTree] : current.resourceTree,
          sessions: current.sessions.some(session => session.id === fresh.session.id)
            ? current.sessions.map(session => session.id === fresh.session.id ? fresh.session : session)
            : [...current.sessions, fresh.session],
        } : current);
        setSessionError("");
        setRestoringStream(false);
        if (!stream || stream.readyState !== EventSource.OPEN) { pollingHealthy = true; setStreamState("polling"); }
        if (queuedRevision) {
          queuedRevision = false;
          setTerminalRevision(value => value + 1);
        }
      } catch (error) {
        if (!disposed) {
          pollingHealthy = false;
          if (error instanceof ApiRequestError && error.status === 401) handleFailure(error);
          else { setSessionError(readableError(error)); setRestoringStream(true); }
        }
      } finally {
        syncing = false;
        if (queued && !disposed) { queued = false; void refresh(); }
      }
    };
    const onEvent = (incoming: MessageEvent<string>) => {
      try {
        const event = JSON.parse(incoming.data) as SessionEvent;
        if (event.sessionId !== sessionId || typeof event.seq !== "number" || event.seq <= streamCursor.current) return;
        streamCursor.current = event.seq;
        if(event.conversationMode==='plan'||event.conversationMode==='default'){
          setSnapshot(current=>applyConversationMode(current,sessionId,{mode:event.conversationMode!,cursor:event.seq}));
          return;
        }
        if(event.textUpdate&&applyLiveText(liveSnapshot.current,event)){
          textEvents.push(event);
          if(textFrame===null)textFrame=requestAnimationFrame(()=>{
            textFrame=null;
            const batch=textEvents;textEvents=[];
            if(disposed)return;
            setSnapshot(current=>batch.reduce((value,item)=>applyLiveText(value,item)??value,current));
          });
          return;
        }
        if (event.type === "terminal" && !terminalRefreshTimer) terminalRefreshTimer = setTimeout(() => {
          terminalRefreshTimer = null;
          setTerminalRevision(value => value + 1);
        }, 32);
        // Bound snapshot traffic without postponing every update until a
        // continuous token stream finally goes quiet.
        if (!refreshTimer) refreshTimer = setTimeout(() => {
          refreshTimer = null;
          void refresh();
        }, event.type === "terminal" ? 250 : 16);
      } catch { /* Keep the current snapshot if an unrelated SSE frame arrives. */ }
    };
    const stopPolling = () => { if (pollTimer) clearInterval(pollTimer); pollTimer = null; };
    const startPolling = () => {
      if (disposed || document.hidden || pollTimer) return;
      queuedRevision = true;
      void refresh();
      pollTimer = setInterval(() => { queuedRevision = true; void refresh(); }, 2000);
    };
    const connectStream = () => {
      if (disposed || document.hidden || stream) return;
      stream = new EventSource(api.eventsUrl(sessionId, streamCursor.current), { withCredentials: true });
      stream.onopen = () => {
        if (disposed) return;
        stopPolling();
        setStreamState("connected");
        if (everConnected || restoring) {
          restoring = false;
          queuedRevision = true;
          setRestoringStream(true);
          void refresh();
        } else setRestoringStream(false);
        everConnected = true;
      };
      stream.onerror = () => {
        if (disposed) return;
        restoring = true;
        if (!pollingHealthy) { setRestoringStream(true); setStreamState("disconnected"); }
        startPolling();
      };
      stream.onmessage = onEvent;
      for (const type of ["session", "message", "specialist", "evidence", "action", "terminal"]) stream.addEventListener(type, onEvent as EventListener);
    };
    let ready = false;
    const visibility = () => {
      if (!ready) return;
      if (document.hidden) {
        stream?.close(); stream = null; stopPolling(); pollingHealthy = false;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = null;
        if(textFrame!==null)cancelAnimationFrame(textFrame);
        textFrame=null;textEvents=[];
        // A hidden tab deliberately suspends its stream; it has not failed.
        setStreamState("connecting"); setRestoringStream(true);
      } else { setStreamState("connecting"); setSessionError(""); restoring = true; startPolling(); connectStream(); }
    };
    document.addEventListener("visibilitychange", visibility);
    (async () => {
      try {
        const first = await fetchSnapshot();
        if (disposed || activeSession.current !== sessionId) return;
        setSnapshot(current=>acceptSnapshot(current,first));
        setSessionError("");
        streamCursor.current = first.cursor;
        setCatalog(current => current ? { ...current, sessions: current.sessions.map(session => session.id === first.session.id ? first.session : session) } : current);
        ready = true;
        startPolling();
        connectStream();
      } catch (error) {
        if (disposed) return;
        setStreamState("disconnected");
        setRestoringStream(true);
        if (error instanceof ApiRequestError && error.status === 401) handleFailure(error);
        else setSessionError(readableError(error));
      }
    })();
    return () => {
      disposed = true;
      requests.abort();
      document.removeEventListener("visibilitychange", visibility);
      stopPolling();
      stream?.close();
      if (refreshTimer) clearTimeout(refreshTimer);
      if(textFrame!==null)cancelAnimationFrame(textFrame);
      if (terminalRefreshTimer) clearTimeout(terminalRefreshTimer);
    };
  }, [sessionId, sessionReload, Boolean(bootstrap), Boolean(catalog), handleFailure]);

  useEffect(() => {
    if (!activeTerminalContext.current) {
      setTerminalOpen(false);
      setTerminalOpeningResource(null);
      setTerminalOptionsOpen(false); setTerminalListOpen(false); setCommandEditorOpen(false);
      setTerminalId(null);
      setTerminalHistory(null);
      setTerminalError("");
      setCommandDraft("");
      setCommandError("");
      setConfirmedCommand(null);
      setDangerousAction(null);
      setDangerStage(false);
      setDangerText("");
    }
    setAgentOptionsOpen(false);
    setPermissionsOpen(false);
    setMention(null);
  }, [sessionId]);

  const refreshResourceTerminal = useCallback(async (signal?: AbortSignal) => {
    const context = activeTerminalContext.current;
    if (!context) return;
    const [fresh, live] = await Promise.all([api.snapshot(context.sessionId, signal), api.resourceTerminals(context.resourceId, signal)]);
    if (activeTerminalContext.current !== context) return;
    setResourceTerminalSnapshot(fresh);
    setResourceLiveTerminals(live.terminals);
    setResourceTerminalConnected(true);
    setTerminalRevision(value => value + 1);
    return fresh;
  }, []);
  useEffect(() => {
    if (!terminalContext || !terminalOpen || !bootstrap) return;
    let disposed = false;
    let syncing = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let terminalRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      if (disposed || syncing) return;
      syncing = true;
      try { await refreshResourceTerminal(); }
      catch (error) { if (!disposed) { setResourceTerminalConnected(false); setTerminalError(readableError(error)); } }
      finally { syncing = false; }
    };
    const stream = new EventSource(api.eventsUrl(terminalContext.sessionId, resourceTerminalSnapshot?.cursor ?? 0), {withCredentials: true});
    const update = (event?: Event) => {
      if (event?.type === "terminal" && !terminalRefreshTimer) terminalRefreshTimer = setTimeout(() => {
        terminalRefreshTimer = null;
        setTerminalRevision(value => value + 1);
      }, 32);
      if (!timer) timer = setTimeout(() => { timer = null; void refresh(); }, event?.type === "terminal" ? 250 : 80);
    };
    stream.onopen = update;
    stream.onerror = update;
    stream.onmessage = update;
    for (const type of ["terminal", "session", "action"]) stream.addEventListener(type, update);
    void refresh();
    const poll = setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
    return () => { disposed = true; stream.close(); clearInterval(poll); if (timer) clearTimeout(timer); if (terminalRefreshTimer) clearTimeout(terminalRefreshTimer); };
  }, [terminalContext, terminalOpen, bootstrap, refreshResourceTerminal]);

  useEffect(() => {
    if (!terminalSessionId || !terminalId) { setTerminalHistory(null); refreshTerminalHistoryRef.current = () => {}; return; }
    if (!terminalOpen) return;
    let cancelled = false;
    let syncing = false;
    let queued = false;
    setTerminalError("");
    const refresh = async () => {
      if (cancelled) return;
      if (syncing) { queued = true; return; }
      syncing = true;
      try {
        const outputOnly = terminalHistoriesRef.current[terminalId]?.terminal.interactive === true;
        const history = await api.terminalHistory(terminalSessionId, terminalId, undefined, outputOnly);
        if (!cancelled) {
          const merged = outputOnly ? { ...history, entries: terminalHistoriesRef.current[terminalId]?.entries ?? [] } : history;
          setTerminalHistory(merged);
          setTerminalHistories(current => ({...current, [merged.terminal.id]: merged}));
        }
      } catch (error) {
        if (!cancelled) { setTerminalError(readableError(error)); handleFailure(error); }
      } finally {
        syncing = false;
        if (queued && !cancelled) { queued = false; void refresh(); }
      }
    };
    refreshTerminalHistoryRef.current = () => { void refresh(); };
    void refresh();
    return () => { cancelled = true; if (refreshTerminalHistoryRef.current) refreshTerminalHistoryRef.current = () => {}; };
  }, [terminalId, terminalOpen, terminalSessionId, terminalRefresh, handleFailure]);
  useEffect(() => {
    if (seenTerminalRevision.current === terminalRevision) return;
    seenTerminalRevision.current = terminalRevision;
    refreshTerminalHistoryRef.current();
  }, [terminalRevision]);

  const activeSnapshot = snapshot?.session.id === sessionId ? snapshot : sessionId && catalog?.sessions.some(session => session.id === sessionId) ? snapshotCache.current.get(sessionId) ?? null : null;
  const selectedSession = activeSnapshot?.session ?? catalog?.sessions.find(item => item.id === sessionId);
  const currentSessionPresentation = selectedSession ? sreSessionPresentation(selectedSession,activeSnapshot?.sre?.tasks) : {};
  const currentSessionStatus = currentSessionPresentation.status ?? selectedSession?.status;
  const selectedResource = catalog?.resources.find(item => item.id === route.resourceId);
  const selectedProjectId = selectedResource?.projectId ?? selectedSession?.projectId;
  useEffect(() => {
    if (selectedProjectId) setSidebarProjectId(selectedProjectId);
  }, [selectedProjectId]);
  const resourceMap = new Map((catalog?.resources ?? []).map(resource => [resource.id, resource]));
  const sshParentName = sshParent ? (catalog?.resourceTree ?? []).find(node => node.id === sshParent)?.name ?? "" : "";
  const visibleSessionError = streamSessionId === sessionId ? sessionError : "";
  const connection = sessionConnection({ ready: !!bootstrap && !!catalog, sessionId, streamSessionId, streamState,
    snapshotReady: !!activeSnapshot, restoring: restoringStream, error: visibleSessionError });
  const connected = connection.connected;
  useEffect(() => {
    setWarningSessionId(null);
    if (!connection.warning) return;
    const timer = setTimeout(() => setWarningSessionId(sessionId), 800);
    return () => clearTimeout(timer);
  }, [connection.warning, sessionId]);
  useEffect(() => {
    setLoadingSessionId(null);
    if (!sessionId || activeSnapshot || visibleSessionError) return;
    const timer = setTimeout(() => setLoadingSessionId(sessionId), 250);
    return () => clearTimeout(timer);
  }, [sessionId, !!activeSnapshot, visibleSessionError]);
  const sessionConnected = connected && !!activeSnapshot && !!selectedSession;
  const modelConfigured = bootstrap?.modelConfigured === true;
  const persistentMode = bootstrap?.terminalMode === "pty";
  const terminalConnected = terminalContext ? !!bootstrap && !!catalog && resourceTerminalConnected : sessionConnected;
  const conversationTerminals = activeSnapshot?.terminals ?? [];
  const terminalList = panelTerminalSessions(catalog?.terminals ?? [], conversationTerminals, terminalContext ? resourceLiveTerminals : [], terminalContext?.resourceId);
  const terminalOptions = onlineTerminalOptions(terminalList, id => resourceLabel(resourceMap.get(id)));
  const resourceTerminals = uniqueTerminalRows([
    ...(catalog?.terminals ?? []).filter(t => t.interactive === true && t.sessionId !== activeSnapshot?.session.id),
    ...[...conversationTerminals, ...(terminalContext ? terminalList : [])].filter(t => t.interactive === true && t.status !== "disconnected").map(t => ({ ...t, sessionTitle: t.sessionId === activeSnapshot?.session.id ? activeSnapshot?.session.title : t.ownerTitle || catalog?.terminals?.find(row=>row.id===t.id)?.sessionTitle })),
  ]);
  const latestReadyTerminal = (resourceId: string) => [...conversationTerminals]
    .filter(terminal => terminal.resourceId === resourceId && terminal.status === "ready")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const currentTerminal = terminalList.find(item => item.id === terminalId) ?? (terminalHistory?.terminal.id === terminalId ? terminalHistory.terminal : undefined);
  const terminalResource = resourceMap.get(currentTerminal?.resourceId ?? terminalOpeningResource ?? "");
  const pendingApproval = activeSnapshot?.actions.some(action => action.status === "pending") ?? false;
  const turnActive = conversationActive(activeSnapshot, selectedSession?.status);
  const hasMessageDraft = !!(messageDraft.trim() || mentionRefs.length || imageDraft.length || fileDraft.length);
  const queueMode = turnActive || (activeSnapshot?.messageQueue?.items.length ?? 0)>0;
  const messageBlocked = selectedSession?.status === "investigating" || bootstrap?.aiRuntime === "go" && activeSnapshot?.ai?.status === "waiting_approval";
  useEffect(() => {
    if (currentTerminal?.status !== "disconnected") return;
    const next = terminalOptions[0]?.terminal;
    if (next) selectTerminalTab(next);
    else { setTerminalId(null); setTerminalHistory(null); }
  }, [currentTerminal?.status, terminalId, terminalOptions]);
  function revealActiveTerminalTab() {
    const scroller = terminalTabsRef.current;
    const active = scroller?.querySelector<HTMLElement>(".terminal-tab-wrap.selected");
    if (!terminalOpen || !scroller || !active) return;
    if (active.offsetLeft < scroller.scrollLeft) scroller.scrollLeft = active.offsetLeft;
    else if (active.offsetLeft + active.offsetWidth > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = active.offsetLeft + active.offsetWidth - scroller.clientWidth;
  }
  useLayoutEffect(revealActiveTerminalTab, [terminalId, terminalOpen, terminalOptions.length]);
  useEffect(() => {
    if (!terminalOpen || commandBusy || currentTerminal?.holder !== "user" || currentTerminal.status !== "ready") return;
    const frame = requestAnimationFrame(() => terminalControlRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [terminalOpen, commandBusy, terminalId, currentTerminal?.holder, currentTerminal?.status, terminalHistory?.terminal.id]);

  useLayoutEffect(() => {
    const container = conversationRef.current;
    if (!container || !activeSnapshot || route.resourceId || isPlansPage) {
      conversationScroll.current = { key: "", following: true };
      return;
    }
    const key = activeSnapshot.session.id;
    if (conversationScroll.current.key !== key) conversationScroll.current = { key, following: true };
    const follower = new FollowScroll(container, () => conversationScroll.current.following,
      undefined, window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    conversationFollower.current = follower;
    const resume=conversationResume.current.get(key);
    if(resume){conversationResume.current.delete(key);conversationScroll.current={key,following:resume.following};container.scrollTop=resume.top;if(resume.following)follower.jump();}
    else follower.jump();
    const observer = new ResizeObserver(() => follower.request());
    observer.observe(container);
    let content = container.firstElementChild;
    if (content) observer.observe(content);
    const children = new MutationObserver(() => {
      if (content === container.firstElementChild) return;
      if (content) observer.unobserve(content);
      content = container.firstElementChild;
      if (content) observer.observe(content);
      follower.request();
    });
    children.observe(container, {childList: true});
    return () => { children.disconnect(); observer.disconnect(); follower.stop(); conversationFollower.current = null; };
  }, [activeSnapshot?.session.id, route.resourceId,isPlansPage]);

  useLayoutEffect(() => {
    conversationFollower.current?.request();
  }, [activeSnapshot?.cursor, terminalOpen]);

  const refreshCatalog = useCallback(async (signal?: AbortSignal) => {
    const data = await api.catalog(signal);
    setCatalog(data);
    return data;
  }, []);
  useEffect(() => {
    if (!bootstrap?.authenticated) return;
    let disposed=false, syncing=false;
    const sync = async () => {
      if(disposed || syncing || document.hidden)return;
      syncing=true;
      try { const data=await api.catalog();if(!disposed)setCatalog(current=>reuseUnchanged(current,data)); }
      catch {} finally {syncing=false;}
    };
    const timer=setInterval(() => void sync(),2000);
    window.addEventListener("focus",sync);
    return () => {disposed=true;clearInterval(timer);window.removeEventListener("focus",sync);};
  }, [bootstrap?.authenticated]);
  // Deliberately ignores arguments: it is used directly as a promise callback
  // (e.g. `.then(refresh)`), where the resolved value must not be mistaken for
  // an AbortSignal.
  const refreshCurrent = useCallback(async () => {
    if (!activeSession.current) return;
    const fresh = await api.snapshot(activeSession.current);
    if (activeSession.current !== fresh.session.id) return;
    setSnapshot(current=>acceptSnapshot(current,fresh));
    streamCursor.current = Math.max(streamCursor.current, fresh.cursor);
    setCatalog(current => current ? { ...current, sessions: current.sessions.some(session => session.id === fresh.session.id)
      ? current.sessions.map(session => session.id === fresh.session.id ? fresh.session : session)
      : [...current.sessions, fresh.session] } : current);
    setTerminalRevision(value => value + 1);
  }, []);


  function toggleBulkTarget(target: BulkTarget) {
    if (target.kind === "resource" && catalog?.resources.some(resource => resource.id === target.id && resource.kind === "local")) return;
    setBulkSelected(current => current.some(item => bulkKey(item) === bulkKey(target)) ? current.filter(item => bulkKey(item) !== bulkKey(target)) : addBulkTargets(current, [target]));
  }
  function toggleBulkGroup(targets: BulkTarget[]) {
    const keys = new Set(targets.map(bulkKey));
    setBulkSelected(current => targets.every(target => current.some(item => bulkKey(item) === bulkKey(target))) ? current.filter(item => !keys.has(bulkKey(item))) : addBulkTargets(current, targets));
  }
  const bulkSelection: BulkSelection | undefined = bulkMode ? {has: target => bulkSelected.some(item => bulkKey(item) === bulkKey(target)), toggle: toggleBulkTarget, disabled: !connected || !!pendingOperation} : undefined;
  async function bulkProcessed(result: BulkDeleteResult) {
    snapshotCache.current.clear();
    setBulkSelected(result.failed.map(item => item.target));
    if (!result.failed.length) setBulkMode(false);
    const fresh = await refreshCatalog();
    setResourceTerminalMenu(null);
    if (route.sessionId && !fresh.sessions.some(item => item.id === route.sessionId)) {
      const next = fresh.sessions.filter(item => item.projectId === selectedProjectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      navigate({sessionId: next?.id ?? null, resourceId: null});
    } else if (route.resourceId && !fresh.resources.some(item => item.id === route.resourceId)) navigate({sessionId: route.sessionId, resourceId: null});
    else await refreshCurrent();
  }

  const openSettings = useCallback(() => {setSettingsOpen(true);}, []);
  async function openModelMenu() {
    if (modelMenuOpen) { setModelMenuOpen(false); return; }
    setModelMenuOpen(true);
    setModelMenu(current=>({...current,loading:true,message:""}));
    try {
      const [available,current] = await Promise.all([api.availableModels(),api.bootstrap()]);
      setBootstrap(current);
      setModelMenu({ ...available, loading: false });
    } catch (error) {setModelMenu({ loading: false, models: [], message: readableError(error) });}
  }
  async function switchModel(model: string | AvailableModelEntry) {
    if (pendingOperation||reasoningSaving.size) return;
    setPendingOperation("model");
    try {
      if (typeof model === "string") {
        const current = await api.modelSettings();
        await api.saveModelSettings(current.url, model, undefined, current.protocol || "openai");
      } else {await api.selectProviderModel(model.providerId, model.modelId);}
      await refreshBootstrap();setModelMenuOpen(false);
    } catch (error) {notify(readableError(error));}
    finally {setPendingOperation("");}
  }
  async function refreshBootstrap() {
    try {
      setBootstrap(await api.bootstrap());
      await syncModels();
    } catch { /* Keep the last known model state during a temporary failure. */ }
  }
  async function submitAuth(event: FormEvent) {
    event.preventDefault();
    if (!authInput.trim() || authBusy) return;
    setAuthBusy(true);
    await loadApp(authInput);
    setAuthBusy(false);
  }
  function openProjectDialog() {
    setDraftProject(""); setDialogError(""); setDialog({ kind: "project" });
  }
  function openSessionDialog(projectId: string) {
    setDialogError(""); setDialog({ kind: "session", projectId });
  }

  async function submitDialog(event: FormEvent) {
    event.preventDefault();
    if (!dialog || dialogBusy || !connected) return;
    setDialogBusy(true); setDialogError("");
    try {
      if (dialog.kind === "project") {
        const name = draftProject.trim();
        if (!name) return;
        const project = await api.createProject(name);
        await refreshCatalog();
        setSidebarProjectId(project.id);
        notify(`已创建项目「${project.name}」`);
      } else {
        const session = await api.createSession(dialog.projectId);
        await refreshCatalog();
        setSidebarProjectId(dialog.projectId);
        navigate({ sessionId: session.id, resourceId: null });
        notify(`已创建会话「${session.title}」`);
      }
      setDialog(null);
    } catch (error) {
      setDialogError(readableError(error));
      if (error instanceof ApiRequestError && error.status === 401) handleFailure(error);
    } finally { setDialogBusy(false); }
  }
  async function confirmDeleteSession() {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true); setDeleteError("");
    const removed = deleteTarget;
    try {
      await api.deleteSession(removed.id);
      snapshotCache.current.delete(removed.id);
      const data = await refreshCatalog();
      // Leave no dead route behind: pick the next newest session of the same project.
      if (route.sessionId === removed.id) {
        const next = data.sessions.filter(session => session.projectId === removed.projectId)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        navigate({ sessionId: next?.id ?? null, resourceId: null });
      }
      setDeleteTarget(null);
      notify(`已删除会话「${removed.title}」`);
    } catch (error) {
      setDeleteError(readableError(error));
      if (error instanceof ApiRequestError && error.status === 401) { setDeleteTarget(null); handleFailure(error); }
    } finally { setDeleteBusy(false); }
  }
  function terminalResourceSaved(saved: Resource) {
    setCatalog(current => current ? {...current, resources: current.resources.map(resource => resource.id === saved.id ? saved : resource)} : current);
    for (const [id, cached] of snapshotCache.current) snapshotCache.current.set(id, {...cached, resources: cached.resources.map(resource => resource.id === saved.id ? saved : resource)});
    setSnapshot(current => current ? {...current, resources: current.resources.map(resource => resource.id === saved.id ? saved : resource)} : current);
    notify("终端配置已保存");
    void refreshCatalog().catch(handleFailure);
  }
  function sessionRenamed(saved: WorkSession) {
    setCatalog(current => current ? {...current, sessions: current.sessions.map(session => session.id === saved.id ? {...session, title: saved.title, updatedAt: saved.updatedAt} : session), terminals: current.terminals?.map(terminal => terminal.sessionId === saved.id ? {...terminal, sessionTitle: saved.title} : terminal)} : current);
    const cached = snapshotCache.current.get(saved.id);
    if (cached) snapshotCache.current.set(saved.id, {...cached, session: {...cached.session, title: saved.title, updatedAt: saved.updatedAt}});
    setSnapshot(current => current?.session.id === saved.id ? {...current, session: {...current.session, title: saved.title, updatedAt: saved.updatedAt}} : current);
    notify("会话名称已更新");
  }
  /** Only explicitly selected, enabled extensions become message references. */
  const mentionable = sessionId ? (activeSnapshot?.resources ?? catalog?.resources.filter(resource => resource.projectId === selectedSession?.projectId) ?? []) : [];
  const [mentionCategory,setMentionCategory]=useState<MentionCategory>("all");
  const mentionExtensions=useMentionExtensions(!!mention,sessionId);
  const allMentionOptions=mentionOptions(mentionable,mentionExtensions.skills,mentionExtensions.servers,!!activeSnapshot?.sre?.enabled);
  const mentionMatches=mention?filterMentions(allMentionOptions,mention.query,mentionCategory):[];
  const mentionIndex=Math.min(mention?.index??0,Math.max(0,mentionMatches.length-1));
  function syncMention(value: string, caret: number) {
    const token = value.slice(0, caret).match(/@([^\s@\ufffc]*)$/);
    if(token&&!mention)setMentionCategory("all");
    setMention(token ? { query: token[1] ?? "", index: 0 } : null);
  }
  function insertMention(option: MentionOption) {
    const input=messageInputRef.current;
    const {next,position,references}=selectComposerMention(messageDraft,input?.selectionStart??messageDraft.length,mentionRefs,option);
    setMentionRefs(references);
    setMessageDraft(next);setMention(null);
    requestAnimationFrame(()=>{input?.focus();input?.setSelectionRange(position,position);});
  }
  function addResourceToConversation(resource: Resource) {
    if (!sessionConnected || pendingOperation || bulkMode || !sessionId || selectedSession?.projectId !== resource.projectId || !mentionable.some(item=>item.id===resource.id)) return;
    const result=appendResourceMention(messageDraft,mentionRefs,resource,messageInputRef.current?.selectionStart??messageDraft.length,messageInputRef.current?.selectionEnd??messageDraft.length);
    setMessageDraft(result.next);setMentionRefs(result.references);setMention(null);
    setResourceTerminalMenu(null);
    if (route.resourceId) navigate({sessionId,resourceId:null});
    requestAnimationFrame(()=>{const input=messageInputRef.current;input?.focus({preventScroll:true});input?.setSelectionRange(result.position,result.position);});
  }
  /** Selected reference tokens remain until explicitly removed or the message is sent. */
  function mentionedResourceIds(_text: string) {
    return composerResourceIds(mentionRefs, mentionable.map(resource => resource.id));
  }
  async function stopCurrentTurn() {
    if (!sessionId || !turnActive || stoppingTurn || !sessionConnected) return;
    setStoppingTurn(true);
    try { await api.aiOperation(sessionId, "abort"); await refreshCurrent(); }
    catch (error) { handleFailure(error); }
    finally { setStoppingTurn(false); }
  }
  async function attachFiles(files: FileList | File[] | null) {
    if (!files?.length || !sessionId || pendingOperation || attachmentReading.current) return;
    attachmentReading.current = true;
    const epoch = attachmentEpoch.current;
    const targetSession = sessionId;
    const selected = [...files];
    setPendingOperation("attachment-upload");
    try {
      const {images:imageFiles,files:otherFiles}=partitionAttachments(selected,imageDraft,!!bootstrap?.supportsImageInput);
      if(fileDraft.length+otherFiles.length>attachmentCountLimit)throw Error("每条消息最多附加 8 个文件。");
      const images=imageFiles.length?await readImageSelection(imageDraft,imageFiles):[];
      if(activeSession.current===targetSession&&epoch===attachmentEpoch.current)setImageDraft(current=>[...current,...images]);
      for(const file of otherFiles) {
        setAttachmentUploading(file.name);
        const uploaded=await api.uploadAttachment(targetSession,file);
        if(activeSession.current===targetSession&&epoch===attachmentEpoch.current)setFileDraft(current=>[...current,uploaded]);
      }
    } catch (error) { handleFailure(error); }
    finally { attachmentReading.current = false; setAttachmentUploading(""); setPendingOperation(""); if (attachmentInputRef.current) attachmentInputRef.current.value = ""; if (activeSession.current === targetSession && epoch === attachmentEpoch.current) requestAnimationFrame(() => messageInputRef.current?.focus()); }
  }
  async function changeConversationMode(mode: 'default' | 'plan') {
    if (!sessionId || !sessionConnected || pendingOperation || reasoningSaving.has(sessionId)) return;
    const targetSession = sessionId;
    if (modeSaveSessions.current.has(targetSession)) throw new Error("正在切换模式，请稍候。");
    modeSaveSessions.current.add(targetSession);
    setModeSaving(current=>new Set([...current,targetSession]));
    try {
      const saved = await api.setConversationMode(targetSession, mode);
      setSnapshot(current=>applyConversationMode(current,targetSession,saved));
      const cached=snapshotCache.current.get(targetSession);
      if(cached) snapshotCache.current.set(targetSession,applyConversationMode(cached,targetSession,saved)!);
    } finally {
      modeSaveSessions.current.delete(targetSession);
      setModeSaving(current=>{const next=new Set(current);next.delete(targetSession);return next;});
    }
  }
  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const {command:planCommand,text:messageBody,references:messageReferences}=planComposerDraft(messageDraft,mentionRefs);
    const payload=composerMessage(messageBody.trim() ? messageBody : (fileDraft.length ? "请查看附件信息，并说明可以如何处理；执行或部署前先确认目标和需求。" : ""),messageReferences,mentionable.map(resource=>resource.id));
    const text=payload.text;
    if (!sessionId || !sessionConnected || stoppingTurn || pendingOperation || reasoningSaving.has(sessionId) || modeSaveSessions.current.has(sessionId)) return;
    if(planCommand){
      if(imageDraft.length||fileDraft.length){handleFailure(new Error("请先单独切换 Plan 模式，再发送附件。"));return;}
      try{await changeConversationMode(planCommand.prompt?'plan':activeSnapshot?.conversationMode==='plan'?'default':'plan');if(!planCommand.prompt){clearSubmitted(sessionId,composerDraft);setMention(null);return;}}
      catch(error){handleFailure(error);return;}
    }
    if (!modelConfigured) {setMention(null);void openSettings();return;}
    if (!text && !imageDraft.length) return;
    if (imageDraft.length && !bootstrap?.supportsImageInput) { handleFailure(new Error("当前模型未启用图片输入，请切换到支持图片的模型后发送。")); return; }
    const targetSession=sessionId;
    setMention(null);
    setPendingOperation("message");
    conversationScroll.current.following = true;
    try {
      await api.sendMessage(targetSession, text, payload.resourceIds, imageDraft, payload.references, undefined, fileDraft, queueMode, ignoreProjectMemory, payload.mentions);
      clearSubmitted(targetSession, composerDraft);
      await refreshCurrent();
    } catch (error) { handleFailure(error); }
    finally { setPendingOperation(""); }
  }
  async function decide(actionId: string, decision: "approve" | "reject", confirmation?: string) {
    if (!sessionConnected || pendingOperation || !activeSnapshot?.actions.some(action => action.id === actionId && action.status === "pending")) return;
    const action = activeSnapshot.actions.find(action => action.id === actionId)!;
    if (decision === "approve" && action.risk === "dangerous" && confirmation === undefined) {
      setDangerText(""); setDangerousAction(action); return;
    }
    setPendingOperation(actionId);
    try {
      await api.decide(actionId, decision, confirmation);
      setDangerousAction(null);
      await refreshCurrent();
      notify(decision === "approve" ? "已确认本次操作" : "已拒绝本次操作");
    } catch (error) { handleFailure(error); }
    finally { setPendingOperation(""); }
  }
  async function handoffAction(action: Action) {
    if (!sessionId || !sessionConnected || pendingOperation || !persistentMode || action.sessionId !== sessionId) return;
    setPendingOperation(`handoff:${action.id}`);
    try {
      const existing = action.terminalId ? conversationTerminals.find(item => item.id === action.terminalId && item.status === "ready") : latestReadyTerminal(action.resourceId);
      if (action.terminalId && !existing) throw new Error("审批绑定的终端已断开或正在使用，请拒绝此操作后重新调查。");
      const terminal = existing ?? await api.createTerminal(sessionId, action.resourceId);
      if (terminal.holder !== "agent") await api.terminalControl(sessionId, terminal.id, "agent");
      await refreshCurrent();
      notify(action.risk === "readonly" ? "终端已交接，只读检查自动执行。" : "终端已交接，请核对变更影响后确认本次操作。");
    } catch (error) { handleFailure(error); }
    finally { setPendingOperation(""); }
  }
  async function openTerminalFromSidebar(resourceId: string) {
    await openTerminalFor(resourceId);
  }
  function closeTerminalPanel() {
    setTerminalOpen(false);
    setTerminalOptionsOpen(false); setTerminalListOpen(false); setCommandEditorOpen(false);
    const trigger = document.getElementById(`resource-trigger-${terminalResource?.id}`);
    if (trigger) trigger.focus({preventScroll: true}); else messageInputRef.current?.focus({preventScroll: true});
  }
  async function openTerminalFor(resourceId: string, forceNew = false) {
    const resource = resourceMap.get(resourceId);
    if (!resource || !bootstrap || !catalog || pendingOperation || !persistentMode) return;
    setResourceTerminalMenu(null);
    setTerminalOpeningResource(resourceId);
    setTerminalError(""); setCommandDraft(""); setCommandError(""); setConfirmedCommand(null);
    setTerminalId(null); setTerminalHistory(null);
    setTerminalOpen(true);
    const connections = terminalConnections.current;
    const { attempt, started } = connections.begin(resourceId);
    setConnectingResources(connections.resourceIds());
    activeTerminalContext.current = attempt.context ?? null;
    setTerminalContext(attempt.context ?? null);
    setResourceTerminalSnapshot(null); setResourceLiveTerminals([]); setResourceTerminalConnected(false);
    // Revisit a pending host without issuing a second connection request.
    if (!started) return;
    try {
      const scope = await api.resourceTerminalContext(resourceId);
      const context = {...scope, resourceId};
      attempt.context = context;
      if (connections.isSelected(attempt)) { activeTerminalContext.current = context; setTerminalContext(context); }
      const [fresh, live] = await Promise.all([api.snapshot(context.sessionId), api.resourceTerminals(resourceId)]);
      if (connections.isSelected(attempt)) {
        setResourceTerminalSnapshot(fresh); setResourceLiveTerminals(live.terminals); setResourceTerminalConnected(true);
      }
      const existing = forceNew ? undefined : reusableResourceTerminal(fresh.terminals, resourceId, true);
      const terminal = existing ?? await api.createTerminal(context.sessionId, resourceId, resource.kind === "local" ? localShell : undefined, true);
      if (existing?.status === "ready" && existing.holder !== "user" && existing.holder !== "agent") await api.terminalControl(context.sessionId, existing.id, "user");
      if (connections.isSelected(attempt)) {
        activeTerminalContext.current = context; setTerminalContext(context);
        setTerminalId(terminal.id);
        await refreshResourceTerminal();
      }
    } catch (error) {
      if (connections.isSelected(attempt)) setTerminalError(readableError(error));
      handleFailure(error);
    } finally {
      connections.finish(attempt);
      setConnectingResources(connections.resourceIds());
      void refreshCatalog().catch(handleFailure);
    }
  }
  function selectTerminalTab(item: TerminalSession) {
    terminalConnections.current.selectTerminal();
    if (item.id === terminalId) { setTerminalListOpen(false); terminalControlRef.current?.focus(); return; }
    if (terminalContext || item.sessionId !== terminalSessionId) {
      const context = {sessionId: item.sessionId, resourceId: item.resourceId};
      activeTerminalContext.current = context; setTerminalContext(context);
      setResourceTerminalSnapshot(null); setResourceTerminalConnected(false);
      setResourceLiveTerminals(terminalList.filter(terminal => terminal.resourceId === item.resourceId));
    }
    setTerminalId(item.id); setTerminalHistory(terminalHistories[item.id] ?? null); setTerminalError("");
    setTerminalListOpen(false); setCommandDraft(""); setCommandError(""); setCommandEditorOpen(false); setConfirmedCommand(null);
  }
  async function refreshTerminal() {
    if (activeTerminalContext.current) await refreshResourceTerminal();
    else await refreshCurrent();
  }
  async function changeHolder(holder: "user" | "agent" | null) {
    if (!terminalSessionId || !terminalId || !terminalConnected || pendingOperation || !persistentMode) return;
    setPendingOperation(`terminal:${terminalId}`);
    try {
      await api.terminalControl(terminalSessionId, terminalId, holder);
      await refreshTerminal();
      notify(holder === "user" ? "已接管终端，专员停止后续输入" : holder === "agent" ? "已交给终端专员；只读自动执行，变更先确认，危险操作再次确认目标" : "已释放终端输入");
    } catch (error) { handleFailure(error); }
    finally { setPendingOperation(""); }
  }
  async function createSsh(event: FormEvent) {
    event.preventDefault();
    if (!sshProject || sshBusy) return;
    if (resourceKind === "ssh" && sshDraft.authMethod !== "password" && !sshDraft.privateKey) { setSshError("请选择本地私钥文件"); return; }
    setSshBusy(true); setSshError("");
    try {
      const v = serviceSettings;
      const settings = resourceKind === "docker" ? (v.ssh_asset_ref ? { ssh_asset_ref: v.ssh_asset_ref } : { endpoint: v.endpoint })
        : resourceKind === "redis" ? { host: v.host, port: v.port, credentialRef: v.credentialRef, tls: v.tls }
        : v.driver === "sqlite" ? { driver: v.driver, path: v.path } : { driver: v.driver, host: v.host, port: v.port, username: v.username, database: v.database, credentialRef: v.credentialRef, tls: v.tls, sslmode: v.tls ? "verify-full" : "disable" };
      const resource = resourceKind === "ssh" ? await api.createSshResource(sshProject, sshName.trim(), sshDraft, sshParent) : await api.createServiceResource(sshProject, sshName.trim(), resourceKind, settings, sshParent);
      await refreshCatalog();
      setSshProject(null); setSshParent(null); setSshDraft(emptySSH());
      navigate({ sessionId, resourceId: resource.id });
      notify("资源已添加；请在新会话中关联它");
    } catch (error) { setSshError(readableError(error)); }
    finally { setSshBusy(false); }
  }
  function terminalInput(data: string) {
    if (!terminalSessionId || !terminalId || !terminalConnected || currentTerminal?.holder !== "user" || !["ready", "busy"].includes(currentTerminal.status) || !currentTerminal.interactive && currentTerminal.status !== "busy") return;
    const session = terminalSessionId; const terminal = terminalId;
    inputQueue.current?.enqueue(session, terminal, data);
  }
  function terminalResize(cols: number, rows: number) {
    if (!terminalSessionId || !terminalId || !terminalConnected || currentTerminal?.status === "disconnected") return;
    void api.terminalResize(terminalSessionId, terminalId, cols, rows).catch(() => {});
  }
  async function disconnectTerminal() {
    if (!terminalSessionId || !terminalId || !terminalConnected || pendingOperation) return;
    setPendingOperation(`terminal:${terminalId}`);
    try { await api.terminalDisconnect(terminalSessionId, terminalId); await refreshTerminal(); }
    catch (error) { handleFailure(error); }
    finally { setPendingOperation(""); }
  }
  async function closeTerminalTab(item: TerminalSession) {
    if (!connected || pendingOperation) return;
    setPendingOperation(`terminal:${item.id}`);
    try {
      await api.closeResourceTerminal(item.resourceId, item.id);
      setTerminalHistories(current => { const next = {...current}; delete next[item.id]; return next; });
      await refreshTerminal(); await refreshCatalog();
      if (terminalId === item.id) {
        const next = terminalOptions.find(option => option.terminal.id !== item.id)?.terminal;
        if (next) selectTerminalTab(next);
        else { setTerminalId(null); closeTerminalPanel(); }
      }
    } catch (error) { handleFailure(error); }
    finally { setPendingOperation(""); }
  }

  async function closeResourceTerminal(resourceId: string, terminalId?: string) {
    if (!connected || pendingOperation) return;
    setPendingOperation(`resource-terminal:${resourceId}`);
    try {
      await api.closeResourceTerminal(resourceId, terminalId);
      await refreshCatalog();
      await refreshTerminal();
      notify(terminalId ? "终端已关闭，会话记录仍保留" : "该资源的终端已关闭，会话记录仍保留");
    } catch (error) { handleFailure(error); }
    finally { setPendingOperation(""); }
  }
  async function interruptTerminal() {
    if (!terminalSessionId || !terminalId || !terminalConnected || !persistentMode || currentTerminal?.status !== "busy" || pendingOperation) return;
    setPendingOperation(`terminal:${terminalId}`);
    try {
      await api.terminalInterrupt(terminalSessionId, terminalId);
      await refreshTerminal();
      notify("已请求中断命令；执行结果需核查。请勿直接重复提交。");
    } catch (error) { handleFailure(error); }
    finally { setPendingOperation(""); }
  }
  async function reviewCommand(event: FormEvent) {
    event.preventDefault();
    if (!commandDraft.trim() || !terminalConnected || !persistentMode || currentTerminal?.holder !== "user" || currentTerminal.status !== "ready" || commandBusy) return;
    if (commandDraft.length > 2000 || /[\r\n\0\x01-\x08\x0b-\x1f\x7f]/.test(commandDraft)) {setCommandError("只支持一条完整的单行命令（最多 2000 个字符）。"); return;}
    const target = commandTargetRef.current; const command = commandDraft;
    setCommandBusy(true); setCommandError(""); setDangerText(""); setDangerStage(false);
    try {
      const policy = await api.commandPolicy(command);
      if (commandTargetRef.current.session !== target.session || commandTargetRef.current.terminal !== target.terminal) return;
      setConfirmedPolicy(policy);
      if (policy.risk === "readonly") {
        await api.terminalCommand(target.session!, target.terminal!, command, false);
        setCommandDraft(""); await refreshTerminal(); notify("命令已提交，结果将显示在命令记录中");
      } else setConfirmedCommand(command);
      setCommandEditorOpen(false);
    } catch (error) {setCommandError(readableError(error));}
    finally {setCommandBusy(false);}
  }
  async function runCommand(command = confirmedCommand, confirmation?: string) {
    if (!terminalSessionId || !terminalId || !command || !terminalConnected || !persistentMode || currentTerminal?.holder !== "user" || currentTerminal.status !== "ready" || commandBusy) return;
    const target = commandTargetRef.current;
    setCommandBusy(true);
    try {
      const policy = await api.commandPolicy(command);
      if (commandTargetRef.current.session !== target.session || commandTargetRef.current.terminal !== target.terminal) return;
      setConfirmedPolicy(policy);
      if (policy.risk === "dangerous" && !dangerStage) {setDangerStage(true); return;}
      await api.terminalCommand(target.session!, target.terminal!, command, policy.risk !== "readonly", confirmation);
      setConfirmedCommand(null); setCommandDraft(""); await refreshTerminal(); notify("命令已提交，结果将显示在命令记录中");
    } catch (error) {handleFailure(error);}
    finally {setCommandBusy(false);}
  }

  useEffect(() => {
    if (!sessionConnected || pendingOperation || !activeSnapshot || messageBlocked) return;
    const action = activeSnapshot.actions.find(action => action.status === "pending" && action.risk === "readonly" && !readonlyAttempts.current.has(action.id) && conversationTerminals.some(terminal => terminal.resourceId === action.resourceId && (!action.terminalId || terminal.id === action.terminalId) && terminal.holder === "agent" && terminal.status === "ready"));
    if (!action) return;
    readonlyAttempts.current.add(action.id);
    // Existing pending read-only proposals also follow the new policy without another question.
    void api.decide(action.id, "approve").then(() => refreshCurrent()).catch(error => {
      if (!(error instanceof ApiRequestError && error.status === 409)) handleFailure(error);
      void refreshCurrent();
    });
  }, [activeSnapshot, conversationTerminals, sessionConnected, pendingOperation, messageBlocked]);

  if (authRequired) return <div className="gate-shell"><div className="gate-card">
    <Brand large />
    <div className="gate-rule" />
    <div className="gate-icon"><Glyph name="lock" size={24} /></div>
    <h1>连接你的 Lake 工作台</h1>
    <p>此服务需要访问令牌。验证后会建立仅供本次浏览器会话使用的安全 Cookie。</p>
    <form onSubmit={submitAuth} className="gate-form">
      <label htmlFor="auth-token">访问令牌</label>
      <input id="auth-token" type="password" autoComplete="off" autoFocus placeholder="输入访问令牌" value={authInput} onChange={event => setAuthInput(event.target.value)} />
      {authError && <p className="form-error" role="alert">{authError}</p>}
      <button className="button primary" type="submit" disabled={!authInput.trim() || authBusy}>{authBusy ? "正在验证…" : "连接工作台"}<Glyph name="arrow" size={16}/></button>
    </form>
  </div></div>;

  if (booting || (!catalog && !catalogError)) return <div className="gate-shell startup-loading" aria-busy="true">{bootLoadingVisible && <span role="status">正在加载工作台…</span>}</div>;

  if (catalogError || !catalog) return <div className="gate-shell"><div className="gate-card"><Brand large/><div className="gate-rule"/><div className="gate-icon warning"><Glyph name="alert" size={24}/></div><h1>工作台暂时无法连接</h1><p>{catalogError || "无法获取项目目录。"}</p><button className="button primary" onClick={() => void loadApp()}><Glyph name="refresh" size={16}/>重新连接</button></div></div>;

  const projectList = [...catalog.projects].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const sidebarProject = projectList.find(project => project.id === (sidebarProjectId ?? selectedProjectId)) ?? projectList[0];
  const navigationSearch = navigationQuery.trim().toLocaleLowerCase();
  const sidebarSessionsExpanded=!!navigationSearch||!closedSessionGroups.includes(sidebarProject?.id??"");
  const matchesNavigation = (name: string) => name.toLocaleLowerCase().includes(navigationSearch);
  const navigationProjects = projectList.filter(project => project.id === sidebarProject?.id && (!selectedTag || catalog.tags?.some(tag=>tag.id===selectedTag&&tag.projectId===project.id)) && (!navigationSearch || matchesNavigation(project.name)
    || catalog.sessions.some(session => session.projectId === project.id && matchesNavigation(session.title))
    || catalog.resources.some(resource => resource.projectId === project.id && matchesNavigation(resource.name))));
  const itemList = activeSnapshot ? timelineItems(activeSnapshot) : [];
  const terminalDrawer = <section className="terminal-panel-content" aria-label="会话持续终端">
    <div className="terminal-panel-header">
      <strong>终端</strong>
      <div className="terminal-header-actions">
        <button type="button" className="icon-button" aria-label="清屏" title="清屏" onClick={() => terminalControlRef.current?.clear()}><Glyph name="refresh" size={16}/></button>
        <button type="button" className="icon-button" aria-label="新建终端" title="新建终端" disabled={!terminalResource || !!pendingOperation || connectingResources.includes(terminalResource.id)} onClick={() => terminalResource && void openTerminalFor(terminalResource.id, true)}><Glyph name="plus" size={17}/></button>
        <button type="button" className="icon-button" aria-label="终端选项" title="终端选项" aria-expanded={terminalOptionsOpen} onClick={() => setTerminalOptionsOpen(value => !value)}>⋮</button>
        <button type="button" className="icon-button" aria-label="收起终端" title="收起终端，保留连接" onClick={closeTerminalPanel}><Glyph name="close" size={17}/></button>
      </div>
      {terminalOptionsOpen && <div className="terminal-action-menu">
        <label>本地 Shell<AppSelect value={localShell} onChange={event => setLocalShell(event.target.value)}>{["bash","zsh","sh","fish"].map(shell => <option key={shell}>{shell}</option>)}</AppSelect></label>
        <button type="button" disabled={!currentTerminal || currentTerminal.status !== "ready" || currentTerminal.holder !== "user"} onClick={() => { setTerminalOptionsOpen(false); setCommandEditorOpen(true); }}>运行完整命令…</button>
        {!terminalContext && currentTerminal?.holder === "user" && currentTerminal.status === "ready" && <button type="button" onClick={() => { setTerminalOptionsOpen(false); void changeHolder("agent"); }}>交给终端专员</button>}
        {currentTerminal?.status === "busy" && <button type="button" onClick={() => { setTerminalOptionsOpen(false); void interruptTerminal(); }}>中断命令</button>}
        {currentTerminal?.status !== "disconnected" && terminalId && <button type="button" onClick={() => { setTerminalOptionsOpen(false); void disconnectTerminal(); }}>断开连接</button>}
      </div>}
    </div>
    <div className="terminal-tab-bar">
      <button type="button" className="terminal-list-button" aria-expanded={terminalListOpen} onClick={() => setTerminalListOpen(value => !value)}><Glyph name="menu" size={15}/>列表<Glyph name="chevron" size={13}/></button>
      <div className="terminal-tabs" ref={terminalTabsRef} role="tablist" aria-label="选择终端">{terminalOptions.map(({terminal: item, label}) => <div className={`terminal-tab-wrap ${terminalId === item.id ? "selected" : ""}`} key={item.id} onContextMenu={event => { event.preventDefault(); setTerminalTabContext({terminal: item, x: event.clientX, y: event.clientY}); }}>
        <button type="button" role="tab" aria-label={label} title={label} aria-selected={terminalId === item.id} className="terminal-tab" onClick={() => selectTerminalTab(item)}><Glyph name="terminal" size={14}/><span className="terminal-tab-label">{label}</span><span className={`terminal-tab-dot ${item.status}`}/></button>
        <button type="button" className="terminal-tab-close" aria-label={`关闭 ${label}`} title="关闭终端" disabled={!!pendingOperation} onClick={() => void closeTerminalTab(item)}><Glyph name="close" size={12}/></button>
      </div>)}</div>
      {terminalListOpen && <div className="terminal-list-menu">{terminalOptions.map(({terminal: item, label}) => <button type="button" key={item.id} onClick={() => selectTerminalTab(item)}><Glyph name="terminal" size={14}/><span>{label}</span><small>{terminalLabels[item.status]}</small></button>)}{!terminalOptions.length && <span>暂无在线终端</span>}{terminalResource && <button type="button" disabled={!!pendingOperation || !terminalConnected || connectingResources.includes(terminalResource.id)} onClick={() => { setTerminalListOpen(false); void openTerminalFor(terminalResource.id, true); }}><Glyph name="plus" size={14}/><span>新建终端</span></button>}</div>}
    </div>
    <div className="drawer-body">
      {!terminalId && (terminalError ? <div className="terminal-load-error" role="alert">{terminalError}{terminalOpeningResource && <button type="button" disabled={!!pendingOperation} onClick={() => void openTerminalFor(terminalOpeningResource)}>重新连接</button>}</div> : <div className="terminal-placeholder" role="status">{terminalOpeningResource && connectingResources.includes(terminalOpeningResource) ? `正在连接 ${terminalResource?.name || "终端"}…` : "暂无在线终端，点击上方 + 新建终端"}</div>)}
      <div className="terminal-session">
        {terminalId && terminalError && <div className="terminal-load-error" role="alert">{terminalError}<button type="button" onClick={() => setTerminalRefresh(value => value + 1)}>重新读取</button></div>}
        {Object.values(terminalHistories).map(history => {
          const active = history.terminal.id === terminalId && terminalOpen && !terminalError;
          const item = terminalList.find(item => item.id === history.terminal.id) ?? history.terminal;
          return <div key={item.id} className="terminal-screen-slot" hidden={!active}><TerminalPane active={active} showCommandEntries={item.interactive !== true} controlRef={terminalControlRef} entries={history.entries} output={history.output} interactive={active && terminalConnected && item.holder === "user" && ["ready", "busy"].includes(item.status) && (item.interactive === true || item.status === "busy")} onInput={terminalInput} onResize={terminalResize}/></div>;
        })}
        {terminalId && !terminalError && !terminalHistories[terminalId] && <div className="terminal-placeholder">正在读取终端…</div>}
        {currentTerminal && (currentTerminal.status === "disconnected" || currentTerminal.status === "unknown" || !currentTerminal.interactive || currentTerminal.holder !== "user") && <div className="terminal-status-line"><span>{currentTerminal.status === "disconnected" ? "连接已断开 · 历史输出" : currentTerminal.holder === "agent" ? currentTerminal.interactive ? "Lake 正在使用终端 · 执行完成后恢复输入" : "终端专员正在持有输入" : currentTerminal.status === "unknown" ? "终端状态待核查" : "命令记录终端"}</span>{currentTerminal.holder !== "user" && currentTerminal.status === "ready" ? <button type="button" onClick={() => void changeHolder("user")}>接管输入</button> : currentTerminal.status !== "busy" && <button type="button" onClick={() => terminalResource && void openTerminalFor(terminalResource.id, true)}>打开交互终端</button>}</div>}
      </div>
    </div>
  </section>;

  return <div className={`app-shell ${terminalOpen ? "terminal-is-open" : ""}`}>
    {scheduleProject&&<ScheduledTasks key={scheduleProject.id} project={scheduleProject} onClose={()=>setScheduleProject(null)} onOpenSession={async id=>{await refreshCatalog();setScheduleProject(null);navigate({sessionId:id,resourceId:null});}}/>}
    {showWorkflows && workflowProject && <Workflows key={workflowProject.id} project={workflowProject} resources={catalog.resources.filter(resource => resource.projectId === workflowProject.id)} modelConfigured={modelConfigured} onClose={() => setWorkflowProject(null)} onOpenRun={async run => { await refreshCatalog(); setWorkflowProject(null); navigate({sessionId:run.sessionId,resourceId:null}); }}/>}
    {mobileMenu && <button className="mobile-scrim" aria-label="关闭项目导航" onClick={() => setMobileMenu(false)}/>}
    <aside className={`sidebar workspace-navigation ${mobileMenu ? "sidebar-open" : ""} ${bulkMode ? "is-bulk-selecting" : ""}`} aria-label="项目导航" inert={compactNavigation && !mobileMenu} aria-hidden={compactNavigation && !mobileMenu}>
      <div className="sidebar-brand-row"><Brand icon={false}/><button className="icon-button mobile-only" title="关闭导航" aria-label="关闭导航" onClick={() => setMobileMenu(false)}><Glyph name="close"/></button></div>
      {sidebarProject && <div className="sidebar-project-picker">
        <BulkCheckbox target={{kind:"project",id:sidebarProject.id,projectId:sidebarProject.id,name:sidebarProject.name}} selection={bulkSelection}/>
        <ProjectSwitcher projects={projectList} value={sidebarProject.id} onChange={id=>{setSidebarProjectId(id);setNavigationQuery("");setSelectedTag(null);setBulkMode(false);setBulkSelected([]);const session=catalog.sessions.filter(item=>item.projectId===id).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];navigate({sessionId:session?.id??null,resourceId:null});}}/>
        <button type="button" className="icon-button" aria-label={`管理项目 ${sidebarProject.name}`} title="更多操作" aria-haspopup="menu" disabled={!connected} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();setProjectContext({project:sidebarProject,x:rect.right,y:rect.bottom});}}><Glyph name="more" size={16}/></button>
      </div>}
      <label className="navigation-search"><Glyph name="search" size={15}/><input ref={navigationInput} type="search" value={navigationQuery} onChange={event => setNavigationQuery(event.target.value)} placeholder="搜索当前项目…" aria-label="搜索当前项目"/>{navigationQuery ? <button type="button" aria-label="清除搜索" onClick={() => setNavigationQuery("")}><Glyph name="close" size={13}/></button> : <span className="navigation-search-key">{/Mac/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'}</span>}<span className="navigation-search-divider" aria-hidden="true"/></label>
      {bulkMode && <div className="bulk-navigation-toolbar"><button type="button" onClick={()=>{setBulkMode(false);setBulkSelected([]);}}>完成</button><span>已选 {bulkSelected.length} 项</span><button type="button" disabled={!bulkSelected.length || !!pendingOperation} onClick={() => setBulkSelected([])}>清空</button><button type="button" className="danger-text" disabled={!bulkSelected.length || !!pendingOperation} onClick={() => setBulkConfirmation(orderBulkDeletion(bulkSelected, catalog))}>删除所选</button></div>}
      <SidebarScrollArea>
        {sidebarProject&&<div className="nav-heading sidebar-session-heading" hidden={bulkMode}>
          <button type="button" className="nav-section-toggle" aria-label={`${sidebarSessionsExpanded?"折叠":"展开"}${sidebarProject.name}的会话`} aria-expanded={sidebarSessionsExpanded} aria-controls={navigationProjects.length?`project-sessions-${sidebarProject.id}`:undefined} disabled={!navigationProjects.length} onClick={()=>setClosedSessionGroups(items=>sidebarSessionsExpanded?[...items,sidebarProject.id]:items.filter(id=>id!==sidebarProject.id))}><Glyph name="chevron" size={13} className={sidebarSessionsExpanded?"chevron-open":""}/><span>{navigationSearch?"匹配会话":allSessionGroups.includes(sidebarProject.id)?"全部会话":"最近会话"}</span></button>
          <button type="button" ref={newSessionButton} className="sidebar-new-session" hidden={bulkMode} disabled={!connected||!!pendingOperation} aria-label="新对话" aria-keyshortcuts="Meta+N Control+N" title={`新对话（${/Mac/.test(navigator.platform)?'⌘ N':'Ctrl N'}）`} onClick={()=>{setClosedSessionGroups(items=>items.filter(id=>id!==sidebarProject.id));openSessionDialog(sidebarProject.id);}}><Glyph name="edit" size={14}/></button>
        </div>}
        {navigationProjects.length ? navigationProjects.map(project => {
          const sessionsExpanded = !!navigationSearch || !closedSessionGroups.includes(project.id);
          const projectMatches = matchesNavigation(project.name);
          const sessions = catalog.sessions.filter(session => session.projectId === project.id && (!selectedTag || session.tags?.some(tag=>tag.id===selectedTag)) && (!navigationSearch || projectMatches || matchesNavigation(session.title))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          const allSessions = allSessionGroups.includes(project.id);
          const visibleSessions = sidebarSessions(sessions, route.sessionId, !!navigationSearch || allSessions);
          const projectResources = catalog.resources.filter(resource => resource.projectId === project.id && (!navigationSearch || projectMatches || matchesNavigation(resource.name)));
          return <div className="project-group" key={project.id}>
            <div className="project-contents">
              {showWorkflows && <button type="button" className="workflow-entry" onClick={() => setWorkflowProject(project)} disabled={!connected}><Glyph name="layers" size={15}/>运维工作流</button>}
              {bulkMode&&<div className="nav-heading"><button type="button" className="nav-section-toggle" aria-label={`${sessionsExpanded ? "折叠" : "展开"}${project.name}的会话`} aria-expanded={sessionsExpanded} aria-controls={`project-sessions-${project.id}`} onClick={() => setClosedSessionGroups(items => sessionsExpanded ? [...items, project.id] : items.filter(id => id !== project.id))}><Glyph name="chevron" size={13} className={sessionsExpanded ? "chevron-open" : ""}/><span>{navigationSearch?"匹配会话":allSessions?"全部会话":"最近会话"} <small className="session-group-count">{sessions.length}</small></span></button>{bulkMode && <button className="bulk-group-toggle" type="button" disabled={!connected || !!pendingOperation || !sessions.length} aria-label={`全选 ${project.name} 的会话`} onClick={() => toggleBulkGroup(sessions.map(session => ({kind:"session",id:session.id,projectId:project.id,name:session.title})))}>全选</button>}</div>}
              <div id={`project-sessions-${project.id}`} hidden={!sessionsExpanded}>{sessions.length ? visibleSessions.map(session => <div className={`nav-row-wrap ${bulkMode ? "bulk-session-row" : ""}`} key={session.id} onContextMenu={event => {event.preventDefault(); if (connected) {setProjectContext(null); setSessionContext({session, x: event.clientX, y: event.clientY});}}}>
                <BulkCheckbox target={{kind:"session",id:session.id,projectId:session.projectId,name:session.title}} selection={bulkSelection}/>
                <button className={`nav-row session-nav-row ${route.sessionId === session.id && !route.resourceId ? "active" : ""}`} onClick={() => bulkMode ? toggleBulkTarget({kind:"session",id:session.id,projectId:session.projectId,name:session.title}) : navigate({ sessionId: session.id, resourceId: null })} aria-current={route.sessionId === session.id && !route.resourceId ? "page" : undefined}>
                  <Glyph name={session.icon??"chat"} size={16}/><span className="nav-row-text"><strong>{session.title}</strong><SessionListTags tags={session.tags??[]}/><small>{sessionLabels[session.status]}</small></span>{session.status === "investigating" && <span className="session-activity" title="正在回复"><ActivityIndicator/></span>}{session.status === "waiting_approval" && <span className="attention-dot" title="等待确认"/>}
                </button>
                <SessionActions session={session} tags={catalog.tags??[]} className="session-more" label={`管理会话 ${session.title}`} disabled={!connected||!!pendingOperation}
                  menuPosition={sessionContext?.session.id===session.id?sessionContext:null} onMenuChange={position=>setSessionContext(position?{session,...position}:null)}
                  view={session.id===selectedSession?.id?(isPlansPage?'plans':conversationMode):''} hasViews={session.id===selectedSession?.id&&!!activeSnapshot?.ai} onView={value=>{if(value==='plans'){openSessionPlans(session.id);return;}if(isPlansPage)navigate({sessionId:session.id,resourceId:null});pauseFollowing();setConversationMode(value as "conversation"|"activity"|"evidence");conversationRef.current?.scrollTo({top:0});setMobileMenu(false);}}
                  onEdit={()=>setEditSession(session)} onDelete={()=>{setDeleteError("");setDeleteTarget(session);}} onRefresh={async()=>{await refreshCatalog();}}
                  onSaved={saved=>{setSnapshot(current=>current&&current.session.id===saved.id?{...current,session:saved}:current);setCatalog(current=>current?{...current,sessions:current.sessions.map(s=>s.id===saved.id?saved:s)}:current);}}/>
              </div>) : <p className="nav-empty">{navigationSearch ? "没有匹配的会话" : "还没有会话"}</p>}{sessions.length > 5 && <button type="button" className="nav-show-more" aria-expanded={allSessions} onClick={() => setAllSessionGroups(items => allSessions ? items.filter(id => id !== project.id) : [...items, project.id])}>{allSessions ? "收起历史会话" : `查看全部 ${sessions.length} 个会话`}</button>}</div>
              {<ResourceTree selection={bulkSelection} onSelectAll={() => toggleBulkGroup(bulkCatalogTargets(catalog).filter(target => target.projectId === project.id && ["resource","folder"].includes(target.kind)))} onDelete={setNavigationDelete} project={project} resources={projectResources} nodes={navigationSearch && !projectMatches ? resourceSearchNodes(project.id, catalog.resourceTree ?? [], projectResources) : catalog.resourceTree ?? []} filtering={!!navigationSearch && !projectMatches} disabled={!connected} refresh={refreshCatalog} onImport={() => { setImportHexhub(false); setImportProject(project); }} onAddResource={(parentId) => { setSshProject(project.id); setSshParent(parentId); setSshName(""); setSshDraft(emptySSH()); setSshError(""); }} renderResource={resource => {
                const terminalResourceRow=["local","ssh"].includes(resource.kind);
                const addToConversationDisabled=!sessionConnected || !!pendingOperation || selectedSession?.projectId!==resource.projectId || !mentionable.some(item=>item.id===resource.id);
                const addToConversationTitle=!selectedSession ? "请先打开一个对话" : selectedSession.projectId!==resource.projectId ? "请先打开此项目的对话" : "添加到对话";
                const live = resourceTerminals.filter(t => t.resourceId === resource.id && t.status !== "disconnected").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
                return <div key={resource.id} className="resource-nav-wrap" ref={resourceTerminalMenu === resource.id ? resourceMenuRef : undefined}><div className={`resource-nav-row ${terminalResourceRow?"with-terminal-actions":"with-resource-actions"}`} onContextMenu={event => {if (["local", "ssh"].includes(resource.kind)) {event.preventDefault(); event.stopPropagation(); if (connected) {setResourceTerminalMenu(null); setResourceConfigContext({resource, x:event.clientX, y:event.clientY});}}}}>
                  <button id={`resource-trigger-${resource.id}`} className={`nav-row resource-row ${route.resourceId === resource.id || terminalOpen && terminalResource?.id === resource.id ? "active" : ""}`} onClick={() => { if (bulkMode) {if(resource.kind !== "local")toggleBulkTarget({kind:"resource",id:resource.id,projectId:resource.projectId,name:resource.name}); return;} if (["local", "ssh"].includes(resource.kind)) { setResourceTerminalMenu(current => current === resource.id ? null : resource.id); void refreshCatalog().catch(handleFailure); } else navigate({ sessionId: route.sessionId, resourceId: resource.id }); }} aria-expanded={["local", "ssh"].includes(resource.kind) ? resourceTerminalMenu === resource.id : undefined} aria-current={route.resourceId === resource.id ? "page" : undefined}>
                    <ResourceIcon kind={resource.kind}/><span className="nav-row-text"><strong>{resource.name}</strong></span>{connected && live.some(terminal=>terminal.status==="ready"||terminal.status==="busy") && <span className="resource-indicator available resource-connection-indicator" role="img" aria-label="终端已连接" title="终端已连接"/>}{connectingResources.includes(resource.id) && <span className="resource-inline-status">连接中</span>}
                  </button>
                  <button type="button" className="resource-terminal-button resource-add-to-chat" aria-label={`添加到对话：${resource.name}`} title={addToConversationTitle} disabled={addToConversationDisabled} onClick={()=>addResourceToConversation(resource)}><Glyph name="chatAdd" size={15}/></button>
                  {["local", "ssh"].includes(resource.kind) && <>
                    <button type="button" className="resource-terminal-button resource-terminal-quick" aria-label={`一键打开 ${resource.name} 的终端`} disabled={!connected || !persistentMode || !!pendingOperation || resource.status !== "available"} onClick={() => void openTerminalFromSidebar(resource.id)} title={connectingResources.includes(resource.id) ? "查看连接进度" : live.length ? "打开已有终端" : "创建并打开终端"}><Glyph name="terminal" size={15}/></button>
                    <button type="button" className="resource-terminal-button resource-terminal-manage" aria-label={`管理 ${resource.name} 的终端`} aria-expanded={resourceTerminalMenu === resource.id} disabled={!connected} onClick={() => { setResourceTerminalMenu(current => current === resource.id ? null : resource.id); void refreshCatalog().catch(handleFailure); }} title="管理终端"><Glyph name="more" size={16}/></button>
                  </>}
                </div>{resourceTerminalMenu === resource.id && <ResourceTerminalMenu anchor={resourceMenuRef} menuRef={resourcePopupRef} label={`${resource.name} 终端`}>
                  <div className="resource-terminal-heading"><div><strong title={resource.name}>{resource.name}</strong><small>终端管理</small></div><button type="button" onClick={() => { setResourceTerminalMenu(null); document.getElementById(`resource-trigger-${resource.id}`)?.focus(); }} aria-label="收起资源终端"><Glyph name="close" size={15}/></button></div>
                  <div className="resource-terminal-actions">
                    <button type="button" className="resource-open-terminal" aria-label={`打开 ${resource.name} 的终端`} disabled={!connected || !persistentMode || !!pendingOperation || resource.status !== "available"} onClick={() => void openTerminalFromSidebar(resource.id)}><Glyph name="terminal" size={17}/><span><strong>打开终端</strong><small>{connectingResources.includes(resource.id) ? "查看连接进度" : live.length ? "继续使用已有连接" : "连接此资源"}</small></span><Glyph name="arrow" size={15}/></button>
                    <button type="button" className="resource-new-terminal" aria-label={`为 ${resource.name} 新建终端`} disabled={!connected || !persistentMode || !!pendingOperation || connectingResources.includes(resource.id) || resource.status !== "available"} onClick={() => void openTerminalFor(resource.id, true)}><Glyph name="plus" size={17}/><span><strong>新建终端</strong><small>为此资源新增独立连接</small></span><Glyph name="arrow" size={15}/></button>
                  </div>
                  <div className="resource-terminal-list-heading"><span>在线终端</span><small>{live.length}</small></div>
                  <div className="resource-terminal-connections">{live.length ? live.map((t, i) => <div className="resource-terminal-item" key={t.id}><div><strong>终端 {i + 1}</strong><small title={t.sessionTitle || "独立连接"}>{t.sessionTitle || "独立连接"}</small></div><span className={`resource-terminal-state state-${t.status}`}><i/>{t.status === "busy" ? "执行中" : t.status === "connecting" ? "连接中" : t.status === "unknown" ? "待核查" : "空闲"}<small>{t.holder === "agent" ? "Lake" : "用户"}</small></span><button type="button" title={`关闭终端 ${i + 1}`} aria-label={`关闭 ${t.sessionTitle || "资源"} 的终端 ${i + 1}`} disabled={!!pendingOperation} onClick={() => void closeResourceTerminal(resource.id, t.id)}><Glyph name="close" size={14}/></button></div>) : <p className="resource-terminal-empty">暂无在线终端</p>}</div>
                  {live.some(t => t.status === "busy") && <p className="resource-terminal-note">关闭执行中的终端会中断当前命令。</p>}
                  <div className="resource-terminal-footer"><button type="button" className="resource-view-info" aria-label={`编辑 ${resource.name} 的终端配置`} disabled={!connected} onClick={() => {setResourceTerminalMenu(null); setEditTerminalResource(resource);}}>编辑配置</button><button type="button" className="resource-view-info" onClick={() => { setResourceTerminalMenu(null); navigate({sessionId, resourceId: resource.id}); }}><Glyph name="server" size={14}/>资源信息</button>{live.length > 1 && <button type="button" className="resource-terminal-close-all" disabled={!!pendingOperation} onClick={() => void closeResourceTerminal(resource.id)}>关闭全部</button>}{resource.kind !== "local" && <button type="button" className="resource-terminal-delete" disabled={!connected || !!pendingOperation} onClick={() => {setResourceTerminalMenu(null); setNavigationDelete({kind:"resource", id:resource.id, projectId:resource.projectId, name:resource.name});}}>删除资源</button>}</div>
                </ResourceTerminalMenu>}</div>;
              }}/>}
            </div>
          </div>;
        }) : <div className="sidebar-empty"><Glyph name={navigationSearch ? "search" : "layers"} size={25}/><p>{navigationSearch ? "没有匹配的项目、会话或资源" : "还没有项目"}</p>{navigationSearch ? <button onClick={() => setNavigationQuery("")}>清除搜索</button> : <button onClick={openProjectDialog} disabled={!connected}>创建第一个项目</button>}</div>}
      </SidebarScrollArea>
      <SidebarUtilities key={sidebarProject?.id} tags={(catalog.tags??[]).filter(tag=>tag.projectId===sidebarProject?.id)} sessions={catalog.sessions} selectedTag={selectedTag} onSelectTag={setSelectedTag} onManageTags={()=>{const project=sidebarProject;if(project)setTagProject(project);else openProjectDialog();}} onSession={id=>navigate({sessionId:id,resourceId:null})} onSettings={()=>void openSettings()} onTrash={()=>setTrashOpen(true)} onSchedules={sidebarProject?()=>setScheduleProject(sidebarProject):undefined} booting={booting} connected={connected} modelConfigured={modelConfigured}/>

    </aside>

    <main className={`workspace${selectedSession&&!selectedResource&&!isPlansPage?" has-floating-header":""}`} onDragOver={event=>{if(selectedSession&&!selectedResource&&!isPlansPage&&Array.from(event.dataTransfer.types).includes("Files")){event.preventDefault();event.dataTransfer.dropEffect="copy";setAttachmentDragOver(true);}}} onDragLeave={event=>{if(!(event.relatedTarget instanceof Node)||!event.currentTarget.contains(event.relatedTarget))setAttachmentDragOver(false);}} onDrop={event=>{if(!selectedSession||selectedResource||isPlansPage||!Array.from(event.dataTransfer.types).includes("Files"))return;event.preventDefault();event.stopPropagation();setAttachmentDragOver(false);void attachFiles(clipboardFiles(event.dataTransfer));}}>
      <header className="workspace-header">
        {selectedSession && !selectedResource && !isPlansPage && <span className="workspace-header-glass" aria-hidden="true"/>}
        {selectedSession && !selectedResource && !isPlansPage && <HeaderSweep key={selectedSession.id} active={currentSessionStatus === "investigating"}/>}
        <button className="icon-button mobile-only" aria-label="打开项目导航" onClick={() => setMobileMenu(true)}><Glyph name="menu" size={21}/></button>
        <div className="breadcrumbs"><Glyph name="panel" size={17}/><span className="crumb-project">{projectList.find(project => project.id === (selectedResource?.projectId ?? selectedSession?.projectId))?.name ?? "项目"}</span><span className="crumb-slash">/</span><strong><Glyph name={selectedResource ? selectedResource.kind==='ssh'?'server':selectedResource.kind : selectedSession?.icon??'document'} size={15}/><span className="crumb-title" title={selectedResource?.name ?? selectedSession?.title ?? "概览"}>{selectedResource?.name ?? selectedSession?.title ?? "概览"}</span></strong>{selectedSession && !selectedResource && <SessionStateBadge session={selectedSession} {...currentSessionPresentation}/>}</div>
      </header>

      {!persistentMode && <div className="system-banner model-banner" role="status"><Glyph name="alert" size={18}/><span>服务端不支持持续终端。请核对服务端版本。</span></div>}
      {connection.warning && warningSessionId === sessionId && <div className="system-banner offline-banner" role="alert"><Glyph name="alert" size={18}/><span>{visibleSessionError || "实时连接已断开。当前内容可能不是最新状态，操作已暂停。"}</span><button onClick={() => sessionId ? setSessionReload(value => value + 1) : void loadApp()}><Glyph name="refresh" size={15}/>重试</button></div>}
      {activeSnapshot?.ai?.memoryStatus === "backlog_full" && <div className="system-banner model-banner" role="status"><Glyph name="alert" size={18}/><span>项目记忆待处理队列已满，本轮未自动学习。请在项目记忆中查看任务状态。</span>{selectedProjectId && <button onClick={() => {const project = projectList.find(item => item.id === selectedProjectId); if (project) setMemoryProject(project);}}>查看项目记忆</button>}</div>}

      {selectedResource ? <><ResourceDetail resource={selectedResource} project={projectList.find(project => project.id === selectedResource.projectId)} sessions={catalog.sessions.filter(session => session.projectId === selectedResource.projectId)} selectedSession={selectedSession} terminalList={resourceTerminals} disabled={!connected || !!pendingOperation} onBack={() => navigate({ sessionId, resourceId: null })} onNewSession={() => openSessionDialog(selectedResource.projectId)} onSession={id => navigate({ sessionId: id, resourceId: null })} onEdit={() => setEditTerminalResource(selectedResource)} />
        </> : sessionId && selectedSession ? isPlansPage ? <SessionPlansPage key={sessionId} session={selectedSession} snapshot={activeSnapshot} error={visibleSessionError} disabled={!sessionConnected||turnActive||!!pendingOperation||modeSaving.has(sessionId)} onBack={returnToConversation} onRetry={()=>setSessionReload(value=>value+1)} onRevise={()=>{returnToConversation();requestAnimationFrame(()=>messageInputRef.current?.focus());}} onExecuted={async()=>{await refreshCurrent();returnToConversation();}}/> : <div className="session-view">
        <section id="session-view-panel" tabIndex={-1} ref={conversationRef} onWheel={event => { if (pausesConversationFollow(event.currentTarget,event.deltaY)) pauseFollowing(); }} onPointerDown={event => {
          // Only grabbing the native scrollbar pauses on pointer-down. Clicking
          // text or toggling a short progress row is not a scroll gesture.
          const box=event.currentTarget, rect=box.getBoundingClientRect();
          if (event.target===box && (event.clientX < rect.left+box.clientLeft || event.clientX >= rect.left+box.clientLeft+box.clientWidth)) inspectConversation();
        }} onTouchMove={inspectConversation} onPointerMove={event => { if(event.buttons===1&&window.getSelection()?.type==='Range')inspectConversation(); }} onKeyDown={event => {
          const target=event.target as HTMLElement;
          if(target.closest('input,textarea,[contenteditable="true"]'))return;
          const direction=["ArrowUp","PageUp","Home"].includes(event.key)?-1:["ArrowDown","PageDown","End"].includes(event.key)?1:0;
          if(direction&&pausesConversationFollow(event.currentTarget,direction))pauseFollowing();
        }} onScroll={event => { if (conversationFollower.current?.animating) return; conversationScroll.current.following = atConversationTail(event.currentTarget); }} className="conversation" aria-label="会话记录">
          {!activeSnapshot ? visibleSessionError ? <div className="timeline-empty"><div className="empty-icon"><Glyph name="refresh" size={24}/></div><h2>会话未能加载</h2><p>{visibleSessionError}</p><button className="button secondary" onClick={() => setSessionReload(value => value + 1)}><Glyph name="refresh" size={16}/>重新获取</button></div> : <div className="session-loading" aria-busy="true">{loadingSessionId === sessionId && <span role="status">正在加载会话…</span>}</div> : (itemList.length || !!activeSnapshot.sre?.tasks.length || !!activeSnapshot.ai?.operationOutcomes?.length) ? <div className="timeline-list">
            {activeSnapshot?.ai ? <AITranscript key={sessionId} refresh={refreshCurrent} snapshot={activeSnapshot} mode={conversationMode} onOpenPlans={openPlans} onInspect={inspectConversation} onStopTurn={() => void stopCurrentTurn()} stopping={stoppingTurn} disabled={!sessionConnected || modeSaving.has(sessionId)} renderAction={action => <TimelineNode entry={{ kind: "action", at: action.createdAt, id: action.id, item: action }} resourceMap={resourceMap} sessionTitle={selectedSession.title} disabled={!sessionConnected || !!pendingOperation} pendingOperation={pendingOperation} terminals={conversationTerminals} onDecision={decide} onHandoff={handoffAction} persistentMode={persistentMode} onResource={resourceId => navigate({ sessionId, resourceId })}/>} /> : itemList.map(entry => <TimelineNode key={`${entry.kind}:${entry.id}`} entry={entry} resourceMap={resourceMap} sessionTitle={selectedSession.title} disabled={!sessionConnected || messageBlocked || !!pendingOperation} pendingOperation={pendingOperation} terminals={conversationTerminals} onDecision={decide} onHandoff={handoffAction} persistentMode={persistentMode} onResource={resourceId => navigate({ sessionId, resourceId })} />)}
            {selectedSession.status === "investigating" && !activeSnapshot.ai && <div className="timeline-item item-thinking" role="status" aria-live="polite"><span className="timeline-point"><Glyph name="spark" size={15}/></span><div className="timeline-content"><div className="thinking-line"><span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span><span>正在处理…</span></div></div></div>}
          </div> : <div className="timeline-empty"><div className="empty-icon"><Glyph name="chat" size={25}/></div><h2>从一个问题开始</h2><p>描述你看到的故障或想核实的现象。Lake 会把调查过程、证据和需要确认的操作留在这里。</p></div>}
        </section>
        <div className="composer-dock">{activeSnapshot?.ai && <AIControls snapshot={activeSnapshot} refresh={refreshCurrent} optionsOpen={agentOptionsOpen} onCloseOptions={() => setAgentOptionsOpen(false)} permissionsOpen={permissionsOpen} permissionAnchor={permissionButtonRef} onClosePermissions={() => setPermissionsOpen(false)}/>}<PendingMessages key={sessionId} sessionId={sessionId} queue={activeSnapshot?.messageQueue ?? {paused:false,revision:0,lastError:"",items:[]}} disabled={!sessionConnected} active={turnActive} sendShortcut={sendShortcut} resourceIds={mentionedResourceIds} onUpdated={messageQueue => setSnapshot(current => current?.session.id===sessionId && messageQueue.revision>=(current.messageQueue?.revision ?? 0) ? {...current,messageQueue} : current)}/>{activeSnapshot?.conversationMode==='plan'&&<p className="plan-mode-hint" role="status">Plan 模式 · 只读调查与制定方案，确认计划后再执行。{activeSnapshot.sre?.enabled?'SRE 协作将在退出 Plan 模式后恢复。':''}</p>}<form className="composer" onSubmit={sendMessage}><label htmlFor="message-input" className="visually-hidden">给 Lake 的消息</label><div className={`composer-input${attachmentDragOver?" attachment-drop-active":""}`}>
          {mention && <ComposerMentions options={mentionMatches} allOptions={allMentionOptions} index={mentionIndex} category={mentionCategory} onActive={index=>setMention(current=>current&&current.index!==index?{...current,index}:current)} onCategory={kind=>{setMentionCategory(kind);setMention({...mention,index:0});}} onSelect={insertMention} loading={mentionExtensions.loading} error={mentionExtensions.error} onReload={mentionExtensions.reload} onClose={()=>setMention(null)} onImport={()=>{const target=projectList.find(item=>item.id===selectedSession?.projectId);setMention(null);if(target){setImportHexhub(true);setImportProject(target);}}}/>}
          {attachmentUploading&&<p className="attachment-upload-status" role="status">正在上传：{attachmentUploading}</p>}{attachmentDragOver&&<p className="attachment-upload-status" role="status">松开以添加文件 · 每个最多 512 MiB</p>}{fileDraft.length > 0 && <div className="text-file-drafts">{fileDraft.map(file => <span key={file.sourceId}><Glyph name="file" size={14}/>{file.name}{file.sizeBytes!==undefined&&<small>{fileSize(file.sizeBytes)}</small>}<button type="button" aria-label={`移除 ${file.name}`} onClick={() => setFileDraft(files => files.filter(item => item.sourceId !== file.sourceId))}><Glyph name="close" size={14}/></button></span>)}</div>}{imageDraft.length > 0 && <div className="image-drafts">{imageDraft.map(image => <figure key={image.id}><img src={`data:${image.mimeType};base64,${image.base64}`} alt={image.name || "待发送图片"}/><figcaption title={image.name}>{image.name || "剪贴板图片"}</figcaption><button type="button" aria-label={`移除 ${image.name || "图片"}`} onClick={() => setImageDraft(images => images.filter(item => item.id !== image.id))}><Glyph name="close" size={14}/></button></figure>)}</div>}{modelConfigured && imageDraft.length > 0 && !bootstrap?.supportsImageInput && <p className="composer-image-hint" role="status">当前模型不接受图片输入，请切换模型或在模型设置中手动调整。</p>}<div className="composer-body"><ComposerTextInput key={sessionId} sessionId={sessionId!} references={mentionRefs} renderReference={ref=><>{ref.kind==="role"?<AgentIcon role={ref.resourceId as AgentIconName} size={14}/>:ref.kind==="resource"?<ResourceIcon kind={resourceMap.get(ref.resourceId)?.kind??"ssh"} size={13}/>:<Glyph name={ref.kind==="skill"?"book":"plug"} size={13}/>}<span>{ref.label.slice(1)}</span>{ref.kind!=="resource"&&<small>{ref.kind==="role"?"专员":ref.kind==="skill"?"Skill":"MCP"}</small>}</>} modelId={bootstrap?.modelId??undefined} modelSource={bootstrap?.modelSelection?.providerId} history={(activeSnapshot?.messages??[]).filter(message=>message.role==="user").slice(-8).map(message=>message.text)} completionBlocked={!!mention||!completionEnabled||!modelConfigured} onComplete={next=>{setMessageDraft(next);syncMention(next,next.length);}} id="message-input" ref={messageInputRef} role="combobox" aria-haspopup="listbox" aria-autocomplete={mention?"list":"inline"} aria-expanded={!!mention} aria-controls={mention?"composer-mention-options":undefined} aria-activedescendant={mention&&mentionMatches[mentionIndex]?mentionOptionId(mentionMatches[mentionIndex]!):undefined} placeholder={queueMode ? "继续输入，稍后发送…" : activeSnapshot?.conversationMode === "plan" ? "描述目标或修改意见，Lake 会先制定计划…" : pendingApproval ? "可以继续讨论，操作由确认按钮单独处理" : "想让 Lake 帮你做什么？"} value={messageDraft} onPaste={event => { const files = clipboardFiles(event.clipboardData); if (!files.length) return; event.preventDefault(); void attachFiles(files); }} onChange={(value,refs,caret)=>{setMessageDraft(value);setMentionRefs(refs);syncMention(value,caret);}} disabled={!sessionConnected || !!pendingOperation} onCompositionStart={() => messageComposition.current.start()} onCompositionEnd={() => messageComposition.current.end()} onBlur={() => { messageComposition.current = new CompositionGuard(); }} onKeyDown={event => {
            if (messageComposition.current.ignores(event.nativeEvent)) return;
            if (mention) {
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMention(null); return; }
              const category=nextMentionCategory(mentionCategory,allMentionOptions,event);
              if(category!==null){event.preventDefault();setMentionCategory(category);setMention({...mention,index:0});return;}
              if (!mentionMatches.length) { if(event.key==="Enter")event.preventDefault(); return; }
              if (event.key === "ArrowDown") { event.preventDefault(); setMention({ ...mention, index: (mentionIndex + 1) % mentionMatches.length }); return; }
              if (event.key === "ArrowUp") { event.preventDefault(); setMention({ ...mention, index: (mentionIndex - 1 + mentionMatches.length) % mentionMatches.length }); return; }
              if ((event.key === "Enter" || event.key === "Tab") && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) { event.preventDefault(); insertMention(mentionMatches[mentionIndex]!); return; }
              if (event.key === "Escape") { event.preventDefault(); setMention(null); return; }
            }
            if (isSendKey(event.nativeEvent, sendShortcut)) { event.preventDefault(); event.currentTarget.closest("form")?.requestSubmit(); }
          }}/><div className="composer-send-actions">{turnActive && hasMessageDraft && <button type="button" className="send-button queued-stop-button" aria-label="停止本轮" title="停止本轮，保留待发送消息" aria-busy={stoppingTurn} disabled={stoppingTurn || !sessionConnected} onClick={() => void stopCurrentTurn()}><Glyph name="stop" size={15}/></button>}<button className={`send-button${turnActive && !hasMessageDraft ? " stop-button" : ""}`} type={turnActive && !hasMessageDraft ? "button" : "submit"} aria-label={turnActive && !hasMessageDraft ? "停止本轮" : !modelConfigured ? "连接模型" : queueMode ? "加入待发送队列" : "发送消息"} title={turnActive && !hasMessageDraft ? "停止本轮" : !modelConfigured ? "连接模型，保留当前草稿" : `${queueMode ? "加入待发送队列" : "发送消息"}（${sendShortcutLabel}）`} aria-busy={stoppingTurn} onClick={turnActive && !hasMessageDraft ? () => void stopCurrentTurn() : undefined} disabled={turnActive && !hasMessageDraft ? stoppingTurn || !sessionConnected : !sessionConnected || !!pendingOperation || reasoningSaving.has(sessionId) || modeSaving.has(sessionId) || stoppingTurn || (modelConfigured && (!hasMessageDraft || (imageDraft.length > 0 && !bootstrap?.supportsImageInput)))}><Glyph name={turnActive && !hasMessageDraft ? "stop" : !modelConfigured ? "plug" : "return"} size={16}/></button></div></div></div><div className="composer-foot"><input ref={attachmentInputRef} className="visually-hidden" type="file" multiple aria-label="选择文件或图片" onChange={event => void attachFiles(event.target.files)}/><button type="button" className="image-attach-button" disabled={!sessionConnected || !!pendingOperation} title="添加任意文件或图片，也可拖入或粘贴文件" aria-label="添加附件" onClick={() => attachmentInputRef.current?.click()}><Glyph name="plus" size={18}/></button>{activeSnapshot?.ai && <button type="button" ref={permissionButtonRef} className="composer-permission-button" aria-label="会话权限" title="会话权限" aria-haspopup="dialog" aria-expanded={permissionsOpen} onClick={() => setPermissionsOpen(current => !current)}>权限</button>}{activeSnapshot&&<PlanModeToggle key={sessionId} mode={activeSnapshot.conversationMode} disabled={!sessionConnected||turnActive||!!pendingOperation||reasoningSaving.has(sessionId)||modeSaving.has(sessionId)||!!activeSnapshot.messageQueue?.items.length} onChange={changeConversationMode}/>} {activeSnapshot&&<SREModeToggle snapshot={activeSnapshot} onUpdated={refreshCurrent} disabled={!sessionConnected||turnActive} disabledReason={!sessionConnected?"连接恢复后可切换 SRE 协作。":"本轮运行中，结束后可切换 SRE 协作。"}/> }<div className="composer-status"><div className="model-switch-wrap">
          <ComposerModelSelect available={modelMenu} modelName={bootstrap?.modelName??null} selection={bootstrap?.modelSelection??undefined} configured={modelConfigured} open={modelMenuOpen} disabled={!!pendingOperation||reasoningSaving.size>0} onOpenChange={open=>{if(open) void openModelMenu();else setModelMenuOpen(false);}} onSelect={model=>void switchModel(model)} onSettings={()=>{setModelMenuOpen(false);void openSettings();}} reasoning={activeSnapshot?.ai ? {session:sessionId,modelId:bootstrap?.modelId,disabled:!sessionConnected || turnActive || !!pendingOperation,disabledReason:!sessionConnected?"连接恢复后可调整思考级别。":turnActive?"本轮运行中，结束后可调整思考级别。":"正在保存设置，请稍后调整思考级别。",onSaving:(saving,savingSession=sessionId) => setReasoningSaving(current=>{const next=new Set(current);if(saving)next.add(savingSession);else next.delete(savingSession);return next;})}:undefined}/>
        </div>{activeSnapshot?.ai && <ContextUsage view={activeSnapshot.ai} model={bootstrap || undefined} status={currentSessionStatus} compact/>}</div></div></form></div>
      </div> : <div className="welcome-view"><div className="welcome-content"><Brand/><h1>今天要处理什么问题？</h1><p>从项目开始一段会话。Lake 会把调查、证据和需要你确认的操作留在对话中。</p>{!projectList.length ? <button className="button primary" disabled={!connected} onClick={openProjectDialog}>创建第一个项目<Glyph name="arrow" size={17}/></button> : <button className="button primary" disabled={!connected} onClick={() => openSessionDialog(sidebarProject?.id??projectList[0].id)}>开始新会话<Glyph name="arrow" size={17}/></button>}{!modelConfigured && !booting && <button type="button" className="welcome-connect-model" onClick={() => void openSettings()}><Glyph name="plug" size={15}/>连接模型<Glyph name="arrow" size={14}/></button>}</div></div>}
    </main>
    {terminalTabContext && <NavigationMenu title="终端" x={terminalTabContext.x} y={terminalTabContext.y} onClose={() => setTerminalTabContext(null)} actions={[
      {label: "打开终端", run: () => selectTerminalTab(terminalTabContext.terminal)},
      {label: "新建终端", disabled: !!pendingOperation || connectingResources.includes(terminalTabContext.terminal.resourceId), run: () => { void openTerminalFor(terminalTabContext.terminal.resourceId, true); }},
      {label: "关闭终端", disabled: !!pendingOperation, run: () => { void closeTerminalTab(terminalTabContext.terminal); }},
    ]}/>}
    <TerminalSidePanel open={terminalOpen} onClose={closeTerminalPanel} onOpen={() => { revealActiveTerminalTab(); if (!commandBusy && currentTerminal?.holder === "user" && currentTerminal.status === "ready") terminalControlRef.current?.focus(); }}>{terminalDrawer}</TerminalSidePanel>
    {commandEditorOpen && <div className="modal-scrim"><section className="modal" role="dialog" aria-modal="true" aria-label="运行完整命令"><div className="modal-header"><h2>运行完整命令</h2><button type="button" className="icon-button" aria-label="关闭命令输入" onClick={() => setCommandEditorOpen(false)}><Glyph name="close"/></button></div><form className="command-form" onSubmit={reviewCommand}><label htmlFor="command-input">发送到 {resourceLabel(terminalResource)} 的命令</label><div className="command-input-row"><textarea ref={commandInputRef} id="command-input" rows={2} spellCheck={false} placeholder="输入单行命令，Enter 执行" value={commandDraft} onChange={event => { setCommandDraft(event.target.value); setCommandError(""); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} disabled={!terminalConnected || !persistentMode || currentTerminal?.holder !== "user" || currentTerminal.status !== "ready" || commandBusy}/><button type="submit" className="button command-button" disabled={!commandDraft.trim() || !terminalConnected || !persistentMode || currentTerminal?.holder !== "user" || currentTerminal.status !== "ready" || commandBusy}>执行<Glyph name="arrow" size={15}/></button></div>{commandError && <p className="form-error" role="alert">{commandError}</p>}<p>只读命令直接执行，变更命令需确认。运行交互程序时，可在上方终端输入按键。{currentTerminal?.holder !== "user" && currentTerminal?.status === "ready" ? "请先接管输入。" : ""}{currentTerminal?.status === "unknown" ? "执行结果不明，请先核查，避免重复提交。" : ""}</p></form></section></div>}
    {terminalContext && resourceTerminalSnapshot?.hostKeyTrust && <HostKeyTrust session={terminalContext.sessionId} prompt={resourceTerminalSnapshot.hostKeyTrust} disabled={!terminalConnected} refresh={refreshResourceTerminal}/>}
    {activeSnapshot?.hostKeyTrust && (!terminalContext || terminalContext.sessionId !== activeSnapshot.session.id) && <HostKeyTrust session={activeSnapshot.session.id} prompt={activeSnapshot.hostKeyTrust} disabled={!sessionConnected} refresh={refreshCurrent}/>}

    {notice && <div className="toast" role="status"><Glyph name="check" size={17}/>{notice}<button aria-label="关闭提示" onClick={() => setNotice("")}><Glyph name="close" size={14}/></button></div>}
    {editTerminalResource && <TerminalConfigEdit key={editTerminalResource.id} resource={editTerminalResource} connected={connected} onClose={() => setEditTerminalResource(null)} onSaved={terminalResourceSaved}/>}
    {resourceConfigContext && <NavigationMenu title={resourceConfigContext.resource.name} x={resourceConfigContext.x} y={resourceConfigContext.y} onClose={() => setResourceConfigContext(null)} actions={[{label:"编辑终端配置",run:()=>setEditTerminalResource(resourceConfigContext.resource)}, ...(resourceConfigContext.resource.kind !== "local" ? [{label:"删除资源",danger:true,run:()=>setNavigationDelete({kind:"resource" as const,id:resourceConfigContext.resource.id,projectId:resourceConfigContext.resource.projectId,name:resourceConfigContext.resource.name})}] : [])]}/>}
    {editSession && <SessionEdit key={editSession.id} session={editSession} connected={connected} onClose={() => setEditSession(null)} onSaved={sessionRenamed}/>}
    {deleteTarget && <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget && !deleteBusy) setDeleteTarget(null); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-session-title"><div className="modal-header"><span className="modal-icon danger-icon"><Glyph name="trash" size={20}/></span><button className="icon-button" aria-label="关闭" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}><Glyph name="close"/></button></div><h2 id="delete-session-title">删除会话</h2><p className="modal-description">将删除会话「{deleteTarget.title}」的对话、专员结论、证据、审批和命令记录。此操作不可恢复。</p>{deleteError && <p className="form-error" role="alert">{deleteError}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>取消</button><button type="button" className="button danger" onClick={() => void confirmDeleteSession()} disabled={deleteBusy || !connected}>{deleteBusy ? "正在删除…" : "删除会话"}</button></div></div></div>}
    {tagProject && <TagManager project={tagProject} tags={catalog.tags??[]} onClose={()=>{setTagProject(null);if(selectedTag&&!catalog.tags?.some(t=>t.id===selectedTag))setSelectedTag(null);}} onRefresh={async()=>{await refreshCatalog();}}/>}
    {memoryProject && <ProjectMemory key={memoryProject.id} project={memoryProject} onClose={() => setMemoryProject(null)}/>}
    {projectContext && <NavigationMenu title={projectContext.project.name} x={projectContext.x} y={projectContext.y} onClose={()=>setProjectContext(null)} actions={[{label:"新建项目",run:openProjectDialog},{label:bulkMode?"完成批量管理":"批量管理",run:()=>{setBulkMode(value=>!value);setBulkSelected([]);}},{label:"删除项目",danger:true,run:()=>setNavigationDelete({kind:"project",id:projectContext.project.id,projectId:projectContext.project.id,name:projectContext.project.name})}]}/>}
    {bulkConfirmation && <BulkNavigationDelete targets={bulkConfirmation} onClose={() => setBulkConfirmation(null)} onProcessed={bulkProcessed} onBusy={busy => setPendingOperation(current => busy ? "bulk-delete" : current === "bulk-delete" ? "" : current)}/>}
    {navigationDelete && <NavigationDelete target={navigationDelete} onClose={()=>setNavigationDelete(null)} onDeleted={async()=>{setResourceTerminalMenu(null);if(navigationDelete.kind==="project" && selectedSession?.projectId===navigationDelete.id)navigate({sessionId:null,resourceId:null});else if(navigationDelete.kind==="resource"&&route.resourceId===navigationDelete.id)navigate({sessionId:route.sessionId,resourceId:null});await refreshCatalog();if(navigationDelete.kind!=="project")await refreshCurrent();}}/>}
    {trashOpen && <NavigationTrash onClose={()=>setTrashOpen(false)} onRestored={async()=>{await refreshCatalog();await refreshCurrent();}}/>}
    {settingsOpen && <ModelSettings onClose={() => setSettingsOpen(false)} onChanged={refreshBootstrap} sendShortcut={sendShortcut} onShortcutChange={setSendShortcut} completionEnabled={completionEnabled} onCompletionEnabledChange={setCompletionEnabled} onSessionConfig={activeSnapshot?.ai && !selectedResource ? () => {setSettingsOpen(false);setAgentOptionsOpen(true);} : undefined} onProjectMemory={selectedProjectId ? () => {const project=projectList.find(p=>p.id===selectedProjectId);if(project){setSettingsOpen(false);setMemoryProject(project);}} : undefined} projectId={sidebarProject?.id} projectName={sidebarProject?.name} ignoreProjectMemory={ignoreProjectMemory} onIgnoreProjectMemoryChange={setIgnoreProjectMemory}/>}
    {importProject && <ResourceImport project={importProject} hexhub={importHexhub} refresh={refreshCatalog} onClose={() => { setImportProject(null); setImportHexhub(false); }} onImported={notify}/>}
    {sshProject && <div className="modal-scrim"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="ssh-title"><div className="modal-header"><span className="modal-icon"><Glyph name="server" size={20}/></span><button className="icon-button" aria-label="关闭" disabled={sshBusy} onClick={() => { setSshProject(null); setSshParent(null); setSshDraft(emptySSH()); }}><Glyph name="close"/></button></div><h2 id="ssh-title">新建资源</h2><p className="modal-description">添加 SSH 主机，供项目会话使用。{sshParent ? `资源会创建在「${sshParentName}」目录下。` : ""}</p><form onSubmit={createSsh}><label className="field-label">类型<AppSelect value={resourceKind} onChange={event => { setResourceKind(event.target.value); setSshDraft(current => ({...current, password: "", passphrase: "", privateKey: undefined, identityFile: undefined})); setServiceSettings(v => ({ ...v, port: event.target.value === "redis" ? 6379 : 5432 })); }}>{[["ssh", "SSH 主机"]].map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</AppSelect></label>
      <label className="field-label">资源名称<input required maxLength={120} value={sshName} onChange={event => setSshName(event.target.value)} autoFocus/></label>
{resourceKind === "ssh" ? <SSHResourceFields value={sshDraft} onChange={setSshDraft} disabled={sshBusy}/> : <>
        {resourceKind === "database" && <label className="field-label">数据库类型<AppSelect value={serviceSettings.driver} onChange={event => setServiceSettings({ ...serviceSettings, driver: event.target.value, port: event.target.value === "mysql" ? 3306 : 5432 })}><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="sqlite">SQLite</option></AppSelect></label>}
        {resourceKind === "docker" ? <><label className="field-label">Docker 端点<input value={serviceSettings.endpoint} onChange={event => setServiceSettings({ ...serviceSettings, endpoint: event.target.value })}/></label><label className="field-label">或使用 SSH 主机<AppSelect value={serviceSettings.ssh_asset_ref} onChange={event => setServiceSettings({ ...serviceSettings, ssh_asset_ref: event.target.value })}><option value="">直接连接端点</option>{catalog.resources.filter(r => r.projectId === sshProject && r.kind === "ssh").map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</AppSelect></label></> : resourceKind === "database" && serviceSettings.driver === "sqlite" ? <label className="field-label">SQLite 文件绝对路径<input required value={serviceSettings.path} onChange={event => setServiceSettings({ ...serviceSettings, path: event.target.value })}/></label> : <><label className="field-label">主机地址<input required value={serviceSettings.host} onChange={event => setServiceSettings({ ...serviceSettings, host: event.target.value })}/></label><label className="field-label">端口<input type="number" min={1} max={65535} value={serviceSettings.port} onChange={event => setServiceSettings({ ...serviceSettings, port: Number(event.target.value) })}/></label>{resourceKind === "database" && <><label className="field-label">用户名<input value={serviceSettings.username} onChange={event => setServiceSettings({ ...serviceSettings, username: event.target.value })}/></label><label className="field-label">数据库<input value={serviceSettings.database} onChange={event => setServiceSettings({ ...serviceSettings, database: event.target.value })}/></label></>}<label className="field-label">凭据 JSON 文件引用<input value={serviceSettings.credentialRef} onChange={event => setServiceSettings({ ...serviceSettings, credentialRef: event.target.value })} placeholder="~/.lake/secrets/ 下的文件名"/></label><label className="check-row"><input type="checkbox" checked={serviceSettings.tls} onChange={event => setServiceSettings({ ...serviceSettings, tls: event.target.checked })}/>验证 TLS 证书</label><p className="settings-note">凭据文件填写 username / password，权限须为 0600。凭据不会返回页面或写入模型上下文。</p></>}
      </>}      {sshError && <p className="form-error" role="alert">{sshError}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={() => { setSshProject(null); setSshParent(null); setSshDraft(emptySSH()); }} disabled={sshBusy}>取消</button><button type="submit" className="button primary" disabled={sshBusy}>{sshBusy ? "正在添加…" : "添加资源"}</button></div>
    </form></div></div>}
    {dialog && <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget && !dialogBusy) setDialog(null); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="create-dialog-title"><div className="modal-header"><span className="modal-icon"><Glyph name={dialog.kind === "project" ? "layers" : "chat"} size={20}/></span><button className="icon-button" aria-label="关闭" onClick={() => setDialog(null)} disabled={dialogBusy}><Glyph name="close"/></button></div><h2 id="create-dialog-title">{dialog.kind === "project" ? "新建项目" : "开启新会话"}</h2><p className="modal-description">{dialog.kind === "project" ? "将相关会话和资源放在同一个项目下。" : "名称会根据对话内容自动生成，可通过 @ 引用项目中的任意资源。"}</p><form onSubmit={submitDialog}>
      {dialog.kind === "project" && <label className="field-label">项目名称<input autoFocus maxLength={80} placeholder="例如：线上服务" value={draftProject} onChange={event => setDraftProject(event.target.value)}/></label>}
      {dialogError && <p className="form-error" role="alert">{dialogError}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setDialog(null)} disabled={dialogBusy}>取消</button><button type="submit" className="button primary" autoFocus={dialog.kind === "session"} disabled={dialogBusy || !connected || (dialog.kind === "project" && !draftProject.trim())}>{dialogBusy ? "正在创建…" : dialog.kind === "project" ? "创建项目" : "创建会话"}<Glyph name="arrow" size={16}/></button></div>
    </form></div></div>}
    {dangerousAction && <div className="modal-scrim"><div className="modal command-confirm" role="dialog" aria-modal="true" aria-labelledby="danger-action-title"><div className="modal-header"><span className="modal-icon command-icon"><Glyph name="alert" size={20}/></span><button className="icon-button" aria-label="关闭" onClick={() => setDangerousAction(null)} disabled={!!pendingOperation}><Glyph name="close"/></button></div><h2 id="danger-action-title">再次确认危险操作</h2><p className="modal-description">{dangerousAction.riskReason}</p><div className="confirm-facts"><div><span>目标资源</span><strong>{resourceLabel(resourceMap.get(dangerousAction.resourceId))}</strong></div><div><span>可能的影响</span><strong>{dangerousAction.impact}</strong></div></div><pre className="confirm-command-text">{dangerousAction.command}</pre><label className="danger-confirm-field">请输入「{dangerConfirmation(resourceMap.get(dangerousAction.resourceId)?.name ?? "")}」确认目标<input autoFocus value={dangerText} onChange={event => setDangerText(event.target.value)} autoComplete="off"/></label><div className="modal-actions"><button className="button secondary" onClick={() => setDangerousAction(null)} disabled={!!pendingOperation}>返回核对</button><button className="button approval-button" onClick={() => void decide(dangerousAction.id, "approve", dangerText)} disabled={!!pendingOperation || !sessionConnected || dangerText !== dangerConfirmation(resourceMap.get(dangerousAction.resourceId)?.name ?? "")}>确认危险操作<Glyph name="arrow" size={16}/></button></div></div></div>}
    {confirmedCommand !== null && <div className="modal-scrim"><div className="modal command-confirm" role="dialog" aria-modal="true" aria-labelledby="confirm-command-title"><div className="modal-header"><span className="modal-icon command-icon"><Glyph name="terminal" size={20}/></span><button className="icon-button" aria-label="关闭" onClick={() => setConfirmedCommand(null)} disabled={commandBusy}><Glyph name="close"/></button></div><h2 id="confirm-command-title">{dangerStage ? "再次确认危险操作" : "核对变更命令"}</h2><p className="modal-description">{confirmedPolicy?.riskReason} 本次确认只适用于这一条命令。</p><div className="confirm-facts"><div><span>会话</span><strong>{terminalContext ? "资源终端" : selectedSession?.title}</strong></div><div><span>目标资源</span><strong>{resourceLabel(terminalResource)}</strong></div><div><span>发起者</span><strong>你</strong></div></div><div className="confirm-command-label">完整命令</div><pre className="confirm-command-text">{confirmedCommand}</pre>{dangerStage && <label className="danger-confirm-field">请输入「{dangerConfirmation(terminalResource?.name ?? "")}」确认目标<input autoFocus value={dangerText} onChange={event => setDangerText(event.target.value)} autoComplete="off"/></label>}<div className="modal-actions"><button className="button secondary" onClick={() => setConfirmedCommand(null)} disabled={commandBusy}>返回修改</button><button className="button primary" onClick={() => void runCommand(confirmedCommand, dangerStage ? dangerText : undefined)} disabled={commandBusy || !terminalConnected || !persistentMode || currentTerminal?.holder !== "user" || currentTerminal.status !== "ready" || (dangerStage && dangerText !== dangerConfirmation(terminalResource?.name ?? ""))}>{commandBusy ? "正在提交…" : confirmedPolicy?.risk === "dangerous" && !dangerStage ? "继续确认风险" : "确认并执行"}<Glyph name="arrow" size={16}/></button></div></div></div>}
  </div>;
}

function Brand({ large = false, icon = true }: { large?: boolean; icon?: boolean }) {
  return <div className={`brand ${large ? "brand-large" : ""}`}>{icon && <AgentIcon role="lake" size={large ? 32 : 25}/>}<strong>Lake</strong></div>;
}

function ResourceDetail({ resource, project, sessions, selectedSession, terminalList, disabled, onBack, onNewSession, onSession, onEdit }: {
  resource: Resource; project?: Project; sessions: WorkSession[]; selectedSession?: WorkSession;
  terminalList: TerminalSession[]; disabled: boolean; onBack: () => void; onNewSession: () => void;
  onSession: (sessionId: string) => void; onEdit: () => void;
}) {
  const inScope = selectedSession?.projectId === resource.projectId;
  const available = resource.status === "available";
  const usingSessionIds = new Set(terminalList
    .filter(terminal => terminal.resourceId === resource.id && terminal.status !== "disconnected")
    .map(terminal => terminal.writerSessionId || terminal.sessionId));
  const usingSessions = sessions.filter(session => usingSessionIds.has(session.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const targetSession = usingSessions.find(session => session.id === selectedSession?.id) ?? usingSessions[0]
    ?? (inScope ? selectedSession : undefined);
  return <div className="resource-detail"><button className="back-link" onClick={onBack} disabled={!selectedSession}><Glyph name="arrow" size={15}/>返回当前会话</button><div className="resource-hero"><div className="resource-hero-copy"><span className="section-overline">项目资源 <span className="overline-stroke"/></span><div className="resource-hero-title"><span className="resource-hero-icon"><Glyph name="server" size={30}/></span><div><h1>{resource.name}</h1><p>{project?.name ?? "项目"}中的{resource.kind === "ssh" ? "SSH 主机" : resource.kind === "local" ? "本机资源" : resource.kind === "database" ? "数据库" : resource.kind === "docker" ? "Docker" : "Redis"}</p></div></div></div><div className={`resource-status-badge ${available ? "available" : "unavailable"}`}><span/>{available ? "可用" : "不可用"}</div></div>
    <div className="resource-detail-grid"><section className="detail-panel"><h2>资源信息</h2>{["local","ssh"].includes(resource.kind) && <button type="button" className="button secondary" disabled={disabled} onClick={onEdit}>编辑终端配置</button>}<dl className="detail-list"><div><dt>名称</dt><dd>{resource.name}</dd></div><div><dt>资源标识</dt><dd className="machine-text">{resource.id}</dd></div><div><dt>类型</dt><dd>{resource.kind === "ssh" ? "SSH 主机" : resource.kind === "local" ? "本机资源" : resource.kind === "database" ? "数据库" : resource.kind === "docker" ? "Docker" : "Redis"}</dd></div><div><dt>当前状态</dt><dd>{available ? "可用" : "不可用"}</dd></div>{resource.ssh && <div><dt>登录方式</dt><dd>{resource.ssh.authMethod === "password" ? "密码登录" : "密钥登录"}</dd></div>}</dl>{resource.description && <div className="resource-description"><strong>说明</strong><p>{resource.description}</p></div>}</section><section className="detail-panel action-panel"><h2>在会话中使用</h2><p>进入会话后向 Lake 描述问题，或引用此资源开始调查。</p>{targetSession && <div className="context-session"><Glyph name="chat" size={17}/><div><small>{usingSessionIds.has(targetSession.id) ? "正在使用此资源" : "当前会话"}</small><strong>{targetSession.title}</strong></div></div>}{targetSession && <button className="button primary wide" onClick={() => onSession(targetSession.id)}><Glyph name="chat" size={17}/>{usingSessionIds.has(targetSession.id) ? "进入使用中的会话" : "进入当前会话"}<Glyph name="arrow" size={16}/></button>}<button className="button secondary wide" disabled={disabled} onClick={onNewSession}><Glyph name="plus" size={17}/>新建会话</button></section></div>
    <section className="linked-sessions"><div className="linked-heading"><h2>使用中的会话</h2><span>{usingSessions.length} 条</span></div>{usingSessions.length ? usingSessions.map(session => <button className="linked-row" type="button" key={session.id} onClick={() => onSession(session.id)}><Glyph name="chat" size={16}/><span className="linked-row-text"><strong>{session.title}</strong><small>正在使用此资源</small></span><span className={`session-state state-${session.status}`}>{session.status === "investigating" && <ActivityIndicator/>}{sessionLabels[session.status]}</span><Glyph name="arrow" size={15}/></button>) : <p>暂无会话正在使用此资源。</p>}</section>
  </div>;
}

function TimelineNode({ entry, resourceMap, sessionTitle, disabled, pendingOperation, terminals, persistentMode, onDecision, onHandoff, onResource }: {
  entry: TimelineItem; resourceMap: Map<string, Resource>; sessionTitle: string;
  disabled: boolean; pendingOperation: string; terminals: TerminalSession[]; persistentMode: boolean;
  onDecision: (actionId: string, decision: "approve" | "reject") => void;
  onHandoff: (action: Action) => void; onResource: (resourceId: string) => void;
}) {
  const readyTerminal = entry.kind === "action" ? [...terminals].filter(terminal => terminal.resourceId === entry.item.resourceId && terminal.status === "ready" && (!entry.item.terminalId || terminal.id === entry.item.terminalId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : undefined;
  const agentReady = readyTerminal?.holder === "agent";
  const label = entry.kind === "message" ? (entry.item.role === "user" ? "" : entry.item.role === "assistant" ? "Lake" : "系统") : entry.kind === "specialist" ? "专员进度" : entry.item.risk === "readonly" ? entry.item.status === "pending" ? "等待终端交接" : "只读检查" : "待确认的操作";
  const glyph: GlyphName = entry.kind === "message" ? (entry.item.role === "assistant" ? "spark" : "chat") : entry.kind === "specialist" ? "layers" : "lock";
  return <article className={`timeline-item item-${entry.kind} ${entry.kind === "message" ? `message-${entry.item.role}` : ""}`}><span className="timeline-point"><Glyph name={glyph} size={15}/></span><div className="timeline-content"><div className="item-meta">{label && <strong>{label}</strong>}<time dateTime={entry.at} title={entry.at}>{dateLabel(entry.at)}</time></div>
    {entry.kind === "message" && <div className="message-text">{entry.item.role==="user"?<MessageText text={entry.item.text} mentions={entry.item.mentions} resources={[...resourceMap.values()]}/>:entry.item.text}</div>}
    {entry.kind === "specialist" && <div className="specialist-card"><div className="specialist-head"><div><strong>{specialistLabels[entry.item.name] ?? entry.item.name}</strong><p>{entry.item.task}</p></div><span className={`pill specialist-${entry.item.status}`}><span/>{entry.item.status === "working" ? "调查中" : entry.item.status === "completed" ? "已完成" : "未完成"}</span></div>{entry.item.summary && <details className="expand-detail"><DisclosureSummary>查看专员结论</DisclosureSummary><p>{entry.item.summary}</p></details>}{!entry.item.summary && <p className="specialist-awaiting">正在收集结果，更新会显示在这里。</p>}</div>}
    {entry.kind === "action" && <div className={`approval-card ${entry.item.status !== "pending" ? "approval-resolved" : ""}`}><div className="approval-head"><span className="approval-mark"><Glyph name="lock" size={19}/></span><div><strong>{entry.item.risk === "readonly" ? entry.item.status === "pending" ? "只读检查等待终端交接" : "只读检查" : entry.item.risk === "dangerous" ? "危险操作需要再次确认" : "变更操作需要你的确认"}</strong><p>{entry.item.riskReason}</p></div><span className={`pill action-${entry.item.status}`}>{entry.item.status === "pending" && entry.item.risk === "readonly" ? "等待交接" : actionLabels[entry.item.status]}</span></div><div className="approval-grid"><div><span>目标资源</span><button className="detail-link" onClick={() => onResource(entry.item.resourceId)}>{resourceLabel(resourceMap.get(entry.item.resourceId))}</button></div><div><span>所属会话</span><strong>{sessionTitle}</strong></div></div><div className="approval-section"><span>完整命令</span><pre>{entry.item.command}</pre></div><div className="approval-notes"><div><span>为什么执行</span><p>{entry.item.reason}</p></div><div><span>可能的影响</span><p>{entry.item.impact}</p></div><div><span>如何验证</span><p>{entry.item.verification}</p></div></div>{entry.item.status === "pending" ? <><div className={`approval-handoff ${agentReady ? "ready" : ""}`}><Glyph name={agentReady ? "check" : "terminal"} size={17}/><div><strong>{agentReady ? "目标终端已交给 Agent" : "执行前需交给 Agent 输入"}</strong><p>{agentReady ? entry.item.risk === "readonly" ? "只读检查自动执行，无需逐条确认。" : "请核对完整命令和影响，再确认本次操作。" : readyTerminal ? "此资源的持续终端由你持有。交接后，只读检查自动执行，变更仍需确认。" : "先为此资源打开持续终端，并交给 Agent 输入。"}</p></div>{!agentReady && <button className="button handoff-button" onClick={() => onHandoff(entry.item)} disabled={disabled || !!pendingOperation || !persistentMode}>{pendingOperation === `handoff:${entry.item.id}` ? "准备中…" : readyTerminal ? "交给 Agent 输入" : "创建控制台并交接"}</button>}</div><div className="approval-actions"><button className="button secondary" onClick={() => onDecision(entry.item.id, "reject")} disabled={disabled || !!pendingOperation}>{pendingOperation === entry.item.id ? "处理中…" : entry.item.risk === "readonly" ? "取消检查" : "拒绝操作"}</button>{entry.item.risk !== "readonly" && <button className="button approval-button" onClick={() => onDecision(entry.item.id, "approve")} disabled={disabled || !!pendingOperation || !agentReady || !persistentMode}>{pendingOperation === entry.item.id ? "处理中…" : entry.item.risk === "dangerous" ? "继续确认风险" : "确认本次变更"}<Glyph name="arrow" size={16}/></button>}</div></> : <div className="approval-result">{entry.item.exitCode !== null ? `执行退出码：${entry.item.exitCode}。` : ""}{entry.item.status === "unknown" ? "执行结果不明，请核查实际结果后再决定下一步。" : entry.item.status === "succeeded" ? "命令已执行；是否恢复仍需按上面的方式验证。" : `当前状态：${actionLabels[entry.item.status]}。`}</div>}</div>}
  </div></article>;
}

export default App;
