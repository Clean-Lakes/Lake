import { ListChecks, LayoutGrid, LoaderCircle, Pause, Eye, EyeOff, ArrowUpRight, Pin, GripVertical, Ellipsis, Search, Layers, Folder, Shield, ShieldCheck, Plus, Paperclip, ChevronDown, Terminal, MessageCircle, MessageCirclePlus, Server, ArrowRight, ArrowUp, ArrowDown, X, Menu, RefreshCw, Check, CircleAlert, TriangleAlert, Sparkles, Clock, Lock, Link, Send, CornerDownLeft, Square, Copy, Maximize2, Settings, Trash2, Database, Container, Monitor, Network, Code, ChartNoAxesCombined, Bug, BookOpen, FileText, Box, SlidersHorizontal, PanelLeft, Pencil, ChevronLeft, ChevronRight, Plug, Image, Brain, UsersRound, Palette, Archive, File, Film, Headphones, Table2, Upload, AtSign, type LucideIcon } from "lucide-react";

const icons = {listTasks:ListChecks,workspace:LayoutGrid,loader:LoaderCircle,pause:Pause,eye:Eye,eyeOff:EyeOff,pin:Pin,grip:GripVertical,more:Ellipsis,search:Search,layers:Layers,folder:Folder,shield:ShieldCheck,shieldOutline:Shield,plus:Plus,paperclip:Paperclip,chevron:ChevronDown,terminal:Terminal,chat:MessageCircle,chatAdd:MessageCirclePlus,server:Server,arrow:ArrowRight,outbound:ArrowUpRight,up:ArrowUp,down:ArrowDown,close:X,menu:Menu,refresh:RefreshCw,check:Check,alert:TriangleAlert,circleAlert:CircleAlert,spark:Sparkles,clock:Clock,lock:Lock,link:Link,send:Send,return:CornerDownLeft,stop:Square,copy:Copy,expand:Maximize2,settings:Settings,trash:Trash2,database:Database,docker:Container,local:Monitor,redis:Database,kubernetes:Layers,apisix:Network,prometheus:ChartNoAxesCombined,victoriametrics:Database,network:Network,code:Code,chart:ChartNoAxesCombined,bug:Bug,book:BookOpen,document:FileText,box:Box,filter:SlidersHorizontal,panel:PanelLeft,edit:Pencil,previous:ChevronLeft,next:ChevronRight,plug:Plug,image:Image,brain:Brain,users:UsersRound,palette:Palette,archive:Archive,file:File,film:Film,headphones:Headphones,table:Table2,upload:Upload,at:AtSign} satisfies Record<string,LucideIcon>;
const lakeWaterline='M4 19c2-1.6 4 1.6 6 0s4 1.6 6 0 3 1 4 .3';

const specialistDrop='M9.15 3.1a.6.6 0 0 1 .9 0l2.5 3.05a3.8 3.8 0 1 1-5.9 0l2.5-3.05Z';
const resourceLayer='M11.3 3.65a1.55 1.55 0 0 1 1.4 0l7.93 3.84a.85.85 0 0 1 0 1.53l-7.93 3.84a1.55 1.55 0 0 1-1.4 0L3.37 9.02a.85.85 0 0 1 0-1.53Z';
const workspaceFrame='M6 3.6h12a2.8 2.8 0 0 1 2.8 2.8v11.2a2.8 2.8 0 0 1-2.8 2.8h-.7c-2.3 0-3.6-1-5.3-1s-3 1-5.3 1H6a2.8 2.8 0 0 1-2.8-2.8V6.4A2.8 2.8 0 0 1 6 3.6Z';
const lakeNavigationIcons={
 lakeSpecialists:{
  outline:[
   specialistDrop,
   'M15.52 4.8c1.7 1.7 3.05 3 3.05 4.55a3.05 3.05 0 0 1-2.55 2.99',
   'M3.3 17.6c.55-2.25 3.08-4.1 6.3-4.1s5.65 1.8 6.2 4.1M17 13.9c1.7.4 3.1 1.7 3.55 3.5',
   'M3.7 20.2c2.1-1.45 4.2 1.45 6.3 0s4.2 1.45 6.3 0 2.7.75 4 .1',
  ].join(' '),
  solid:[
   specialistDrop,
   'M14.9 5.6c-.13-.22.13-.5.34-.33 1.52 1.25 3.58 3.07 3.58 4.1 0 1.82-1.3 3.02-2.95 3.02-.32 0-.65-.06-.91-.16.67-.92 1.02-1.94 1.02-3.06 0-1.5-.5-2.48-1.08-3.57Z',
   'M3.3 17.65c0-2.34 2.8-4.17 6.3-4.17s6.3 1.83 6.3 4.17v1.47a.9.9 0 0 1-1.23.84c-1.2-.45-2.04-.62-3.2-.18-1.37.52-2.38.66-3.74.12-1.27-.5-2.09-.42-3.21.02a.9.9 0 0 1-1.22-.84Z',
   'M16.3 13.8c2.45.3 4.5 1.97 4.5 3.74v1.44a.85.85 0 0 1-1.15.8c-.72-.26-1.4-.46-2.35-.45.18-.44.23-1.22.18-1.91-.14-1.36-.59-2.57-1.18-3.62Z',
  ].join(' '),
 },
 lakeResources:{
  outline:[
   resourceLayer,
   'M3.3 12.3l8 3.9a1.55 1.55 0 0 0 1.4 0l8-3.9M4.4 17.7c2.75 0 4.5 2.7 7.6 2.7s4.85-2.7 7.6-2.7',
  ].join(' '),
  solid:[
   resourceLayer,
   'M3.04 11.45a.7.7 0 0 1 1-.62l7.04 3.4c.58.28 1.26.28 1.84 0l7.04-3.4a.7.7 0 0 1 1 .62v2.9c0 .34-.19.64-.5.8l-7.26 3.78c-.83.43-1.82.43-2.65 0l-7.01-3.78a.9.9 0 0 1-.5-.8Z',
  ].join(' '),
 },
 lakeWorkspace:{
  outline:`${workspaceFrame} M9.2 3.6v16.48M9.2 9.35h11.6`,
  solid:`${workspaceFrame} M8.45 5.4h1.5v3.25h9v1.5h-9v7.65h-1.5Z`,
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
 const solid=filled?navigationIcon?.solid:undefined;
 const path=solid??navigationIcon?.outline??lakeIcons[name as keyof typeof lakeIcons];
 if(path)return <svg width={size} height={size} viewBox="0 0 24 24" fill={solid?'currentColor':'none'} stroke={solid?'none':'currentColor'} strokeWidth={navigationIcon?1.55:1.4} strokeLinecap="round" strokeLinejoin="round" className={className} data-glyph={name} aria-hidden="true">
  <path d={path} fillRule={solid?'evenodd':undefined}/>
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
