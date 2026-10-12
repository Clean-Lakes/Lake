import { readImageSelection } from "./imageAttachments";
import { SSHResourceFields, emptySSH } from "./SSHResourceFields";
import type { SSHConnectionInput } from "../../shared/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  AIImage,
  Action,
  Catalog,
  Message,
  ModelSettings,
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
import { AIControls, AITranscript } from "./AIPanel";
import { ContextUsage } from "./ContextUsage";
import { ReasoningSelector } from "./ReasoningSelector";
import { uniqueTerminalRows } from "./terminalAIState";
import { TerminalPane, type TerminalHandle } from "./TerminalPane";
import { TerminalSidePanel } from "./TerminalSidePanel";
import { reusableResourceTerminal, onlineTerminalOptions } from "./resourceTerminalState";
import { ResourceTree } from "./ResourceTree";
import { ResourceTerminalMenu } from "./ResourceTerminalMenu";
import { HostKeyTrust } from "./HostKeyTrust";
import { conversationActive, sessionConnection, type StreamState } from "./connection";
import { FollowScroll } from "./followScroll";
import { rebaseMentions, referencedResources, type MentionReference } from "../../shared/references";
import { type CommandPolicy, dangerConfirmation } from "../../shared/command-policy";
import "./styles.css";

type GlyphName = "layers" | "folder" | "shield" | "plus" | "chevron" | "terminal" | "chat" | "server" | "arrow" | "close" | "menu" | "refresh" | "check" | "alert" | "spark" | "clock" | "lock" | "link" | "send" | "stop" | "copy" | "expand" | "settings" | "trash";

