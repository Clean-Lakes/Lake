import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Exercise the shipped browser/native script through its resize and splitter events.
const source=readFileSync(new URL('../src/workbenchLayout.js',import.meta.url),'utf8');
const railWidth=52;
type ChromeIsland = { x:number; y:number; width:number; height:number; interactive:boolean };
function fixture(saved={sidebar:280,terminal:400,inspector:382},docked=false,sidebarDuration='420ms',railReadingLeft?:number,options?:{dockWidth?:number;chrome?:boolean;sidebarControls?:Array<{x:number;y:number;width:number;height:number;hidden?:boolean}>;chromeIsland?:ChromeIsland}){
 const properties=new Map<string,string>(),callbacks=new Map<number,(time:number)=>void>(),events=new Map<string,Function>();
 const widthSaves:Array<typeof saved>=[];
 const chromeMessages:Array<{regions:number[][];excluded:number[][]}>=[];
 let nextFrame=0;
 const style=(vars=new Map<string,string>())=>({
  setProperty:(key:string,value:string)=>vars.set(key,value),
  getPropertyValue:(key:string)=>vars.get(key)??'',
  getPropertyPriority:()=>'',removeProperty:(key:string)=>vars.delete(key),
 });
 const animations:Array<{name:string;frames:Array<{transform?:string}>;duration:number;startTime:number|null;currentTime:number|null;paused:boolean;cancelled:boolean}>=[];
 const rect=(left:number)=>({left,right:left+28,top:0,bottom:28,x:left,y:0,width:28,height:28});
 const animatedNode=(left:()=>number,name='')=>({
  style:style(),
  querySelector:()=>null,
  getBoundingClientRect:()=>rect(left()),
  animate(frames:Array<{transform?:string}>,timing:{duration:number}){
   const animation={name,frames,duration:timing.duration,startTime:null,currentTime:null,paused:false,cancelled:false,
    pause(){this.paused=true;},cancel(){this.cancelled=true;}};
   animations.push(animation);
   return animation;
  },
 });
 const sidebarWidth=()=>parseFloat(properties.get('--sidebar-width')||'280');
 const surface=animatedNode(sidebarWidth);
 const navigationStart=86;
 const titlebarButton=(name:string,index:number)=>animatedNode(()=>{
  const groupLeft=shell.sidebarCollapsed
   ?parseFloat(properties.get('--workbench-island-navigation-left')||String(navigationStart))+8
   :sidebarWidth()-125;
  return groupLeft+index*31+(!shell.sidebarCollapsed&&name==='toggle'?29:0);
 },name);
 const navigationButtons=['back','forward','toggle'].map(titlebarButton);
 const composer=railReadingLeft===undefined?null:animatedNode(()=>railReadingLeft,'composer');
 const island=composer&&animatedNode(()=>{
  const settled=(railReadingLeft??0)+(sidebarWidth()-railWidth)/2;
  return parseFloat(properties.get('--workbench-island-navigation-left')??String(settled));
 },'island');
 const handles=new Map<string,any>();
 const findHandle=(selector:string)=>{
  const match=selector.match(/^(?::scope > )?\.workbench-splitter-(sidebar|terminal|inspector)$/);
  return match?handles.get(match[1]!):null;
 };
 const makeNode=(styles=new Map<string,string>())=>({
  className:'',isConnected:true,style:style(styles),
  classList:{add(){},remove(){}},
  pointer:undefined as number|undefined,
  setPointerCapture(pointer:number){this.pointer=pointer;},
  hasPointerCapture(pointer:number){return this.pointer===pointer;},
  releasePointerCapture(){this.pointer=undefined;},
  attributes:new Map<string,string>(),setAttribute(key:string,value:string){this.attributes.set(key,value);},getAttribute(key:string){return this.attributes.get(key);},removeAttribute(key:string){this.attributes.delete(key);},
  addEventListener(type:string,callback:Function){(this as any)[type]=callback;},querySelector:findHandle,
  appendChild(node:any){handles.set(node.className.split('-').at(-1),node);},
 });
 const dockWidth=options?.dockWidth??850;
 const sidebar={...makeNode(),getBoundingClientRect:()=>({x:0,y:0,width:sidebarWidth(),height:900,left:0,top:0,right:sidebarWidth(),bottom:900})};
 const islands=makeNode(),navigation=makeNode();
 const dock={...makeNode(),getBoundingClientRect:()=>({width:dockWidth})};
 const conversation={...makeNode(),getBoundingClientRect:()=>({width:dockWidth,top:65,bottom:800}),querySelectorAll:()=>[],
  querySelector:(selector:string)=>selector===':scope > .timeline-list'?{getBoundingClientRect:()=>({width:750})}:null};
 const workspace={...makeNode(),clientWidth:1232,
  getBoundingClientRect:()=>({x:sidebarWidth(),y:0,width:1512-sidebarWidth(),height:900,left:sidebarWidth(),top:0,right:1512,bottom:900}),
  querySelector:(selector:string)=>
   selector==='.composer-input'?composer:selector==='.composer-dock'?dock:selector==='.conversation'?conversation:null,
  querySelectorAll:(selector:string)=>selector==='.timeline-list,.conversation-header-backdrop'?[]:composer?[composer]:[]};
 const sidebarControlNodes=(options?.sidebarControls??[]).map(control=>({
  getBoundingClientRect:()=>({x:control.x,y:control.y,width:control.width,height:control.height,left:control.x,top:control.y,right:control.x+control.width,bottom:control.y+control.height}),
  closest:(selector:string)=>selector==='[aria-hidden="true"]'&&control.hidden?{}:null,
 }));
 const chromeIsland={ getBoundingClientRect:()=>options?.chromeIsland, closest:()=>null };
 let islandResized:(()=>void)|undefined;
 const inspector=makeNode(),terminal=makeNode(),shell={...makeNode(properties),clientWidth:1512,inspectorOpen:!docked,terminalOpen:!docked,sidebarCollapsed:false,
 getBoundingClientRect:()=>rect(0), animate:surface.animate,
 querySelectorAll:(selector:string)=>{
  if(selector==='.workbench-navigation button'||selector==='.workbench-splitter, .workbench-navigation button')return navigationButtons;
  if(selector.startsWith('.sidebar-brand-row'))return sidebarControlNodes;
  return [];
 },
 classList:{contains:(name:string)=>name==='terminal-is-open'&&shell.terminalOpen||name==='has-collapsed-sidebar'&&shell.sidebarCollapsed||(name==='has-docked-conversation'||name==='has-workbench-conversation')&&docked},querySelector(selector:string):any{
  if(selector==='.workspace'){workspace.clientWidth=this.clientWidth-sidebarWidth();return workspace;}
  if(selector==='.conversation')return conversation;
  if(selector==='.sidebar')return sidebar;
  if(selector==='.lake-workbench-islands')return docked?islands:null;
  if(selector==='.workbench-navigation')return navigation;
  if(selector==='.island-conversation')return island;
  if(selector==='.island-conversation[data-island-interactive="true"]')return options?.chromeIsland?.interactive?chromeIsland:null;
  if(selector==='.workbench-conversation-surface')return docked?surface:null;
  if(selector==='.terminal-side-panel')return this.terminalOpen?terminal:null;
  if(selector==='.session-layout > .session-inspector'||selector==='.session-layout > .session-inspector.is-open')return this.inspectorOpen?inspector:null;
  return findHandle(selector);
 }};
 const window:any={lakeWorkbenchWidths:saved,addEventListener:(type:string,callback:Function)=>events.set(type,callback),dispatchEvent:(event:Event)=>events.get(event.type)?.(event)};
 if(options?.chrome)window.webkit={messageHandlers:{lakeChrome:{postMessage:(message:{regions:number[][];excluded:number[][]})=>{if(message.regions)chromeMessages.push(message);}}}};
 const getComputedStyle=(_node:unknown,pseudo?:string)=>({
  getPropertyValue:(name:string)=>name==='--workbench-sidebar-duration'?sidebarDuration:name==='--workbench-navigation-start'?`${navigationStart}px`:`${railWidth}px`,
  paddingInlineStart:'30px',
  visibility:'visible',
  transitionDuration:pseudo==='::before'?'0.42s':'0s',
  transitionTimingFunction:'ease',
 });
 const context={window,Event,innerWidth:1512,innerHeight:900,localStorage:{getItem(){return null;},setItem(_key:string,value:string){widthSaves.push(JSON.parse(value));}},document:{body:{},head:{appendChild(){}},documentElement:{dataset:{theme:'light'},classList:{add(){},remove(){}}},timeline:{currentTime:10},createElement:()=>makeNode(),querySelector:()=>shell,querySelectorAll:()=>[],addEventListener(){}},getComputedStyle,ResizeObserver:class{
  constructor(private readonly onResize:()=>void){}
  observe(element:unknown){if(element===chromeIsland)islandResized=this.onResize;}
  disconnect(){if(islandResized===this.onResize)islandResized=undefined;}
 },MutationObserver:class{observe(){}disconnect(){}},IntersectionObserver:class{observe(){}disconnect(){}takeRecords(){return [];}},requestAnimationFrame:(callback:(time:number)=>void)=>{callbacks.set(++nextFrame,callback);return nextFrame;},cancelAnimationFrame:(frame:number)=>callbacks.delete(frame)};
 runInNewContext(source,context);
 const flush=(time=0)=>{for(const [id,callback] of callbacks){callbacks.delete(id);callback(time);}};flush();
 return {properties,animations,flush,widthSaves,chromeMessages,conversation,surface,sidebarPane:sidebar,workspace,dock,islands,navigation,shell,
  sidebar:handles.get('sidebar') as ReturnType<typeof makeNode>,
  resizeIsland(bounds:Partial<ChromeIsland>){Object.assign(options?.chromeIsland??{},bounds);islandResized?.();flush();},
  drag(type:string,clientX:number,pointerId=1){handles.get('sidebar')[type]({type,clientX,pointerId,button:0,preventDefault(){}});},
  resize(width:number){shell.clientWidth=width;context.innerWidth=width;events.get('resize')!();flush();},reset(pane:string){handles.get(pane).dblclick();flush();},toggle(inspectorOpen:boolean,terminalOpen:boolean){shell.inspectorOpen=inspectorOpen;shell.terminalOpen=terminalOpen;events.get('resize')!();flush();},commit(inspectorOpen:boolean,terminalOpen:boolean){shell.inspectorOpen=inspectorOpen;shell.terminalOpen=terminalOpen;events.get('lake-workbench-layout')!();},collapseSidebar(collapsed:boolean){events.get('lake-workbench-sidebar-toggle')!();shell.sidebarCollapsed=collapsed;events.get('lake-workbench-layout')!();},widths(){return ['--sidebar-width','--terminal-panel-width','--inspector-preferred-width'].map(key=>parseFloat(properties.get(key)!));}};
}

