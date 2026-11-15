/** Keep keyboard focus when one reply entry moves between the bubble and header. */
export function createReplyIdentityFocus(){
 let current:{owner:string;node:HTMLButtonElement}|undefined;
 let detached:typeof current;
 return {
  setButton(owner:string,node:HTMLButtonElement|null){
   if(node){current={owner,node};return;}
   if(current?.owner!==owner)return;
   // Ref cleanup precedes DOM removal, while the old button can still own focus.
   detached=current.node.ownerDocument.activeElement===current.node?current:undefined;
   current=undefined;
  },
  finishCommit(owner:string){
   const previous=detached;detached=undefined;
   if(!previous||previous.owner!==owner||current?.owner!==owner)return;
   const node=current.node,document=node.ownerDocument;
   // Never redirect focus moved to another control, reused DOM, or another task.
   if(node!==previous.node&&node.isConnected&&document===previous.node.ownerDocument&&document.activeElement===document.body)node.focus({preventScroll:true});
  },
 };
}
