/** Account for the outer hairline so each section starts on its pane boundary. */
export function workbenchIslandLayout(conversationWidth:number,inspectorWidth:number,terminalWidth:number){
 const width=Math.max(120,conversationWidth+inspectorWidth+terminalWidth-16);
 return {width,columns:[Math.max(0,conversationWidth-1),Math.max(0,inspectorWidth-(terminalWidth?0:17)),Math.max(0,terminalWidth-17)]};
}