test('sidebar pointer moves resize the panes on the frame and preserve the reading width until release',()=>{
 const page=fixture();
 const readingWidth=()=>page.conversation.style.getPropertyValue('--sidebar-resize-reading-width');
 page.drag('pointerdown',280);
 assert.equal(readingWidth(),'750px');
 page.drag('pointermove',315);
 page.drag('pointermove',340);
 page.drag('pointermove',380,2);
 assert.equal(page.widths()[0],280);
 page.flush();
 assert.equal(page.widths()[0],340);
 assert.equal(page.sidebar.getAttribute('aria-valuenow'),'340');
 assert.equal(readingWidth(),'750px');
 assert.ok(1512-page.widths().reduce((sum,width)=>sum+width,0)>=416);
 assert.deepEqual(page.widthSaves,[]);

 page.drag('pointermove',350);
 page.drag('pointerup',370);
 page.drag('lostpointercapture',370);
 page.flush();
 assert.equal(readingWidth(),'');
 assert.equal(page.conversation.attributes.has('data-sidebar-resizing'),false);
 assert.equal(page.widths()[0],370);
 assert.equal(page.sidebar.getAttribute('aria-valuenow'),'370');
 assert.deepEqual(page.widthSaves,[{sidebar:370,terminal:400,inspector:382}]);
});