function Glyph({ name, size = 18, className = "" }: { name: GlyphName; size?: number; className?: string }) {
  const paths: Record<GlyphName, ReactNode> = {
    layers: <><path d="m3 8 9-5 9 5-9 5-9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></>,
    folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>,
    shield: <><path d="m12 3 8 3v5c0 4.6-3 7.9-8 10-5-2.1-8-5.4-8-10V6Z"/><path d="m8.5 11.5 2.5 2.5 4.5-5"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    chevron: <path d="m7 10 5 5 5-5"/>,
    terminal: <><rect x="2.5" y="3.5" width="19" height="17" rx="2"/><path d="m6 9 3 3-3 3m6 0h5"/></>,
    chat: <path d="M20 11.4a7.7 7.7 0 0 1-8.1 7.6 9 9 0 0 1-3.1-.5l-4.4 1.1 1.2-4.1a7.4 7.4 0 0 1-1.6-4.1A7.7 7.7 0 0 1 12 4a7.7 7.7 0 0 1 8 7.4Z"/>,
    server: <><rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h7M11 17.5h7"/></>,
    arrow: <><path d="M4 12h16m-6-6 6 6-6 6"/></>,
    close: <path d="M5 5 19 19M19 5 5 19"/>,
    menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
    refresh: <><path d="M20 10a8 8 0 0 0-14.8-3M4 3v5h5M4 14a8 8 0 0 0 14.8 3M20 21v-5h-5"/></>,
    check: <path d="m4 12 5 5L20 6"/>,
    alert: <><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v4m0 4h.01"/></>,
    spark: <><path d="m12 2 1.9 7.1L21 11l-7.1 1.9L12 20l-1.9-7.1L3 11l7.1-1.9L12 2ZM19 17l.5 1.5L21 19l-1.5.5L19 21l-.5-1.5L17 19l1.5-.5L19 17Z"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    link: <><path d="M10 13a5 5 0 0 0 7 .4l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7M14 11a5 5 0 0 0-7-.4l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>,
    send: <><path d="m3 20 18-8L3 4l2 7 9 1-9 1-2 7Z"/></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
    expand: <><path d="M8 3H3v5m0-5 7 7m6 11h5v-5m0 5-7-7"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.1 15.2a1.6 1.6 0 0 0 .3 1.7l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-1.7-.3 1.6 1.6 0 0 0-.9 1.4v.2a1.9 1.9 0 1 1-3.8 0v-.1a1.6 1.6 0 0 0-1-1.4 1.6 1.6 0 0 0-1.7.3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0 .3-1.7 1.6 1.6 0 0 0-1.4-.9H3a1.9 1.9 0 1 1 0-3.8h.2a1.6 1.6 0 0 0 1.4-1 1.6 1.6 0 0 0-.3-1.7l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 1.7.3h.1a1.6 1.6 0 0 0 .9-1.4V3a1.9 1.9 0 1 1 3.8 0v.2a1.6 1.6 0 0 0 .9 1.4 1.6 1.6 0 0 0 1.7-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0-.3 1.7v.1a1.6 1.6 0 0 0 1.4.9h.2a1.9 1.9 0 1 1 0 3.8h-.2a1.6 1.6 0 0 0-1.4.9Z"/></>,
    trash: <><path d="M4 7h16M10 11v6M14 11v6M6.5 7l.9 13h9.2l.9-13M9.5 7V4h5v3"/></>,
  };
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

type ModelPreset = { id: string; label: string; url: string; models: string[]; protocol?: string };

/** Common OpenAI-compatible endpoints, so the dialog can prefill instead of asking for a URL first. */
const modelPresets: ModelPreset[] = [
  { id: "deepseek", label: "DeepSeek", url: "https://api.deepseek.com/v1/chat/completions", models: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "openai", label: "OpenAI", url: "https://api.openai.com/v1/chat/completions", models: ["gpt-4o", "gpt-4o-mini"] },
  { id: "anthropic", label: "Anthropic", protocol: "claude", url: "https://api.anthropic.com/v1/messages", models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"] },
  { id: "qwen", label: "通义千问", url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", models: ["qwen-plus", "qwen-max", "qwen-turbo"] },
  { id: "zhipu", label: "智谱 GLM", url: "https://open.bigmodel.cn/api/paas/v4/chat/completions", models: ["glm-4-plus", "glm-4-air"] },
  { id: "ollama", label: "本地 Ollama", url: "http://127.0.0.1:11434/v1/chat/completions", models: ["qwen3", "llama3.2"] },
  { id: "custom", label: "自定义", url: "", models: [] },
];

const sessionLabels: Record<WorkSession["status"], string> = {
  idle: "待命中", investigating: "调查中", waiting_approval: "等待确认", completed: "已完成", failed: "需要关注",
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
  const params = new URLSearchParams(window.location.search);
  return { sessionId: params.get("session"), resourceId: params.get("resource") };
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
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  const [closedSessionGroups, setClosedSessionGroups] = useState<string[]>(() => {
    try { const saved: unknown = JSON.parse(localStorage.getItem("lake.closed-session-groups") || "[]"); return Array.isArray(saved) ? saved.filter(id => typeof id === "string") : []; } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem("lake.closed-session-groups", JSON.stringify(closedSessionGroups)); } catch {} }, [closedSessionGroups]);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [dialog, setDialog] = useState<{ kind: "project" } | { kind: "session"; projectId: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkSession | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [draftProject, setDraftProject] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [resourceKind, setResourceKind] = useState("ssh");
  const [serviceSettings, setServiceSettings] = useState({ driver: "postgres", host: "", port: 5432, username: "", database: "", path: "", credentialRef: "", endpoint: "unix:///var/run/docker.sock", ssh_asset_ref: "", tls: true });
  const [sshProject, setSshProject] = useState<string | null>(null);
  const [sshName, setSshName] = useState("");
  const [sshDraft, setSshDraft] = useState<SSHConnectionInput>(emptySSH());
  const [sshError, setSshError] = useState("");
  const [sshBusy, setSshBusy] = useState(false);
  const inputQueue = useRef(Promise.resolve());
  const [imageDraft, setImageDraft] = useState<AIImage[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [imageInputCapability, setImageInputCapability] = useState(false);
  const [imageOutputCapability, setImageOutputCapability] = useState(false);
  const [mentionRefs, setMentionRefs] = useState<MentionReference[]>([]);
  const [messageDraft, setMessageDraft] = useState("");
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentOptionsOpen, setAgentOptionsOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const permissionButtonRef = useRef<HTMLButtonElement>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [draftModelProtocol, setDraftModelProtocol] = useState("openai");
  const [draftModelUrl, setDraftModelUrl] = useState("");
  const [draftModelName, setDraftModelName] = useState("");
  const [draftModelKey, setDraftModelKey] = useState("");
  const [presetId, setPresetId] = useState("custom");
  const [testState, setTestState] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenu, setModelMenu] = useState<{ loading: boolean; models: string[]; message: string }>({ loading: false, models: [], message: "" });
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const [pendingOperation, setPendingOperation] = useState("");
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
  const [localShell,setLocalShell]=useState("bash");
  const terminalControlRef = useRef<TerminalHandle | null>(null);
  const terminalTabsRef = useRef<HTMLDivElement>(null);
  const [terminalOptionsOpen, setTerminalOptionsOpen] = useState(false);
  const [terminalListOpen, setTerminalListOpen] = useState(false);
  const [commandEditorOpen, setCommandEditorOpen] = useState(false);
  const [restoringStream, setRestoringStream] = useState(false);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [terminalHistory, setTerminalHistory] = useState<TerminalHistory | null>(null);
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
      setExpandedProjects(previous => [...new Set([...previous, ...data.projects.map(project => project.id)])]);
      setRoute(previous => {
        const sessionId = previous.sessionId && data.sessions.some(session => session.id === previous.sessionId)
          ? previous.sessionId : [...data.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null;
        return { sessionId, resourceId: previous.resourceId && data.resources.some(resource => resource.id === previous.resourceId) ? previous.resourceId : null };
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
  const navigate = useCallback((next: { sessionId: string | null; resourceId: string | null }) => {
    const url = new URL(window.location.href);
    if (next.sessionId) url.searchParams.set("session", next.sessionId); else url.searchParams.delete("session");
    if (next.resourceId) url.searchParams.set("resource", next.resourceId); else url.searchParams.delete("resource");
    window.history.pushState(null, "", url);
    setRoute(next);
    setMobileMenu(false);
  }, []);
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
        setSnapshot(fresh);
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
        if (event.type === "terminal") queuedRevision = true;
        // Bound snapshot traffic without postponing every update until a
        // continuous token stream finally goes quiet.
        if (!refreshTimer) refreshTimer = setTimeout(() => {
          refreshTimer = null;
          void refresh();
        }, 120);
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
        // A hidden tab deliberately suspends its stream; it has not failed.
        setStreamState("connecting"); setRestoringStream(true);
      } else { setStreamState("connecting"); setSessionError(""); restoring = true; startPolling(); connectStream(); }
    };
    document.addEventListener("visibilitychange", visibility);
    (async () => {
      try {
        const first = await fetchSnapshot();
        if (disposed || activeSession.current !== sessionId) return;
        setSnapshot(first);
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
    };
  }, [sessionId, sessionReload, bootstrap, Boolean(catalog), handleFailure]);

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
    setMessageDraft("");
    setImageDraft([]);
    setAgentOptionsOpen(false);
    setPermissionsOpen(false);
    setMentionRefs([]);
  }, [sessionId]);

  const refreshResourceTerminal = useCallback(async () => {
    const context = activeTerminalContext.current;
    if (!context) return;
    const [fresh, live] = await Promise.all([api.snapshot(context.sessionId), api.resourceTerminals(context.resourceId)]);
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
    const refresh = async () => {
      if (disposed || syncing) return;
      syncing = true;
      try { await refreshResourceTerminal(); }
      catch (error) { if (!disposed) { setResourceTerminalConnected(false); setTerminalError(readableError(error)); } }
      finally { syncing = false; }
    };
    const stream = new EventSource(api.eventsUrl(terminalContext.sessionId, resourceTerminalSnapshot?.cursor ?? 0), {withCredentials: true});
    const update = () => { if (!timer) timer = setTimeout(() => { timer = null; void refresh(); }, 80); };
    stream.onopen = update;
    stream.onerror = update;
    stream.onmessage = update;
    for (const type of ["terminal", "session", "action"]) stream.addEventListener(type, update);
    void refresh();
    const poll = setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
    return () => { disposed = true; stream.close(); clearInterval(poll); if (timer) clearTimeout(timer); };
  }, [terminalContext, terminalOpen, bootstrap, refreshResourceTerminal]);

  useEffect(() => {
    if (!terminalSessionId || !terminalId) { setTerminalHistory(null); return; }
    if (!terminalOpen) return;
    let cancelled = false;
    setTerminalError("");
    api.terminalHistory(terminalSessionId, terminalId).then(history => {
      if (!cancelled) setTerminalHistory(history);
    }).catch(error => {
      if (!cancelled) { setTerminalError(readableError(error)); handleFailure(error); }
    });
    return () => { cancelled = true; };
  }, [terminalId, terminalOpen, terminalSessionId, terminalRevision, terminalRefresh, handleFailure]);

  const activeSnapshot = snapshot?.session.id === sessionId ? snapshot : sessionId && catalog?.sessions.some(session => session.id === sessionId) ? snapshotCache.current.get(sessionId) ?? null : null;
  const selectedSession = activeSnapshot?.session ?? catalog?.sessions.find(item => item.id === sessionId);
  const selectedResource = catalog?.resources.find(item => item.id === route.resourceId);
  const resourceMap = new Map((catalog?.resources ?? []).map(resource => [resource.id, resource]));
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
  const terminalList = terminalContext ? resourceLiveTerminals.filter(terminal => terminal.resourceId === terminalContext.resourceId) : activeSnapshot?.terminals ?? [];
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
    if (!container || !activeSnapshot || route.resourceId) {
      conversationScroll.current = { key: "", following: true };
      return;
    }
    const key = activeSnapshot.session.id;
    if (conversationScroll.current.key !== key) conversationScroll.current = { key, following: true };
    const follower = new FollowScroll(container, () => conversationScroll.current.following,
      undefined, window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    conversationFollower.current = follower;
    follower.jump();
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
  }, [activeSnapshot?.session.id, route.resourceId]);

  useLayoutEffect(() => {
    conversationFollower.current?.request();
  }, [activeSnapshot?.cursor, terminalOpen]);

  const refreshCatalog = useCallback(async () => {
    const data = await api.catalog();
    setCatalog(data);
    return data;
  }, []);
  const refreshCurrent = useCallback(async () => {
    if (!activeSession.current) return;
    const fresh = await api.snapshot(activeSession.current);
    if (activeSession.current !== fresh.session.id) return;
    setSnapshot(fresh);
    streamCursor.current = Math.max(streamCursor.current, fresh.cursor);
    setCatalog(current => current ? { ...current, sessions: current.sessions.some(session => session.id === fresh.session.id)
      ? current.sessions.map(session => session.id === fresh.session.id ? fresh.session : session)
      : [...current.sessions, fresh.session] } : current);
    setTerminalRevision(value => value + 1);
  }, []);

  const openSettings = useCallback(async () => {
    setSettingsOpen(true);
    setSettingsError("");
    setDraftModelKey("");
    setTestState(null);
    try {
      const current = await api.modelSettings();
      setSettings(current);
      setDraftModelUrl(current.url);
      setDraftModelProtocol(current.protocol || "openai");
      setImageInputCapability(current.supportsImageInput === true);
      setImageOutputCapability(current.supportsImageOutput === true);
      setDraftModelName(current.name);
      setPresetId(modelPresets.find(preset => preset.url && preset.url === current.url)?.id ?? "custom");
    } catch (error) { setSettingsError(readableError(error)); }
  }, []);
  const suggestedModels = modelPresets.flatMap(preset => preset.models);
  async function openModelMenu() {
    if (modelMenuOpen) { setModelMenuOpen(false); return; }
    setModelMenuOpen(true);
    setModelMenu({ loading: modelConfigured, models: [], message: modelConfigured ? "" : "尚未配置模型" });
    if (!modelConfigured) return;
    try {
      const available = await api.availableModels();
      setModelMenu({ loading: false, models: available.models, message: available.message ?? "" });
    } catch (error) {
      setModelMenu({ loading: false, models: [], message: readableError(error) });
    }
  }
  async function switchModel(name: string) {
    if (pendingOperation || name === bootstrap?.modelName) { setModelMenuOpen(false); return; }
    setPendingOperation("model");
    try {
      const current = await api.modelSettings();
      await api.saveModelSettings(current.url, name, undefined, current.protocol || "openai");
      await refreshBootstrap();
      setModelMenuOpen(false);
      notify(`已切换到 ${name}`);
    } catch (error) { notify(readableError(error)); }
    finally { setPendingOperation(""); }
  }
  useEffect(() => {
    if (!modelMenuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target as Node)) setModelMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setModelMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [modelMenuOpen]);
  const selectedPreset = modelPresets.find(preset => preset.id === presetId) ?? modelPresets[modelPresets.length - 1]!;
  function choosePreset(preset: ModelPreset) {
    setPresetId(preset.id);
    setDraftModelProtocol(preset.protocol || "openai");
    setTestState(null);
    if (preset.url) setDraftModelUrl(preset.url);
    setDraftModelName(current => (!current.trim() || suggestedModels.includes(current)) ? (preset.models[0] ?? "") : current);
  }
  async function testConnection() {
    if (testing || !draftModelUrl.trim() || !draftModelName.trim()) return;
    setTesting(true); setTestState(null);
    try {
      setTestState(await api.testModelSettings(draftModelUrl.trim(), draftModelName.trim(), draftModelKey ? draftModelKey : undefined, draftModelProtocol));
    } catch (error) {
      setTestState({ ok: false, message: readableError(error) });
      if (error instanceof ApiRequestError && error.status === 401) handleFailure(error);
    } finally { setTesting(false); }
  }
  async function refreshBootstrap() {
    try { setBootstrap(await api.bootstrap()); } catch { /* The banner keeps its last known state. */ }
  }
  async function submitSettings(event: FormEvent) {
    event.preventDefault();
    if (settingsBusy) return;
    setSettingsBusy(true); setSettingsError("");
    try {
      const typedUrl = draftModelUrl.trim();
      const saved = await api.saveModelSettings(typedUrl, draftModelName.trim(), draftModelKey ? draftModelKey : undefined, draftModelProtocol, imageInputCapability, imageOutputCapability);
      setSettings(saved);
      setDraftModelUrl(saved.url);
      await refreshBootstrap();
      setDraftModelKey("");
      setSettingsOpen(false);
      notify(saved.url !== typedUrl ? `模型设置已保存；端点已补全为 ${saved.url}` : "模型设置已保存，可以发起调查");
    } catch (error) {
      setSettingsError(readableError(error));
      if (error instanceof ApiRequestError && error.status === 401) handleFailure(error);
    } finally { setSettingsBusy(false); }
  }
  async function clearSettings() {
    if (settingsBusy) return;
    setSettingsBusy(true); setSettingsError("");
    try {
      const cleared = await api.clearModelSettings();
      setSettings(cleared);
      setDraftModelUrl(cleared.url); setDraftModelName(cleared.name); setDraftModelKey("");
      await refreshBootstrap();
      notify("已清除界面保存的模型配置");
    } catch (error) {
      setSettingsError(readableError(error));
      if (error instanceof ApiRequestError && error.status === 401) handleFailure(error);
    } finally { setSettingsBusy(false); }
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
        setExpandedProjects(items => [...new Set([...items, project.id])]);
        notify(`已创建项目「${project.name}」`);
      } else {
        const session = await api.createSession(dialog.projectId);
        await refreshCatalog();
        setExpandedProjects(items => [...new Set([...items, dialog.projectId])]);
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
  /** Resources the composer can reference with "@". */
  const mentionable = sessionId ? (activeSnapshot?.resources ?? catalog?.resources.filter(resource => resource.projectId === selectedSession?.projectId) ?? []) : [];
  const mentionMatches = mention
    ? mentionable.filter(resource => resource.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 40)
    : [];
  function syncMention(value: string, caret: number) {
    const token = value.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/);
    setMention(token ? { query: token[1] ?? "", index: 0 } : null);
  }
  function insertMention(resource: Resource) {
    const input = messageInputRef.current;
    const caret = input?.selectionStart ?? messageDraft.length;
    const before = messageDraft.slice(0, caret);
    const token = before.match(/(?:^|\s)@([^\s@]*)$/);
    const head = token ? before.slice(0, before.length - token[0].length) + (token[0].startsWith(" ") ? " " : "") : before;
    const next = `${head}@${resource.name} ${messageDraft.slice(caret)}`;
    setMentionRefs(refs => [...rebaseMentions(messageDraft, next, refs), { resourceId: resource.id, label: `@${resource.name}`, start: head.length, end: head.length + resource.name.length + 1 }]);
    setMessageDraft(next);
    setMention(null);
    const position = head.length + resource.name.length + 2;
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(position, position); });
  }
  /** Resource ids whose "@name" still appears in the draft, so deleting the text drops the reference. */
  function mentionedResourceIds(_text: string) {
    return referencedResources(messageDraft, mentionRefs, mentionable.map(resource => resource.id));
  }
  async function attachImages(files: FileList | null) {
    if (!files) return;
    try {
      const images = await readImageSelection(imageDraft,[...files]);
      setImageDraft(current => [...current, ...images]);
    } catch (error) { handleFailure(error); }
    if (imageInputRef.current) imageInputRef.current.value = "";
  }
  async function stopCurrentTurn() {
    if (!sessionId || !turnActive || stoppingTurn || !sessionConnected) return;
    setStoppingTurn(true);
    try { await api.aiOperation(sessionId, "abort"); await refreshCurrent(); }
    catch (error) { handleFailure(error); }
    finally { setStoppingTurn(false); }
  }
  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = messageDraft.trim() || (imageDraft.length ? "请分析附加图片。" : "");
    if (!sessionId || !text || !sessionConnected || !modelConfigured || messageBlocked || pendingOperation) return;
    setMention(null);
    setPendingOperation("message");
    conversationScroll.current.following = true;
    try {
      const refs = mentionedResourceIds(text);
      await api.sendMessage(sessionId, text, refs, imageDraft);
      setMessageDraft("");
    setImageDraft([]);
    setMentionRefs([]);
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
    setPendingOperation(`resource:${resourceId}`);
    let context: {sessionId: string; resourceId: string} | null = null;
    try {
      const scope = await api.resourceTerminalContext(resourceId);
      context = {...scope, resourceId};
      activeTerminalContext.current = context; setTerminalContext(context);
      setResourceTerminalSnapshot(null); setResourceLiveTerminals([]); setResourceTerminalConnected(false);
      const fresh = await refreshResourceTerminal();
      if (activeTerminalContext.current !== context) return;
      const existing = forceNew ? undefined : reusableResourceTerminal(fresh?.terminals ?? [], resourceId, true);
      const terminal = existing ?? await api.createTerminal(context.sessionId, resourceId, resource.kind === "local" ? localShell : undefined, true);
      if (existing?.status === "ready" && existing.holder !== "user" && existing.holder !== "agent") await api.terminalControl(context.sessionId, existing.id, "user");
      if (activeTerminalContext.current !== context) return;
      setTerminalId(terminal.id);
      await refreshResourceTerminal();
      void refreshCatalog().catch(handleFailure);
    } catch (error) {
      if (!context || activeTerminalContext.current === context) { setTerminalError(readableError(error)); handleFailure(error); }
    } finally { setPendingOperation(""); }
  }
  function selectTerminalTab(item: TerminalSession) {
    if (terminalContext && item.sessionId !== terminalContext.sessionId) {
      const context = {sessionId: item.sessionId, resourceId: item.resourceId};
      activeTerminalContext.current = context; setTerminalContext(context);
      setResourceTerminalSnapshot(null); setResourceTerminalConnected(false);
    }
    setTerminalId(item.id); setTerminalHistory(null); setTerminalError("");
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
      const resource = resourceKind === "ssh" ? await api.createSshResource(sshProject, sshName.trim(), sshDraft) : await api.createServiceResource(sshProject, sshName.trim(), resourceKind, settings);
      await refreshCatalog();
      setSshProject(null); setSshDraft(emptySSH());
      navigate({ sessionId, resourceId: resource.id });
      notify("资源已添加；请在新会话中关联它");
    } catch (error) { setSshError(readableError(error)); }
    finally { setSshBusy(false); }
  }
  function terminalInput(data: string) {
    if (!terminalSessionId || !terminalId || !terminalConnected || currentTerminal?.holder !== "user" || !["ready", "busy"].includes(currentTerminal.status) || !currentTerminal.interactive && currentTerminal.status !== "busy") return;
    const session = terminalSessionId; const terminal = terminalId;
    inputQueue.current = inputQueue.current.then(() => api.terminalInput(session, terminal, data)).then(() => {}).catch(handleFailure);
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
      await refreshTerminal(); await refreshCatalog();
      if (terminalId === item.id) {
        const next = terminalList.find(terminal => terminal.id !== item.id && terminal.status !== "disconnected");
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
    void api.decide(action.id, "approve").then(refreshCurrent).catch(error => {
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
  const itemList = activeSnapshot ? timelineItems(activeSnapshot) : [];
  const terminalDrawer = <section className="terminal-panel-content" aria-label="会话持续终端">
    <div className="terminal-panel-header">
      <strong>{terminalResource?.name || "终端"}</strong>
      <div className="terminal-header-actions">
        <button type="button" className="icon-button" aria-label="清屏" title="清屏" onClick={() => terminalControlRef.current?.clear()}><Glyph name="refresh" size={16}/></button>
        <button type="button" className="icon-button" aria-label="新建终端" title="新建终端" disabled={!terminalResource || !!pendingOperation} onClick={() => terminalResource && void openTerminalFor(terminalResource.id, true)}><Glyph name="plus" size={17}/></button>
        <button type="button" className="icon-button" aria-label="终端选项" title="终端选项" aria-expanded={terminalOptionsOpen} onClick={() => setTerminalOptionsOpen(value => !value)}>⋮</button>
        <button type="button" className="icon-button" aria-label="收起终端" title="收起终端，保留连接" onClick={closeTerminalPanel}><Glyph name="close" size={17}/></button>
      </div>
      {terminalOptionsOpen && <div className="terminal-action-menu">
        <label>本地 Shell<select value={localShell} onChange={event => setLocalShell(event.target.value)}>{["bash","zsh","sh","fish"].map(shell => <option key={shell}>{shell}</option>)}</select></label>
        <button type="button" disabled={!currentTerminal || currentTerminal.status !== "ready" || currentTerminal.holder !== "user"} onClick={() => { setTerminalOptionsOpen(false); setCommandEditorOpen(true); }}>运行完整命令…</button>
        {!terminalContext && currentTerminal?.holder === "user" && currentTerminal.status === "ready" && <button type="button" onClick={() => { setTerminalOptionsOpen(false); void changeHolder("agent"); }}>交给终端专员</button>}
        {currentTerminal?.status === "busy" && <button type="button" onClick={() => { setTerminalOptionsOpen(false); void interruptTerminal(); }}>中断命令</button>}
        {currentTerminal?.status !== "disconnected" && terminalId && <button type="button" onClick={() => { setTerminalOptionsOpen(false); void disconnectTerminal(); }}>断开连接</button>}
      </div>}
    </div>
    <div className="terminal-tab-bar">
      <button type="button" className="terminal-list-button" aria-expanded={terminalListOpen} onClick={() => setTerminalListOpen(value => !value)}><Glyph name="menu" size={15}/>列表<Glyph name="chevron" size={13}/></button>
      <div className="terminal-tabs" ref={terminalTabsRef} role="tablist" aria-label="选择终端">{terminalOptions.map(({terminal: item, label}) => <div className={`terminal-tab-wrap ${terminalId === item.id ? "selected" : ""}`} key={item.id}>
        <button type="button" role="tab" aria-label={label} title={label} aria-selected={terminalId === item.id} className="terminal-tab" onClick={() => selectTerminalTab(item)}><Glyph name="terminal" size={14}/><span className="terminal-tab-label">{label}</span><span className={`terminal-tab-dot ${item.status}`}/></button>
        <button type="button" className="terminal-tab-close" aria-label={`关闭 ${label}`} title="关闭终端" disabled={!!pendingOperation} onClick={() => void closeTerminalTab(item)}><Glyph name="close" size={12}/></button>
      </div>)}</div>
      {terminalListOpen && <div className="terminal-list-menu">{terminalOptions.map(({terminal: item, label}) => <button type="button" key={item.id} onClick={() => selectTerminalTab(item)}><Glyph name="terminal" size={14}/><span>{label}</span><small>{terminalLabels[item.status]}</small></button>)}{!terminalOptions.length && <span>暂无在线终端</span>}{terminalResource && <button type="button" disabled={!!pendingOperation || !terminalConnected} onClick={() => { setTerminalListOpen(false); void openTerminalFor(terminalResource.id, true); }}><Glyph name="plus" size={14}/><span>新建终端</span></button>}</div>}
    </div>
    <div className="drawer-body">
      {!terminalId && (terminalError ? <div className="terminal-load-error" role="alert">{terminalError}{terminalOpeningResource && <button type="button" disabled={!!pendingOperation} onClick={() => void openTerminalFor(terminalOpeningResource)}>重新连接</button>}</div> : <div className="terminal-placeholder" role="status">{pendingOperation.startsWith("resource:") ? `正在连接 ${terminalResource?.name || "终端"}…` : "暂无在线终端，点击上方 + 新建终端"}</div>)}
      {terminalId && <div className="terminal-session">
        {terminalError ? <div className="terminal-load-error" role="alert">{terminalError}<button type="button" onClick={() => setTerminalRefresh(value => value + 1)}>重新读取</button></div> : terminalHistory?.terminal.id === terminalId ? <TerminalPane key={terminalId} showCommandEntries={!terminalContext && currentTerminal?.interactive !== true} controlRef={terminalControlRef} entries={terminalHistory.entries} output={terminalHistory.output} interactive={terminalConnected && currentTerminal?.holder === "user" && ["ready","busy"].includes(currentTerminal.status) && (currentTerminal.interactive === true || currentTerminal.status === "busy")} onInput={terminalInput} onResize={terminalResize}/> : <div className="terminal-placeholder">正在读取终端…</div>}
        {currentTerminal && (currentTerminal.status === "disconnected" || currentTerminal.status === "unknown" || !currentTerminal.interactive || currentTerminal.holder !== "user") && <div className="terminal-status-line"><span>{currentTerminal.status === "disconnected" ? "连接已断开 · 历史输出" : currentTerminal.holder === "agent" ? currentTerminal.interactive ? "Lake 正在使用终端 · 执行完成后恢复输入" : "终端专员正在持有输入" : currentTerminal.status === "unknown" ? "终端状态待核查" : "命令记录终端"}</span>{currentTerminal.holder !== "user" && currentTerminal.status === "ready" ? <button type="button" onClick={() => void changeHolder("user")}>接管输入</button> : currentTerminal.status !== "busy" && <button type="button" onClick={() => terminalResource && void openTerminalFor(terminalResource.id, true)}>打开交互终端</button>}</div>}
      </div>}
    </div>
  </section>;

  return <div className={`app-shell ${terminalOpen ? "terminal-is-open" : ""}`}>
    {mobileMenu && <button className="mobile-scrim" aria-label="关闭项目导航" onClick={() => setMobileMenu(false)}/>}
    <aside className={`sidebar ${mobileMenu ? "sidebar-open" : ""}`} aria-label="项目导航">
      <div className="sidebar-head mobile-only"><button className="icon-button" title="关闭导航" aria-label="关闭导航" onClick={() => setMobileMenu(false)}><Glyph name="close"/></button></div>
      <div className="sidebar-projects-head"><span>项目</span><button className="sidebar-add" title="新建项目" aria-label="新建项目" onClick={openProjectDialog} disabled={!connected}><Glyph name="plus" size={16}/></button></div>
      <nav className="project-scroll">
        {projectList.length ? projectList.map(project => {
          const expanded = expandedProjects.includes(project.id);
          const sessionsExpanded = !closedSessionGroups.includes(project.id);
          const sessions = catalog.sessions.filter(session => session.projectId === project.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          const projectResources = catalog.resources.filter(resource => resource.projectId === project.id);
          return <div className="project-group" key={project.id}>
            <button className="project-toggle" aria-expanded={expanded} onClick={() => setExpandedProjects(items => expanded ? items.filter(id => id !== project.id) : [...items, project.id])}>
              <span className="project-mark"><Glyph name="folder" size={17}/></span><span className="project-name">{project.name}</span><Glyph name="chevron" size={16} className={expanded ? "chevron-open" : ""}/>
            </button>
            {expanded && <div className="project-contents">
              <div className="nav-heading"><button type="button" className="nav-section-toggle" aria-label={`${sessionsExpanded ? "折叠" : "展开"}${project.name}的会话`} aria-expanded={sessionsExpanded} aria-controls={`project-sessions-${project.id}`} onClick={() => setClosedSessionGroups(items => sessionsExpanded ? [...items, project.id] : items.filter(id => id !== project.id))}><Glyph name="chevron" size={13} className={sessionsExpanded ? "chevron-open" : ""}/><span>会话 <small>{sessions.length}</small></span></button><button className="nav-add" aria-label={`在${project.name}新建会话`} title="新建会话" disabled={!connected} onClick={() => { setClosedSessionGroups(items => items.filter(id => id !== project.id)); openSessionDialog(project.id); }}><Glyph name="plus" size={14}/></button></div>
              <div id={`project-sessions-${project.id}`} hidden={!sessionsExpanded}>{sessions.length ? sessions.map(session => <div className="nav-row-wrap" key={session.id}>
                <button className={`nav-row ${route.sessionId === session.id && !route.resourceId ? "active" : ""}`} onClick={() => navigate({ sessionId: session.id, resourceId: null })} aria-current={route.sessionId === session.id && !route.resourceId ? "page" : undefined}>
                  <Glyph name="chat" size={16}/><span className="nav-row-text"><strong>{session.title}</strong><small>{sessionLabels[session.status]}</small></span>{session.status === "waiting_approval" && <span className="attention-dot" title="等待确认"/>}
                </button>
                <button className="session-delete" title="删除会话" aria-label={`删除会话 ${session.title}`} onClick={() => { setDeleteError(""); setDeleteTarget(session); }} disabled={!connected || !!pendingOperation}><Glyph name="trash" size={14}/></button>
              </div>) : <p className="nav-empty">还没有会话</p>}</div>
              {<ResourceTree project={project} resources={projectResources} nodes={catalog.resourceTree ?? []} disabled={!connected} refresh={refreshCatalog} onAddResource={() => { setResourceKind("ssh"); setSshProject(project.id); setSshName(""); setSshDraft(emptySSH()); setSshError(""); }} renderResource={resource => {
                const live = resourceTerminals.filter(t => t.resourceId === resource.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
                return <div key={resource.id} className="resource-nav-wrap" ref={resourceTerminalMenu === resource.id ? resourceMenuRef : undefined}><div className="resource-nav-row">
                  <button id={`resource-trigger-${resource.id}`} className={`nav-row resource-row ${route.resourceId === resource.id || terminalOpen && terminalResource?.id === resource.id ? "active" : ""}`} onClick={() => { if (["local", "ssh"].includes(resource.kind)) { setResourceTerminalMenu(current => current === resource.id ? null : resource.id); void refreshCatalog().catch(handleFailure); } else navigate({ sessionId: route.sessionId, resourceId: resource.id }); }} aria-expanded={["local", "ssh"].includes(resource.kind) ? resourceTerminalMenu === resource.id : undefined} aria-current={route.resourceId === resource.id ? "page" : undefined}>
                    <Glyph name="server" size={16}/><span className="nav-row-text"><strong>{resource.name}</strong><small>{resource.kind === "ssh" ? "SSH 主机" : "本机"}{live.length ? ` · ${live.length} 个终端` : ""}</small></span><span className={`resource-indicator ${resource.status}`} title={resource.status === "available" ? "可用" : "不可用"}/>
                  </button>
                  {["local", "ssh"].includes(resource.kind) && <button type="button" className="resource-terminal-button" aria-label={`管理 ${resource.name} 的终端`} aria-expanded={resourceTerminalMenu === resource.id} disabled={!connected} onClick={() => { setResourceTerminalMenu(current => current === resource.id ? null : resource.id); void refreshCatalog().catch(handleFailure); }} title="管理终端"><Glyph name="terminal" size={15}/></button>}
                </div>{resourceTerminalMenu === resource.id && <ResourceTerminalMenu anchor={resourceMenuRef} menuRef={resourcePopupRef} label={`${resource.name} 终端`}>
                  <div className="resource-terminal-heading"><div><strong title={resource.name}>{resource.name}</strong><small>终端管理</small></div><button type="button" onClick={() => { setResourceTerminalMenu(null); document.getElementById(`resource-trigger-${resource.id}`)?.focus(); }} aria-label="收起资源终端"><Glyph name="close" size={15}/></button></div>
                  <div className="resource-terminal-actions">
                    <button type="button" className="resource-open-terminal" aria-label={`打开 ${resource.name} 的终端`} disabled={!connected || !persistentMode || !!pendingOperation || resource.status !== "available"} onClick={() => void openTerminalFromSidebar(resource.id)}><Glyph name="terminal" size={17}/><span><strong>打开终端</strong><small>{live.length ? "继续使用已有连接" : "连接此资源"}</small></span><Glyph name="arrow" size={15}/></button>
                    <button type="button" className="resource-new-terminal" aria-label={`为 ${resource.name} 新建终端`} disabled={!connected || !persistentMode || !!pendingOperation || resource.status !== "available"} onClick={() => void openTerminalFor(resource.id, true)}><Glyph name="plus" size={17}/><span><strong>新建终端</strong><small>为此资源新增独立连接</small></span><Glyph name="arrow" size={15}/></button>
                  </div>
                  <div className="resource-terminal-list-heading"><span>在线终端</span><small>{live.length}</small></div>
                  <div className="resource-terminal-connections">{live.length ? live.map((t, i) => <div className="resource-terminal-item" key={t.id}><div><strong>终端 {i + 1}</strong><small title={t.sessionTitle || "独立连接"}>{t.sessionTitle || "独立连接"}</small></div><span className={`resource-terminal-state state-${t.status}`}><i/>{t.status === "busy" ? "执行中" : t.status === "connecting" ? "连接中" : t.status === "unknown" ? "待核查" : "空闲"}<small>{t.holder === "agent" ? "Lake" : "用户"}</small></span><button type="button" title={`关闭终端 ${i + 1}`} aria-label={`关闭 ${t.sessionTitle || "资源"} 的终端 ${i + 1}`} disabled={!!pendingOperation} onClick={() => void closeResourceTerminal(resource.id, t.id)}><Glyph name="close" size={14}/></button></div>) : <p className="resource-terminal-empty">暂无在线终端</p>}</div>
                  {live.some(t => t.status === "busy") && <p className="resource-terminal-note">关闭执行中的终端会中断当前命令。</p>}
                  <div className="resource-terminal-footer"><button type="button" className="resource-view-info" onClick={() => { setResourceTerminalMenu(null); navigate({sessionId, resourceId: resource.id}); }}><Glyph name="server" size={14}/>资源信息</button>{live.length > 1 && <button type="button" className="resource-terminal-close-all" disabled={!!pendingOperation} onClick={() => void closeResourceTerminal(resource.id)}>关闭全部</button>}</div>
                </ResourceTerminalMenu>}</div>;
              }}/>}
            </div>}
          </div>;
        }) : <div className="sidebar-empty"><Glyph name="layers" size={25}/><p>还没有项目</p><button onClick={openProjectDialog} disabled={!connected}>创建第一个项目</button></div>}
      </nav>
      <button className="sidebar-settings" onClick={() => void openSettings()} disabled={booting}>
        <Glyph name="settings" size={16}/><span>设置</span>
        {!modelConfigured && <span className="settings-flag">模型未配置</span>}
      </button>
    </aside>

    <main className="workspace">
      <header className="workspace-header">
        <button className="icon-button mobile-only" aria-label="打开项目导航" onClick={() => setMobileMenu(true)}><Glyph name="menu" size={21}/></button>
        <div className="breadcrumbs"><span>工作空间</span><span className="crumb-slash">/</span><span>{projectList.find(project => project.id === (selectedResource?.projectId ?? selectedSession?.projectId))?.name ?? "项目"}</span><span className="crumb-slash">/</span><strong>{selectedResource?.name ?? selectedSession?.title ?? "概览"}</strong></div>
      </header>

      {!modelConfigured && <div className="system-banner model-banner" role="status"><Glyph name="alert" size={18}/><span>尚未配置 Agent 模型。可浏览项目、资源和命令记录；发送对话需要先在设置里填写模型端点、名称和密钥。</span><button onClick={() => void openSettings()}><Glyph name="settings" size={15}/>打开设置</button></div>}
      {!persistentMode && <div className="system-banner model-banner" role="status"><Glyph name="alert" size={18}/><span>服务端不支持持续终端。请核对服务端版本。</span></div>}
      {connection.warning && warningSessionId === sessionId && <div className="system-banner offline-banner" role="alert"><Glyph name="alert" size={18}/><span>{visibleSessionError || "实时连接已断开。当前内容可能不是最新状态，操作已暂停。"}</span><button onClick={() => sessionId ? setSessionReload(value => value + 1) : void loadApp()}><Glyph name="refresh" size={15}/>重试</button></div>}

      {selectedResource ? <><ResourceDetail resource={selectedResource} project={projectList.find(project => project.id === selectedResource.projectId)} sessions={catalog.sessions.filter(session => session.projectId === selectedResource.projectId)} selectedSession={selectedSession} terminalList={resourceTerminals} disabled={!connected || !!pendingOperation} onBack={() => navigate({ sessionId, resourceId: null })} onNewSession={() => openSessionDialog(selectedResource.projectId)} onSession={id => navigate({ sessionId: id, resourceId: null })} />
        </> : sessionId && selectedSession ? <div className="session-view">
        <section ref={conversationRef} onWheel={pauseFollowing} onPointerDown={pauseFollowing} onKeyDown={event => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) pauseFollowing(); }} onScroll={event => { if (conversationFollower.current?.animating) return; const container = event.currentTarget; conversationScroll.current.following = container.scrollHeight - container.clientHeight - container.scrollTop < 80; }} className="conversation" aria-label="会话记录">
          {!activeSnapshot ? visibleSessionError ? <div className="timeline-empty"><div className="empty-icon"><Glyph name="refresh" size={24}/></div><h2>会话未能加载</h2><p>{visibleSessionError}</p><button className="button secondary" onClick={() => setSessionReload(value => value + 1)}><Glyph name="refresh" size={16}/>重新获取</button></div> : <div className="session-loading" aria-busy="true">{loadingSessionId === sessionId && <span role="status">正在加载会话…</span>}</div> : itemList.length ? <div className="timeline-list">
            {activeSnapshot?.ai ? <AITranscript snapshot={activeSnapshot} onInspect={pauseFollowing} renderAction={action => <TimelineNode entry={{ kind: "action", at: action.createdAt, id: action.id, item: action }} resourceMap={resourceMap} sessionTitle={selectedSession.title} disabled={!sessionConnected || !!pendingOperation} pendingOperation={pendingOperation} terminals={conversationTerminals} onDecision={decide} onHandoff={handoffAction} persistentMode={persistentMode} onResource={resourceId => navigate({ sessionId, resourceId })}/>} /> : itemList.map(entry => <TimelineNode key={`${entry.kind}:${entry.id}`} entry={entry} resourceMap={resourceMap} sessionTitle={selectedSession.title} disabled={!sessionConnected || messageBlocked || !!pendingOperation} pendingOperation={pendingOperation} terminals={conversationTerminals} onDecision={decide} onHandoff={handoffAction} persistentMode={persistentMode} onResource={resourceId => navigate({ sessionId, resourceId })} />)}
            {selectedSession.status === "investigating" && !activeSnapshot.ai && <div className="timeline-item item-thinking" role="status" aria-live="polite"><span className="timeline-point"><Glyph name="spark" size={15}/></span><div className="timeline-content"><div className="thinking-line"><span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span><span>正在处理…</span></div></div></div>}
          </div> : <div className="timeline-empty"><div className="empty-icon"><Glyph name="chat" size={25}/></div><h2>从一个问题开始</h2><p>描述你看到的故障或想核实的现象。Lake 会把调查过程、证据和需要确认的操作留在这里。</p>{!modelConfigured && <span className="empty-hint">配置 Agent 模型后可发送第一条消息。</span>}</div>}
        </section>
        <div className="composer-dock">{activeSnapshot?.ai && <AIControls snapshot={activeSnapshot} refresh={refreshCurrent} optionsOpen={agentOptionsOpen} onCloseOptions={() => setAgentOptionsOpen(false)} permissionsOpen={permissionsOpen} permissionAnchor={permissionButtonRef} onClosePermissions={() => setPermissionsOpen(false)}/>}<form className="composer" onSubmit={sendMessage}><label htmlFor="message-input" className="visually-hidden">给 Lake 的消息</label>
          {mention && mentionMatches.length > 0 && <div className="mention-menu" role="listbox" aria-label="引用资源">
            <span className="mention-head">引用资源</span>
            {mentionMatches.map((resource, index) => <button type="button" role="option" aria-selected={index === mention.index} key={resource.id} className={`mention-item ${index === mention.index ? "selected" : ""}`} onMouseDown={event => event.preventDefault()} onClick={() => insertMention(resource)}><Glyph name="server" size={14}/><span>{resource.name}</span><small>{resource.status === "available" ? "可用" : "不可用"}</small></button>)}
          </div>}
          {imageDraft.length > 0 && <div className="image-drafts">{imageDraft.map(image => <figure key={image.id}><img src={`data:${image.mimeType};base64,${image.base64}`} alt={image.name || "待发送图片"}/><button type="button" aria-label={`移除 ${image.name || "图片"}`} onClick={() => setImageDraft(images => images.filter(item => item.id !== image.id))}>×</button></figure>)}</div>}{mentionRefs.length > 0 && <div className="reference-chips">{mentionRefs.map(ref => <span key={`${ref.resourceId}:${ref.start}`}>{ref.label}</span>)}</div>}<div className="composer-body"><textarea id="message-input" ref={messageInputRef} rows={2} placeholder={!modelConfigured ? "配置 Agent 模型后即可开始对话" : selectedSession.status === "investigating" ? "Lake 正在回复，请等待本轮结果" : activeSnapshot?.ai?.pending ? "确认或拒绝操作，或停止本轮后继续对话" : pendingApproval ? "可以继续讨论，操作由确认按钮单独处理" : "向 Lake 描述问题，输入 @ 可引用资源…"} value={messageDraft} onChange={event => { setMentionRefs(refs => rebaseMentions(messageDraft, event.target.value, refs)); setMessageDraft(event.target.value); syncMention(event.target.value, event.target.selectionStart ?? event.target.value.length); }} disabled={!sessionConnected || !modelConfigured || messageBlocked || !!pendingOperation} onKeyDown={event => {
            if (mention && mentionMatches.length) {
              if (event.key === "ArrowDown") { event.preventDefault(); setMention({ ...mention, index: (mention.index + 1) % mentionMatches.length }); return; }
              if (event.key === "ArrowUp") { event.preventDefault(); setMention({ ...mention, index: (mention.index - 1 + mentionMatches.length) % mentionMatches.length }); return; }
              if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); insertMention(mentionMatches[Math.min(mention.index, mentionMatches.length - 1)]!); return; }
              if (event.key === "Escape") { event.preventDefault(); setMention(null); return; }
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
          }}/></div><div className="composer-foot"><input ref={imageInputRef} className="visually-hidden" type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" onChange={event => void attachImages(event.target.files)}/><button type="button" className="image-attach-button" disabled={!bootstrap?.supportsImageInput || messageBlocked || !!pendingOperation} title={bootstrap?.supportsImageInput ? "添加图片" : "先在模型设置中启用图片输入能力"} onClick={() => imageInputRef.current?.click()}><Glyph name="plus" size={14}/>图片</button>{activeSnapshot?.ai && <button type="button" ref={permissionButtonRef} className="composer-permission-button" aria-label="会话权限" title="会话权限" aria-haspopup="dialog" aria-expanded={permissionsOpen} onClick={() => setPermissionsOpen(current => !current)}><Glyph name="shield" size={18}/></button>}<div className="composer-status">{activeSnapshot?.ai && <ContextUsage view={activeSnapshot.ai} model={bootstrap || undefined}/>}<div className="model-switch-wrap" ref={modelMenuRef}>
          <button type="button" className={`model-switch ${modelConfigured ? "" : "model-missing"}`} onClick={() => void openModelMenu()} aria-haspopup="menu" aria-expanded={modelMenuOpen}><span>{modelConfigured ? (bootstrap?.modelName ?? "已配置") : "选择模型"}</span><Glyph name="chevron" size={13} className={modelMenuOpen ? "chevron-open" : ""}/></button>
          {modelMenuOpen && <div className="model-menu" role="menu" aria-label="切换模型">
            <span className="model-menu-head">选择模型</span>
            {modelMenu.loading && <p className="model-menu-note">正在获取可用模型…</p>}
            {!modelMenu.loading && modelMenu.models.map(model => <button type="button" role="menuitemradio" aria-checked={model === bootstrap?.modelName} key={model} className={`model-menu-item ${model === bootstrap?.modelName ? "selected" : ""}`} onClick={() => void switchModel(model)} disabled={!!pendingOperation}><span>{model}</span>{model === bootstrap?.modelName && <Glyph name="check" size={14}/>}</button>)}
            {!modelMenu.loading && !modelMenu.models.length && modelMenu.message && <p className="model-menu-note">{modelMenu.message}</p>}
            <div className="model-menu-sep"/>
            <button type="button" role="menuitem" className="model-menu-item" onClick={() => { setModelMenuOpen(false); void openSettings(); }}><span>模型设置…</span><Glyph name="settings" size={14}/></button>
          </div>}
        </div>{activeSnapshot?.ai && <ReasoningSelector key={sessionId} session={sessionId} modelId={bootstrap?.modelId} disabled={!sessionConnected || turnActive || !!pendingOperation} onSaving={saving => setPendingOperation(current => saving ? "reasoning" : current === "reasoning" ? "" : current)}/>}</div><button className={`send-button${turnActive ? " stop-button" : ""}`} type={turnActive ? "button" : "submit"} aria-label={turnActive ? "停止本轮" : "发送消息"} title={turnActive ? "停止本轮" : "发送消息"} aria-busy={stoppingTurn} onClick={turnActive ? () => void stopCurrentTurn() : undefined} disabled={turnActive ? stoppingTurn || !sessionConnected : (!messageDraft.trim() && !imageDraft.length) || !sessionConnected || !modelConfigured || messageBlocked || !!pendingOperation || stoppingTurn}><Glyph name={turnActive ? "stop" : "send"} size={19}/></button></div></form></div>
      </div> : <div className="welcome-view"><div className="welcome-content"><Brand/><h1>今天要处理什么问题？</h1><p>从项目开始一段会话。Lake 会把调查、证据和需要你确认的操作留在对话中。</p>{!projectList.length ? <button className="button primary" disabled={!connected} onClick={openProjectDialog}>创建第一个项目<Glyph name="arrow" size={17}/></button> : <button className="button primary" disabled={!connected} onClick={() => openSessionDialog(projectList[0].id)}>开始新会话<Glyph name="arrow" size={17}/></button>}</div></div>}
    </main>
    <TerminalSidePanel open={terminalOpen} onClose={closeTerminalPanel} onOpen={() => { revealActiveTerminalTab(); if (!commandBusy && currentTerminal?.holder === "user" && currentTerminal.status === "ready") terminalControlRef.current?.focus(); }}>{terminalDrawer}</TerminalSidePanel>
    {commandEditorOpen && <div className="modal-scrim"><section className="modal" role="dialog" aria-modal="true" aria-label="运行完整命令"><div className="modal-header"><h2>运行完整命令</h2><button type="button" className="icon-button" aria-label="关闭命令输入" onClick={() => setCommandEditorOpen(false)}><Glyph name="close"/></button></div><form className="command-form" onSubmit={reviewCommand}><label htmlFor="command-input">发送到 {resourceLabel(terminalResource)} 的命令</label><div className="command-input-row"><textarea ref={commandInputRef} id="command-input" rows={2} spellCheck={false} placeholder="输入单行命令，Enter 执行" value={commandDraft} onChange={event => { setCommandDraft(event.target.value); setCommandError(""); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} disabled={!terminalConnected || !persistentMode || currentTerminal?.holder !== "user" || currentTerminal.status !== "ready" || commandBusy}/><button type="submit" className="button command-button" disabled={!commandDraft.trim() || !terminalConnected || !persistentMode || currentTerminal?.holder !== "user" || currentTerminal.status !== "ready" || commandBusy}>执行<Glyph name="arrow" size={15}/></button></div>{commandError && <p className="form-error" role="alert">{commandError}</p>}<p>只读命令直接执行，变更命令需确认。运行交互程序时，可在上方终端输入按键。{currentTerminal?.holder !== "user" && currentTerminal?.status === "ready" ? "请先接管输入。" : ""}{currentTerminal?.status === "unknown" ? "执行结果不明，请先核查，避免重复提交。" : ""}</p></form></section></div>}
    {terminalContext && resourceTerminalSnapshot?.hostKeyTrust && <HostKeyTrust session={terminalContext.sessionId} prompt={resourceTerminalSnapshot.hostKeyTrust} disabled={!terminalConnected} refresh={refreshResourceTerminal}/>}
    {activeSnapshot?.hostKeyTrust && (!terminalContext || terminalContext.sessionId !== activeSnapshot.session.id) && <HostKeyTrust session={activeSnapshot.session.id} prompt={activeSnapshot.hostKeyTrust} disabled={!sessionConnected} refresh={refreshCurrent}/>}

    {notice && <div className="toast" role="status"><Glyph name="check" size={17}/>{notice}<button aria-label="关闭提示" onClick={() => setNotice("")}><Glyph name="close" size={14}/></button></div>}
    {deleteTarget && <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget && !deleteBusy) setDeleteTarget(null); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-session-title"><div className="modal-header"><span className="modal-icon danger-icon"><Glyph name="trash" size={20}/></span><button className="icon-button" aria-label="关闭" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}><Glyph name="close"/></button></div><h2 id="delete-session-title">删除会话</h2><p className="modal-description">将删除会话「{deleteTarget.title}」的对话、专员结论、证据、审批和命令记录。此操作不可恢复。</p>{deleteError && <p className="form-error" role="alert">{deleteError}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>取消</button><button type="button" className="button danger" onClick={() => void confirmDeleteSession()} disabled={deleteBusy || !connected}>{deleteBusy ? "正在删除…" : "删除会话"}</button></div></div></div>}
    {settingsOpen && <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget && !settingsBusy) setSettingsOpen(false); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-header"><span className="modal-icon"><Glyph name="settings" size={20}/></span><button className="icon-button" aria-label="关闭" onClick={() => setSettingsOpen(false)} disabled={settingsBusy}><Glyph name="close"/></button></div><h2 id="settings-title">模型设置</h2>{activeSnapshot?.ai && !selectedResource && <div className="settings-session-entry"><span>当前会话</span><button type="button" className="button secondary" onClick={() => { setSettingsOpen(false); setAgentOptionsOpen(true); }}>会话配置</button></div>}<p className="modal-description">先选服务商、填入密钥，再点“测试连接”确认可用，然后保存。密钥只保存在服务端本机，不会回传到浏览器。</p>
      <div className={`settings-source source-${settings?.source ?? "none"}`} role="status">{settings?.source === "settings" ? "当前配置来自此界面。" : settings?.source === "environment" ? "当前配置来自启动环境变量；保存后将以此界面的设置为准。" : "尚未配置模型，专员调查不可用。"}</div>
      <form onSubmit={submitSettings}>
        <span className="field-label">服务商</span>
        <div className="preset-row" role="radiogroup" aria-label="选择模型服务商">
          {modelPresets.map(preset => <button type="button" key={preset.id} role="radio" aria-checked={presetId === preset.id} className={`preset-chip ${presetId === preset.id ? "selected" : ""}`} onClick={() => choosePreset(preset)}>{preset.label}</button>)}
        </div>
        {selectedPreset.models.length > 0 && <><span className="field-label">常用模型</span><div className="preset-row model-row">{selectedPreset.models.map(model => <button type="button" key={model} className={`preset-chip ${draftModelName === model ? "selected" : ""}`} onClick={() => { setDraftModelName(model); setTestState(null); }}>{model}</button>)}</div></>}
        <label className="field-label">模型名称<input maxLength={200} spellCheck={false} autoComplete="off" placeholder="选择上方模型，或直接填写模型 ID" value={draftModelName} onChange={event => { setDraftModelName(event.target.value); setTestState(null); }}/></label>
        <label className="field-label">API Key<input type="password" autoComplete="off" maxLength={4096} placeholder={settings?.keyConfigured ? "已保存密钥；留空保持不变" : "服务商的密钥；本地模型可留空"} value={draftModelKey} onChange={event => { setDraftModelKey(event.target.value); setTestState(null); }}/></label>
        <details className="settings-advanced"><summary>高级：端点 URL</summary><label className="field-label">端点 URL<input maxLength={2000} spellCheck={false} autoComplete="off" placeholder="https://api.example.com/v1/chat/completions" value={draftModelUrl} onChange={event => { setDraftModelUrl(event.target.value); setTestState(null); }}/></label><label className="field-label">接口协议<select value={draftModelProtocol} onChange={event => setDraftModelProtocol(event.target.value)}>{[["openai", "OpenAI Chat Completions"], ["openai-response", "OpenAI Responses"], ["azure-gpt", "Azure OpenAI"], ["claude", "Anthropic Messages"], ["gemini", "Gemini"], ["ollama", "Ollama"]].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label className="check-row"><input type="checkbox" checked={imageInputCapability} onChange={event => setImageInputCapability(event.target.checked)}/>模型支持图片输入</label><label className="check-row"><input type="checkbox" checked={imageOutputCapability} onChange={event => setImageOutputCapability(event.target.checked)}/>启用图片输出（Responses / Gemini / 兼容端点）</label><p className="settings-note">使用所选协议对应的完整端点。Gemini 可在端点中用 {"{model}"} 表示模型名。</p></details>
        {testState && <p className={`settings-test ${testState.ok ? "test-ok" : "test-fail"}`} role="status">{testState.ok ? "✓ " : "✕ "}{testState.message}</p>}
        {settingsError && <p className="form-error" role="alert">{settingsError}</p>}
        <div className="modal-actions">
          {settings?.source === "settings" && <button type="button" className="button secondary" onClick={() => void clearSettings()} disabled={settingsBusy}>清除界面配置</button>}
          <button type="button" className="button secondary" onClick={() => void testConnection()} disabled={testing || settingsBusy || !draftModelUrl.trim() || !draftModelName.trim()}>{testing ? "正在测试…" : "测试连接"}</button>
          <button type="submit" className="button primary" disabled={settingsBusy || !draftModelUrl.trim() || !draftModelName.trim()}>{settingsBusy ? "正在保存…" : "保存设置"}<Glyph name="arrow" size={16}/></button>
        </div>
        <p className="settings-note">保存的配置存放在服务端数据目录，文件权限仅限当前用户。留空密钥会沿用当前生效的密钥；需要更换时直接输入新值。</p>
      </form>
    </div></div>}
    {sshProject && <div className="modal-scrim"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="ssh-title"><div className="modal-header"><span className="modal-icon"><Glyph name="server" size={20}/></span><button className="icon-button" aria-label="关闭" disabled={sshBusy} onClick={() => { setSshProject(null); setSshDraft(emptySSH()); }}><Glyph name="close"/></button></div><h2 id="ssh-title">新建资源</h2><p className="modal-description">添加 SSH 主机、数据库、Redis 或 Docker，供项目会话使用。</p><form onSubmit={createSsh}><label className="field-label">类型<select value={resourceKind} onChange={event => { setResourceKind(event.target.value); setSshDraft(current => ({...current, password: "", passphrase: "", privateKey: undefined, identityFile: undefined})); setServiceSettings(v => ({ ...v, port: event.target.value === "redis" ? 6379 : 5432 })); }}>{[["ssh", "SSH 主机"], ["database", "数据库"], ["docker", "Docker"], ["redis", "Redis"]].map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
      <label className="field-label">资源名称<input required maxLength={120} value={sshName} onChange={event => setSshName(event.target.value)} autoFocus/></label>
{resourceKind === "ssh" ? <SSHResourceFields value={sshDraft} onChange={setSshDraft} disabled={sshBusy}/> : <>
        {resourceKind === "database" && <label className="field-label">数据库类型<select value={serviceSettings.driver} onChange={event => setServiceSettings({ ...serviceSettings, driver: event.target.value, port: event.target.value === "mysql" ? 3306 : 5432 })}><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="sqlite">SQLite</option></select></label>}
        {resourceKind === "docker" ? <><label className="field-label">Docker 端点<input value={serviceSettings.endpoint} onChange={event => setServiceSettings({ ...serviceSettings, endpoint: event.target.value })}/></label><label className="field-label">或使用 SSH 主机<select value={serviceSettings.ssh_asset_ref} onChange={event => setServiceSettings({ ...serviceSettings, ssh_asset_ref: event.target.value })}><option value="">直接连接端点</option>{catalog.resources.filter(r => r.projectId === sshProject && r.kind === "ssh").map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label></> : resourceKind === "database" && serviceSettings.driver === "sqlite" ? <label className="field-label">SQLite 文件绝对路径<input required value={serviceSettings.path} onChange={event => setServiceSettings({ ...serviceSettings, path: event.target.value })}/></label> : <><label className="field-label">主机地址<input required value={serviceSettings.host} onChange={event => setServiceSettings({ ...serviceSettings, host: event.target.value })}/></label><label className="field-label">端口<input type="number" min={1} max={65535} value={serviceSettings.port} onChange={event => setServiceSettings({ ...serviceSettings, port: Number(event.target.value) })}/></label>{resourceKind === "database" && <><label className="field-label">用户名<input value={serviceSettings.username} onChange={event => setServiceSettings({ ...serviceSettings, username: event.target.value })}/></label><label className="field-label">数据库<input value={serviceSettings.database} onChange={event => setServiceSettings({ ...serviceSettings, database: event.target.value })}/></label></>}<label className="field-label">凭据 JSON 文件引用<input value={serviceSettings.credentialRef} onChange={event => setServiceSettings({ ...serviceSettings, credentialRef: event.target.value })} placeholder="~/.lake/secrets/ 下的文件名"/></label><label className="check-row"><input type="checkbox" checked={serviceSettings.tls} onChange={event => setServiceSettings({ ...serviceSettings, tls: event.target.checked })}/>验证 TLS 证书</label><p className="settings-note">凭据文件填写 username / password，权限须为 0600。凭据不会返回页面或写入模型上下文。</p></>}
      </>}      {sshError && <p className="form-error" role="alert">{sshError}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={() => { setSshProject(null); setSshDraft(emptySSH()); }} disabled={sshBusy}>取消</button><button type="submit" className="button primary" disabled={sshBusy}>{sshBusy ? "正在添加…" : "添加资源"}</button></div>
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

function Brand({ large = false }: { large?: boolean }) {
  return <div className={`brand ${large ? "brand-large" : ""}`}><div className="brand-symbol" aria-hidden="true"><span/><span/><span/></div><div className="brand-word"><strong>lake</strong><small>运维工作台</small></div></div>;
}

function ResourceDetail({ resource, project, sessions, selectedSession, terminalList, disabled, onBack, onNewSession, onSession }: {
  resource: Resource; project?: Project; sessions: WorkSession[]; selectedSession?: WorkSession;
  terminalList: TerminalSession[]; disabled: boolean; onBack: () => void; onNewSession: () => void;
  onSession: (sessionId: string) => void;
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
    <div className="resource-detail-grid"><section className="detail-panel"><h2>资源信息</h2><dl className="detail-list"><div><dt>名称</dt><dd>{resource.name}</dd></div><div><dt>资源标识</dt><dd className="machine-text">{resource.id}</dd></div><div><dt>类型</dt><dd>{resource.kind === "ssh" ? "SSH 主机" : resource.kind === "local" ? "本机资源" : resource.kind === "database" ? "数据库" : resource.kind === "docker" ? "Docker" : "Redis"}</dd></div><div><dt>当前状态</dt><dd>{available ? "可用" : "不可用"}</dd></div>{resource.ssh && <div><dt>登录方式</dt><dd>{resource.ssh.authMethod === "password" ? "密码登录" : "密钥登录"}</dd></div>}</dl>{resource.description && <div className="resource-description"><strong>说明</strong><p>{resource.description}</p></div>}</section><section className="detail-panel action-panel"><h2>在会话中使用</h2><p>进入会话后向 Lake 描述问题，或引用此资源开始调查。</p>{targetSession && <div className="context-session"><Glyph name="chat" size={17}/><div><small>{usingSessionIds.has(targetSession.id) ? "正在使用此资源" : "当前会话"}</small><strong>{targetSession.title}</strong></div></div>}{targetSession && <button className="button primary wide" onClick={() => onSession(targetSession.id)}><Glyph name="chat" size={17}/>{usingSessionIds.has(targetSession.id) ? "进入使用中的会话" : "进入当前会话"}<Glyph name="arrow" size={16}/></button>}<button className="button secondary wide" disabled={disabled} onClick={onNewSession}><Glyph name="plus" size={17}/>新建会话</button></section></div>
    <section className="linked-sessions"><div className="linked-heading"><h2>使用中的会话</h2><span>{usingSessions.length} 条</span></div>{usingSessions.length ? usingSessions.map(session => <button className="linked-row" type="button" key={session.id} onClick={() => onSession(session.id)}><Glyph name="chat" size={16}/><span className="linked-row-text"><strong>{session.title}</strong><small>正在使用此资源</small></span><span className={`session-state state-${session.status}`}>{sessionLabels[session.status]}</span><Glyph name="arrow" size={15}/></button>) : <p>暂无会话正在使用此资源。</p>}</section>
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
    {entry.kind === "message" && <div className="message-text">{entry.item.text}</div>}
    {entry.kind === "specialist" && <div className="specialist-card"><div className="specialist-head"><div><strong>{specialistLabels[entry.item.name] ?? entry.item.name}</strong><p>{entry.item.task}</p></div><span className={`pill specialist-${entry.item.status}`}><span/>{entry.item.status === "working" ? "调查中" : entry.item.status === "completed" ? "已完成" : "未完成"}</span></div>{entry.item.summary && <details className="expand-detail"><summary>查看专员结论<Glyph name="chevron" size={15}/></summary><p>{entry.item.summary}</p></details>}{!entry.item.summary && <p className="specialist-awaiting">正在收集结果，更新会显示在这里。</p>}</div>}
    {entry.kind === "action" && <div className={`approval-card ${entry.item.status !== "pending" ? "approval-resolved" : ""}`}><div className="approval-head"><span className="approval-mark"><Glyph name="lock" size={19}/></span><div><strong>{entry.item.risk === "readonly" ? entry.item.status === "pending" ? "只读检查等待终端交接" : "只读检查" : entry.item.risk === "dangerous" ? "危险操作需要再次确认" : "变更操作需要你的确认"}</strong><p>{entry.item.riskReason}</p></div><span className={`pill action-${entry.item.status}`}>{entry.item.status === "pending" && entry.item.risk === "readonly" ? "等待交接" : actionLabels[entry.item.status]}</span></div><div className="approval-grid"><div><span>目标资源</span><button className="detail-link" onClick={() => onResource(entry.item.resourceId)}>{resourceLabel(resourceMap.get(entry.item.resourceId))}</button></div><div><span>所属会话</span><strong>{sessionTitle}</strong></div></div><div className="approval-section"><span>完整命令</span><pre>{entry.item.command}</pre></div><div className="approval-notes"><div><span>为什么执行</span><p>{entry.item.reason}</p></div><div><span>可能的影响</span><p>{entry.item.impact}</p></div><div><span>如何验证</span><p>{entry.item.verification}</p></div></div>{entry.item.status === "pending" ? <><div className={`approval-handoff ${agentReady ? "ready" : ""}`}><Glyph name={agentReady ? "check" : "terminal"} size={17}/><div><strong>{agentReady ? "目标终端已交给 Agent" : "执行前需交给 Agent 输入"}</strong><p>{agentReady ? entry.item.risk === "readonly" ? "只读检查自动执行，无需逐条确认。" : "请核对完整命令和影响，再确认本次操作。" : readyTerminal ? "此资源的持续终端由你持有。交接后，只读检查自动执行，变更仍需确认。" : "先为此资源打开持续终端，并交给 Agent 输入。"}</p></div>{!agentReady && <button className="button handoff-button" onClick={() => onHandoff(entry.item)} disabled={disabled || !!pendingOperation || !persistentMode}>{pendingOperation === `handoff:${entry.item.id}` ? "准备中…" : readyTerminal ? "交给 Agent 输入" : "创建控制台并交接"}</button>}</div><div className="approval-actions"><button className="button secondary" onClick={() => onDecision(entry.item.id, "reject")} disabled={disabled || !!pendingOperation}>{pendingOperation === entry.item.id ? "处理中…" : entry.item.risk === "readonly" ? "取消检查" : "拒绝操作"}</button>{entry.item.risk !== "readonly" && <button className="button approval-button" onClick={() => onDecision(entry.item.id, "approve")} disabled={disabled || !!pendingOperation || !agentReady || !persistentMode}>{pendingOperation === entry.item.id ? "处理中…" : entry.item.risk === "dangerous" ? "继续确认风险" : "确认本次变更"}<Glyph name="arrow" size={16}/></button>}</div></> : <div className="approval-result">{entry.item.exitCode !== null ? `执行退出码：${entry.item.exitCode}。` : ""}{entry.item.status === "unknown" ? "执行结果不明，请核查实际结果后再决定下一步。" : entry.item.status === "succeeded" ? "命令已执行；是否恢复仍需按上面的方式验证。" : `当前状态：${actionLabels[entry.item.status]}。`}</div>}</div>}
  </div></article>;
}

export default App;
