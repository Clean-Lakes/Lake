import { Waves, GripVertical, Ellipsis, Search, Layers, Folder, ShieldCheck, Plus, ChevronDown, Terminal, MessageCircle, MessageCirclePlus, Server, ArrowRight, ArrowUp, ArrowDown, X, Menu, RefreshCw, Check, TriangleAlert, Sparkles, Clock, Lock, Link, Send, CornerDownLeft, Square, Copy, Maximize2, Settings, Trash2, Database, Container, Monitor, Network, Code, ChartNoAxesCombined, Bug, BookOpen, FileText, Box, Tag, Tags, SlidersHorizontal, PanelLeft, Pencil, ChevronRight, Plug, Image, Brain, type LucideIcon } from "lucide-react";

const icons = {waves:Waves,grip:GripVertical,more:Ellipsis,search:Search,layers:Layers,folder:Folder,shield:ShieldCheck,plus:Plus,chevron:ChevronDown,terminal:Terminal,chat:MessageCircle,chatAdd:MessageCirclePlus,server:Server,arrow:ArrowRight,up:ArrowUp,down:ArrowDown,close:X,menu:Menu,refresh:RefreshCw,check:Check,alert:TriangleAlert,spark:Sparkles,clock:Clock,lock:Lock,link:Link,send:Send,return:CornerDownLeft,stop:Square,copy:Copy,expand:Maximize2,settings:Settings,trash:Trash2,database:Database,docker:Container,local:Monitor,redis:Database,network:Network,code:Code,chart:ChartNoAxesCombined,bug:Bug,book:BookOpen,document:FileText,box:Box,tag:Tag,tags:Tags,filter:SlidersHorizontal,panel:PanelLeft,edit:Pencil,next:ChevronRight,plug:Plug,image:Image,brain:Brain} satisfies Record<string,LucideIcon>;
const lakeWaterline='M4 19c2-1.6 4 1.6 6 0s4 1.6 6 0 3 1 4 .3';
const lakeIcons={
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
export type GlyphName = keyof typeof icons | keyof typeof lakeIcons;
export const sessionIcons = [{id:"chat",label:"对话"},{id:"document",label:"文档"},{id:"terminal",label:"终端"},{id:"server",label:"服务器"},{id:"database",label:"数据库"},{id:"network",label:"网络"},{id:"code",label:"代码"},{id:"chart",label:"图表"},{id:"bug",label:"问题"},{id:"shield",label:"安全"},{id:"book",label:"手册"},{id:"box",label:"服务"}] as const;
export function Glyph({name,size=18,className=""}:{name:string;size?:number;className?:string}) {
 const path=lakeIcons[name as keyof typeof lakeIcons];
 if(path)return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" className={className} data-glyph={name} aria-hidden="true"><path d={path}/></svg>;
 const Icon = icons[name as keyof typeof icons] ?? FileText;
 return <Icon size={size} strokeWidth={1.7} className={className} aria-hidden="true"/>;
}
export function ResourceIcon({kind,size=16}:{kind:string;size?:number}) {
 return <Glyph name={kind==="ssh"?"server":kind} size={size} className={`resource-kind-icon kind-${kind}`}/>;
}