test('two-pane pointer dragging moves the whole boundary without applying the grid before release',()=>{
 const page=fixture(undefined,true);
 page.drag('pointerdown',280);
 page.drag('pointermove',323);
 page.drag('pointermove',348);
 page.flush();
 assert.equal(page.widths()[0],280);
 assert.equal(page.shell.getAttribute('data-sidebar-resize-layer'),'');
 assert.equal(page.sidebarPane.style.getPropertyValue('inline-size'),'348px');
 assert.equal(page.surface.style.getPropertyValue('transform'),'translate3d(68px,0,0)');
 assert.equal(page.workspace.style.getPropertyValue('transform'),'translate3d(68px,0,0)');
 assert.equal(page.sidebar.getAttribute('aria-valuenow'),'348');
 assert.equal(page.dock.style.getPropertyValue('--sidebar-resize-viewport'),'782px');
 assert.deepEqual(page.widthSaves,[]);

 page.drag('pointerup',360);
 page.flush();
 assert.equal(page.widths()[0],360);
 assert.equal(page.shell.getAttribute('data-sidebar-resize-layer'),undefined);
 assert.equal(page.surface.style.getPropertyValue('transform'),'');
 assert.equal(page.conversation.style.getPropertyValue('inline-size'),'');
 assert.equal(page.widthSaves.length,1);
});

