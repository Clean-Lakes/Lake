import { Waves, GripVertical, Ellipsis, Search, Layers, Folder, ShieldCheck, Plus, ChevronDown, Terminal, MessageCircle, MessageCirclePlus, Server, ArrowRight, ArrowUp, ArrowDown, X, Menu, RefreshCw, Check, TriangleAlert, Sparkles, Clock, Lock, Link, Send, CornerDownLeft, Square, Copy, Maximize2, Settings, Trash2, Database, Container, Monitor, Network, Code, ChartNoAxesCombined, Bug, BookOpen, FileText, Box, Tag, Tags, SlidersHorizontal, PanelLeft, Pencil, ChevronRight, Plug, Image, Brain, type LucideIcon } from "lucide-react";

const icons = {waves:Waves,grip:GripVertical,more:Ellipsis,search:Search,layers:Layers,folder:Folder,shield:ShieldCheck,plus:Plus,chevron:ChevronDown,terminal:Terminal,chat:MessageCircle,chatAdd:MessageCirclePlus,server:Server,arrow:ArrowRight,up:ArrowUp,down:ArrowDown,close:X,menu:Menu,refresh:RefreshCw,check:Check,alert:TriangleAlert,spark:Sparkles,clock:Clock,lock:Lock,link:Link,send:Send,return:CornerDownLeft,stop:Square,copy:Copy,expand:Maximize2,settings:Settings,trash:Trash2,database:Database,docker:Container,local:Monitor,redis:Database,network:Network,code:Code,chart:ChartNoAxesCombined,bug:Bug,book:BookOpen,document:FileText,box:Box,tag:Tag,tags:Tags,filter:SlidersHorizontal,panel:PanelLeft,edit:Pencil,next:ChevronRight,plug:Plug,image:Image,brain:Brain} satisfies Record<string,LucideIcon>;
export type GlyphName = keyof typeof icons | 'lakeConfirm';
export const sessionIcons = [{id:"chat",label:"对话"},{id:"document",label:"文档"},{id:"terminal",label:"终端"},{id:"server",label:"服务器"},{id:"database",label:"数据库"},{id:"network",label:"网络"},{id:"code",label:"代码"},{id:"chart",label:"图表"},{id:"bug",label:"问题"},{id:"shield",label:"安全"},{id:"book",label:"手册"},{id:"box",label:"服务"}] as const;
export function Glyph({name,size=18,className=""}:{name:string;size?:number;className?:string}) {
 if(name==='lakeConfirm')return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d="m8 7.5 2.5 2.5 5-5M4 14.1c2-2 4 2 6 0s4 2 6 0 3 1.4 4 .5M4 18.1c2-2 4 2 6 0s4 2 6 0 3 1.4 4 .5"/></svg>;
 const Icon = icons[name as keyof typeof icons] ?? FileText;
 return <Icon size={size} strokeWidth={1.7} className={className} aria-hidden="true"/>;
}
export function ResourceIcon({kind,size=16}:{kind:string;size?:number}) {
 return <Glyph name={kind==="ssh"?"server":kind} size={size} className={`resource-kind-icon kind-${kind}`}/>;
}
