import { ListChecks, LayoutGrid, LoaderCircle, Pause, Eye, EyeOff, ArrowUpRight, Pin, GripVertical, Ellipsis, Search, Layers, Folder, Shield, ShieldCheck, Plus, Paperclip, ChevronDown, Terminal, MessageCircle, MessageCirclePlus, Server, ArrowRight, ArrowUp, ArrowDown, X, Menu, RefreshCw, Check, CircleAlert, TriangleAlert, Sparkles, Clock, Lock, Link, Send, CornerDownLeft, Square, Copy, Maximize2, Settings, Trash2, Database, Container, Monitor, Network, Code, ChartNoAxesCombined, Bug, BookOpen, FileText, Box, SlidersHorizontal, PanelLeft, Pencil, ChevronLeft, ChevronRight, Plug, Image, Brain, UsersRound, Palette, Archive, File, Film, Headphones, Table2, Upload, AtSign, type LucideIcon } from "lucide-react";

const icons = {listTasks:ListChecks,workspace:LayoutGrid,loader:LoaderCircle,pause:Pause,eye:Eye,eyeOff:EyeOff,pin:Pin,grip:GripVertical,more:Ellipsis,search:Search,layers:Layers,folder:Folder,shield:ShieldCheck,shieldOutline:Shield,plus:Plus,paperclip:Paperclip,chevron:ChevronDown,terminal:Terminal,chat:MessageCircle,chatAdd:MessageCirclePlus,server:Server,arrow:ArrowRight,outbound:ArrowUpRight,up:ArrowUp,down:ArrowDown,close:X,menu:Menu,refresh:RefreshCw,check:Check,alert:TriangleAlert,circleAlert:CircleAlert,spark:Sparkles,clock:Clock,lock:Lock,link:Link,send:Send,return:CornerDownLeft,stop:Square,copy:Copy,expand:Maximize2,settings:Settings,trash:Trash2,database:Database,docker:Container,local:Monitor,redis:Database,kubernetes:Layers,apisix:Network,prometheus:ChartNoAxesCombined,victoriametrics:Database,network:Network,code:Code,chart:ChartNoAxesCombined,bug:Bug,book:BookOpen,document:FileText,box:Box,filter:SlidersHorizontal,panel:PanelLeft,edit:Pencil,previous:ChevronLeft,next:ChevronRight,plug:Plug,image:Image,brain:Brain,users:UsersRound,palette:Palette,archive:Archive,file:File,film:Film,headphones:Headphones,table:Table2,upload:Upload,at:AtSign} satisfies Record<string,LucideIcon>;
const lakeWaterline='M4 19c2-1.6 4 1.6 6 0s4 1.6 6 0 3 1 4 .3';