test('opening the task inspector cancels the two-pane resize and restores the pane bounds',()=>{
 const page=fixture(undefined,true);
 page.drag('pointerdown',280);
 page.drag('pointermove',218);
 page.flush();
 assert.equal(page.sidebarPane.style.getPropertyValue('inline-size'),'218px');
 page.commit(true,false);
 assert.equal(page.shell.getAttribute('data-sidebar-resize-layer'),undefined);
 assert.equal(page.sidebarPane.style.getPropertyValue('inline-size'),'');
 assert.equal(page.sidebar.getAttribute('aria-valuenow'),'280');
 assert.equal(page.sidebar.hasPointerCapture(1),false);
 assert.deepEqual(page.widthSaves,[]);
});

test('live sidebar resizing respects pane limits and restores the saved layout on cancellation',()=>{
 for(const reason of ['pointercancel','lostpointercapture','narrow viewport']){
  const page=fixture();
  page.resize(1130);
  const initial=page.widths()[0]!;
  page.drag('pointerdown',initial);
  page.drag('pointermove',0);
  page.flush();
  assert.equal(page.widths()[0],200);
  assert.ok(1130-page.widths().reduce((sum,width)=>sum+width,0)>=416);
  if(reason==='narrow viewport'){
   page.resize(700);
   page.resize(1130);
  }else page.drag(reason,0);
  assert.equal(page.conversation.style.getPropertyValue('--sidebar-resize-reading-width'),'');
  assert.equal(page.conversation.attributes.has('data-sidebar-resizing'),false);
  assert.equal(page.sidebar.hasPointerCapture(1),false);
  assert.equal(page.widths()[0],initial);
  assert.deepEqual(page.widthSaves,[]);
 }
});

test('window zoom reserves conversation space once across both auxiliary panes',()=>{
 for(const saved of [{sidebar:280,terminal:400,inspector:382},{sidebar:420,terminal:900,inspector:900}]){
  const page=fixture(saved);
  for(const width of [1101,1130,1200,1512,1920]){
   page.resize(width);
   const [sidebar,terminal,inspector]=page.widths();
   assert.ok(width-sidebar!-terminal!-inspector!>=416,`${width}: ${page.widths()}`);
   assert.ok(terminal!>=240&&inspector!>=240);
  }
 }
});
test('double-click reset stays within the narrow budget and enlarging restores preferred widths',()=>{
 const page=fixture();page.resize(1130);
 for(const pane of ['sidebar','inspector','terminal']){page.reset(pane);assert.ok(1130-page.widths().reduce((sum,width)=>sum+width,0)>=416);}
 page.resize(1920);assert.deepEqual(page.widths(),[280,400,382]);
});
test('closing a side pane returns its reserved width to the conversation',()=>{
 const page=fixture();page.resize(1130);page.toggle(false,true);
 assert.deepEqual(page.widths().slice(0,2),[280,400]);
 page.toggle(true,false);assert.equal(page.widths()[2],382);
});
test('pane toggles apply the full shared budget synchronously before the first paint',()=>{
 const page=fixture();page.resize(1232);page.toggle(true,false);
 page.commit(true,true); // Deliberately do not flush animation frames.
 assert.deepEqual(page.widths(),[280,296,240]);
 page.commit(true,false);
 assert.equal(page.widths()[0],280);assert.equal(page.widths()[2],382);
 page.commit(false,true);
 assert.deepEqual(page.widths(),[280,400,280]);
});

