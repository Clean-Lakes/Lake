export type IslandRail={left:number;width:number;inset?:number};
export type IslandPosition={left:number;width:number};

/** Each island gets only its own pane's space; siblings never share a width budget. */
export function workbenchIslandLayout({conversation,inspector,terminal,conversationWidth,inspectorWidth,terminalWidth}:{conversation:IslandRail;inspector?:IslandRail;terminal?:IslandRail;conversationWidth:number;inspectorWidth:number;terminalWidth:number}){
 const place=(rail:IslandRail,width:number):IslandPosition=>{
  const inset=rail.inset??16;
  return {left:rail.left+inset,width:Math.max(1,Math.min(width,rail.width-inset*2))};
 };
 return {conversation:place(conversation,conversationWidth),inspector:inspector?place(inspector,inspectorWidth):undefined,terminal:terminal?place(terminal,terminalWidth):undefined};
}