const lakeNavigationIcons={
 lakeSpecialists:{
  outline:<>
   <path d="M4.3 7A3.1 3.1 0 0 1 7.4 3.9h6.3A3.1 3.1 0 0 1 16.8 7v3.5a3.1 3.1 0 0 1-3.1 3.1H9.6l-3 2.25c-.44.33-1.08.02-1.08-.53v-1.9A3.1 3.1 0 0 1 4.3 11V7Z"/>
   <path d="M5.6 10.6c1.9-.95 3.6-.45 5.4.3 1.7.7 3.4.75 5-.05" strokeOpacity={0.58}/>
   <path d="M18.4 9.3c1.15.52 1.9 1.6 1.9 2.9v2.5c0 1.25-.8 2.35-1.95 2.8v1.35l-2.35-1.65h-2.8"/>
  </>,
  solid:<>
   <path d="M4.2 7A3.2 3.2 0 0 1 7.4 3.8h6.4A3.2 3.2 0 0 1 17 7v3.6a3.2 3.2 0 0 1-3.2 3.2H9.6l-3.1 2.35c-.45.35-1.1.03-1.1-.54V13.6A3.2 3.2 0 0 1 4.2 11.1V7Z" fill="currentColor" fillOpacity={0.22} stroke="currentColor" strokeWidth={1.4}/>
   <path d="M4.4 10.6c2.1-1.1 4-.55 6.1.3 2 .85 4 .9 6.3.1v.3A3 3 0 0 1 13.8 14H9.6l-3.1 2.2c-.45.32-1.1.02-1.1-.52v-2.1c-.6-.5-.95-1.35-1-2.98Z" fill="currentColor" fillOpacity={0.86}/>
   <path d="M18.4 9.2c1.1.55 1.9 1.65 1.9 2.95v2.6c0 1.3-.85 2.4-2 2.85v1.4l-2.4-1.7h-2.8" fill="none" stroke="currentColor" strokeWidth={1.45}/>
  </>,
 },
 lakeResources:{
  outline:<>
   <rect x="4" y="4.4" width="16" height="6.4" rx="2.3"/>
   <path d="M5.4 8c2.2-.75 4.4-.2 6.6.45 2.2.65 4.4.65 6.6-.05" strokeOpacity={0.58}/>
   <rect x="4" y="13.2" width="16" height="6.4" rx="2.3"/>
   <circle cx="7.4" cy="16.4" r="0.85" fill="currentColor" stroke="none"/>
   <path d="M11 16.4h5"/>
  </>,
  solid:<>
   <rect x="4" y="4.2" width="16" height="6.6" rx="2.4" fill="currentColor" fillOpacity={0.22} stroke="currentColor" strokeWidth={1.4}/>
   <path d="M4.2 7.8c2.6-.9 5.2-.3 7.8.5 2.6.8 5.2.8 7.8-.1v.5A2.2 2.2 0 0 1 17.6 10.8H6.4a2.2 2.2 0 0 1-2.2-2.2v-.8Z" fill="currentColor" fillOpacity={0.86}/>
   <rect x="4" y="13.2" width="16" height="6.6" rx="2.4" fill="currentColor" fillOpacity={0.22} stroke="currentColor" strokeWidth={1.4}/>
   <circle cx="7.4" cy="16.5" r="1.05" fill="currentColor"/>
   <path d="M11 16.5h5.2" stroke="currentColor" strokeWidth={1.5}/>
  </>,
 },
 lakeWorkspace:{
  outline:<>
   <rect x="3.8" y="4.2" width="16.4" height="15.6" rx="3.4"/>
   <path d="M9.6 4.4v15.2M12.8 14.8c1.35-.75 2.75.75 4.1 0"/>
  </>,
  solid:<>
   <rect x="3.8" y="4.2" width="16.4" height="15.6" rx="3.4" fill="currentColor" fillOpacity={0.22} stroke="currentColor" strokeWidth={1.4}/>
   <rect x="3.8" y="4.2" width="6.2" height="15.6" rx="3.1" fill="currentColor" fillOpacity={0.86}/>
   <path d="M12.8 14.8c1.35-.75 2.75.75 4.1 0" stroke="currentColor" strokeWidth={1.45}/>
  </>,
 },
} as const;