test('the inspector fits beside the conversation at desktop widths below the terminal threshold',()=>{
 const page=fixture({sidebar:348,terminal:400,inspector:382});
 for(const width of [960,1063,1100]){
  page.commit(false,false);
  page.resize(width);
  assert.equal(page.widths()[0],348);
  page.commit(true,false);
  const [sidebar,,inspector]=page.widths();
  assert.ok(inspector!>=280);
  assert.ok(width-sidebar!-inspector!>=416);
 }
});

test('collapsing to the icon rail returns width to the workbench and preserves the preferred sidebar width',()=>{
 const page=fixture({sidebar:304,terminal:400,inspector:382});
 page.resize(1232);
 const expanded=page.widths();
 page.collapseSidebar(true);
 assert.deepEqual(page.widths(),[railWidth,400,364]);
 assert.equal(page.properties.get('--sidebar-expanded-width'),`${expanded[0]}px`);
 page.collapseSidebar(false);
 assert.deepEqual(page.widths(),expanded);
});

test('the docked reading width follows the window and is independent of sidebar collapse',()=>{
 const page=fixture({sidebar:304,terminal:400,inspector:382});
 page.toggle(false,false);
 page.resize(903);
 assert.equal(page.properties.get('--expanded-conversation-width'),'599px');
 page.collapseSidebar(true);
 assert.equal(page.properties.get('--expanded-conversation-width'),'599px');
 page.resize(1000);
 assert.equal(page.properties.get('--expanded-conversation-width'),'696px');
 page.collapseSidebar(false);
 assert.equal(page.properties.get('--expanded-conversation-width'),'696px');
});

test('the docked island and composer share their left edge throughout both slide directions',()=>{
 const page=fixture({sidebar:304,terminal:400,inspector:382},true,'420ms',298);
 const transforms=(name:string)=>Array.from(page.animations.findLast(animation=>animation.name===name)!.frames,frame=>frame.transform);
 page.collapseSidebar(true);
 assert.equal(page.properties.get('--workbench-island-navigation-left'),'298px');
 assert.deepEqual(transforms('island'),transforms('composer'));
 page.flush();
 page.collapseSidebar(false);
 assert.equal(page.properties.get('--workbench-island-navigation-left'),'424px');
 assert.deepEqual(transforms('island'),['translate3d(-126px,0px,0)','translate3d(0px,0,0)']);
 assert.deepEqual(transforms('composer'),['translate3d(0px,0px,0)','translate3d(126px,0,0)']);
});

test('the collapsed island and its controls clear the native window buttons',()=>{
 const page=fixture(undefined,true,'420ms',65);
 page.collapseSidebar(true);
 assert.equal(page.properties.get('--workbench-island-navigation-left'),'86px');
});

test('the sidebar, history and toggle start together on the first frame even after a long input task',()=>{
 const page=fixture(undefined,true);
 page.collapseSidebar(true);
 assert.deepEqual(page.animations.slice(1).map(animation=>animation.name),['back','forward','toggle']);
 for(const animation of page.animations){
  assert.equal(animation.startTime,null);
  assert.equal(animation.currentTime,0);
  assert.equal(animation.paused,true);
 }
 page.flush(550);
 assert.deepEqual(page.animations.map(animation=>animation.startTime),[550,550,550,550]);
});

