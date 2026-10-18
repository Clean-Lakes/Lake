type Position = {clientX:number;clientY:number};
type Down = Position & {button:number;preventDefault:()=>void};
/** Keep clicks in the webview; hand a real drag over only after movement starts. */
export function windowGestures(eligible:(event:Down)=>boolean,command:(action:"drag"|"maximize")=>void) {
  let start:Position|null=null;
  return {
    down(event:Down) {start=null;if(event.button!==0||!eligible(event))return;event.preventDefault();start={clientX:event.clientX,clientY:event.clientY};},
    move(event:Position) {if(!start||Math.hypot(event.clientX-start.clientX,event.clientY-start.clientY)<4)return;start=null;command("drag");},
    cancel() {start=null;},
    doubleClick(event:Down) {start=null;if(event.button!==0||!eligible(event))return;event.preventDefault();command("maximize");},
  };
}