const lakeIcons={
 lakePermission:'M12 3 6 5v5c0 3 2.4 5.3 6 7 3.6-1.7 6-4 6-7V5l-6-2Z '+lakeWaterline,
 lakePilot:'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-4.6-3.4-2.2 4.6-4.6 2.2 2.2-4.6 4.6-2.2Z',
 lakeActivity:'M12 3v6M12 15v6M3 12h6M15 12h6M5.6 5.6l4.2 4.2M14.2 14.2l4.2 4.2M5.6 18.4l4.2-4.2M14.2 9.8l4.2-4.2',
 lakeConfirm:'m8 7.5 2.5 2.5 5-5M4 14.1c2-2 4 2 6 0s4 2 6 0 3 1.4 4 .5M4 18.1c2-2 4 2 6 0s4 2 6 0 3 1.4 4 .5',
 lakeTerminal:'M4 14V4h16v10M7 7l3 3-3 3M13 13h4 '+lakeWaterline,
 lakeFile:'M7 15V3h7l3 3v9M14 3v4h3M10 10h4M10 13h4 '+lakeWaterline,
 lakeSearch:'M14 12l4 4M15 8a5 5 0 1 1-10 0 5 5 0 0 1 10 0 '+lakeWaterline,
 lakeFolder:'M3 15V5h7l2 3h9v7 '+lakeWaterline,
 lakeHost:'M4 4h16v5H4zM4 12h16v4H4zM7 6.5h.1M7 14h.1 '+lakeWaterline,
 lakeDatabase:'M5 6c0-3.5 14-3.5 14 0s-14 3.5-14 0v8c0 3.5 14 3.5 14 0V6M5 10c0 3.5 14 3.5 14 0 '+lakeWaterline,
 lakeContainer:'m12 3 8 4.5v7L12 18l-8-3.5v-7L12 3M4 7.5l8 4 8-4M12 11.5V18 '+lakeWaterline,
 lakeWorkflow:'M4 4h5v5H4zM15 10h5v5h-5zM9 6.5h8.5V10M6.5 9v5.5H12 '+lakeWaterline,
 lakeSchedule:'M18.5 9a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0M12 5v4.5l3 1.5 '+lakeWaterline,
 lakeNetwork:'M10 3h4v4h-4zM3 11h4v4H3zM17 11h4v4h-4zM12 7v2H5v2M12 9h7v2 '+lakeWaterline,
 lakeQuestion:'M5 14V4h14v10h-7l-3 2v-2H5M10 7c0-2 4-2 4 0 0 1.5-2 1-2 3M12 12h.01 '+lakeWaterline,
 lakeProcess:'M6 6c2-2 4 2 6 0s4 2 6 0M6 11c2-2 4 2 6 0s4 2 6 0 '+lakeWaterline,
} as const;
export type GlyphName = keyof typeof icons | keyof typeof lakeIcons | keyof typeof lakeNavigationIcons | "grafana" | "reasoningLevel";
export const sessionIcons = [{id:"chat",label:"对话"},{id:"document",label:"文档"},{id:"terminal",label:"终端"},{id:"server",label:"服务器"},{id:"database",label:"数据库"},{id:"network",label:"网络"},{id:"code",label:"代码"},{id:"chart",label:"图表"},{id:"bug",label:"问题"},{id:"shield",label:"安全"},{id:"book",label:"手册"},{id:"box",label:"服务"}] as const;
export function Glyph({name,size=18,className="",filled=false}:{name:string;size?:number;className?:string;filled?:boolean}) {
 if(name==="grafana")return <svg width={size} height={size} viewBox="0 0 24 24" className={className} data-glyph={name} aria-hidden="true">
  <image href="/resource-icons/grafana.svg" width={24} height={24}/>
 </svg>;
 if(name==="reasoningLevel")return <svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor" className={className} data-glyph={name} aria-hidden="true">
  <rect x="1.5" y="8" width="2.5" height="4.5" rx="1"/>
  <rect x="5.75" y="5" width="2.5" height="7.5" rx="1"/>
  <rect x="10" y="2" width="2.5" height="10.5" rx="1"/>
 </svg>;
 const navigationIcon=lakeNavigationIcons[name as keyof typeof lakeNavigationIcons];
 if(navigationIcon)return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={filled?undefined:'currentColor'} strokeWidth={filled?undefined:1.55} strokeLinecap="round" strokeLinejoin="round" className={className} data-glyph={name} aria-hidden="true">
  {filled?navigationIcon.solid:navigationIcon.outline}
 </svg>;
 const path=lakeIcons[name as keyof typeof lakeIcons];
 if(path)return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" className={className} data-glyph={name} aria-hidden="true">
  <path d={path}/>
 </svg>;
 const Icon = icons[name as keyof typeof icons] ?? FileText;
 // Every loading glyph shares the existing motion and reduced-motion rules.
 const classes=name==='loader'?[...new Set(['activity-indicator',...className.split(/\s+/).filter(Boolean)])].join(' '):className;
 return <Icon size={size} strokeWidth={1.7} className={classes} aria-hidden="true"/>;
}
export function ResourceIcon({kind,size=16}:{kind:string;size?:number}) {
 if(kind==="jumpserver")return <img src="/brand/jumpserver.png" width={size} height={size} className="resource-kind-icon kind-jumpserver" alt="" aria-hidden="true" draggable={false}/>;
 return <Glyph name={kind==="ssh"?"server":kind} size={size} className={`resource-kind-icon kind-${kind}`}/>;
}