test('reversing before the first frame does not start the cancelled slide',()=>{
 const page=fixture(undefined,true);
 page.collapseSidebar(true);
 const cancelled=page.animations.slice();
 page.collapseSidebar(false);
 page.flush(550);
 assert.ok(cancelled.every(animation=>animation.cancelled&&animation.startTime===null));
});

test('both sidebar directions keep the CSS duration when the desktop stylesheet is minified',()=>{
 for(const token of ['420ms','.42s']){
  const page=fixture(undefined,true,token);
  for(const collapsed of [true,false]){
   const first=page.animations.length;
   page.collapseSidebar(collapsed);
   page.flush();
   assert.deepEqual(page.animations.slice(first).map(animation=>animation.duration),[420,420,420,420],token);
  }
 }
});

test('two-pane sidebar dragging keeps the navigation controls on the project titlebar',()=>{
 const page=fixture(undefined,true,'420ms',undefined,{dockWidth:1200});
 page.drag('pointerdown',280);
 page.drag('pointermove',348);
 page.flush();
 assert.equal(page.surface.style.getPropertyValue('transform'),'translate3d(68px,0,0)');
 assert.equal(page.islands.style.getPropertyValue('transform'),'translate3d(34px,0,0)');
 assert.equal(page.navigation.style.getPropertyValue('transform'),'translate3d(68px,0,0)');

 page.drag('pointerup',348);
 page.flush();
 assert.equal(page.islands.style.getPropertyValue('transform'),'');
 assert.equal(page.navigation.style.getPropertyValue('transform'),'');
});

test('native titlebar chrome excludes visible merged sidebar brand controls from drag regions',()=>{
 const page=fixture(undefined,true,'420ms',undefined,{
  chrome:true,
  sidebarControls:[
   {x:80,y:11,width:72,height:30},
   {x:216,y:12,width:28,height:28},
   {x:10,y:11,width:134,height:30,hidden:true},
  ],
 });
 const chrome=page.chromeMessages.at(-1);
 assert.ok(chrome);
 assert.ok(chrome.excluded.some(rect=>rect[0]===80&&rect[1]===11&&rect[2]===72&&rect[3]===30));
 assert.ok(chrome.excluded.some(rect=>rect[0]===216&&rect[1]===12&&rect[2]===28&&rect[3]===28));
 assert.ok(chrome.excluded.some(rect=>rect[0]===246&&rect[2]===28&&rect[3]===28));
 assert.ok(chrome.excluded.some(rect=>rect[0]===155&&rect[2]===28&&rect[3]===28));
 assert.ok(chrome.excluded.some(rect=>rect[0]===186&&rect[2]===28&&rect[3]===28));
 assert.equal(chrome.excluded.some(rect=>rect[0]===10&&rect[1]===11&&rect[2]===134&&rect[3]===30),false);
});

test('native titlebar leaves the interactive island clickable as its running status changes the bounds',()=>{
 const page=fixture(undefined,true,'420ms',undefined,{chrome:true,
  chromeIsland:{x:760,y:12,width:180,height:44,interactive:true},
 });
 const contains=(rect:number[],x:number,y:number)=>x>=rect[0]!&&x<rect[0]!+rect[2]!&&y>=rect[1]!&&y<rect[1]!+rect[3]!;
 const isDraggable=(x:number,y:number)=>{
  const {regions,excluded}=page.chromeMessages.at(-1)!;
  return regions.some(rect=>contains(rect,x,y))&&!excluded.some(rect=>contains(rect,x,y));
 };
 assert.equal(isDraggable(800,34),false,'compact title and status receive clicks');
 assert.equal(isDraggable(955,34),true,'the titlebar beside the compact island remains draggable');

 page.resizeIsland({x:730,width:240});
 assert.equal(isDraggable(955,34),false,'the running timer can receive clicks after the compact island widens');
 assert.equal(isDraggable(985,34),true,'drag space follows the new bounds');

 page.resizeIsland({interactive:false});
 page.commit(false,false);
 assert.equal(isDraggable(955,34),true,'noninteractive islands do not claim titlebar drag space');
});
