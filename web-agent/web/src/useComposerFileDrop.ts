import {useCallback, useEffect, useRef, useState, type DragEvent} from 'react';
import {clipboardFiles, hasFileTransfer} from './fileAttachments';

/** Keep the composer highlighted across dragenter/dragleave pairs from descendants. */
export function useComposerFileDrop(sessionId:string|null, enabled:boolean, onFiles:(files:File[])=>void) {
 const depth=useRef(0);
 const [dragging,setDragging]=useState(false);
 const reset=useCallback(()=>{depth.current=0;setDragging(false);},[]);
 useEffect(()=>{
  reset();
  window.addEventListener('dragend',reset);
  window.addEventListener('drop',reset);
  window.addEventListener('blur',reset);
  return()=>{
   window.removeEventListener('dragend',reset);
   window.removeEventListener('drop',reset);
   window.removeEventListener('blur',reset);
  };
 },[enabled,sessionId,reset]);

 return {dragging:enabled&&dragging,dropEvents:{
  onDragEnter(event:DragEvent<HTMLElement>){
   if(!hasFileTransfer(event.dataTransfer))return;
   event.preventDefault();
   if(enabled){depth.current++;setDragging(true);}
  },
  onDragOver(event:DragEvent<HTMLElement>){
   if(!hasFileTransfer(event.dataTransfer))return;
   event.preventDefault();
   event.dataTransfer.dropEffect=enabled?'copy':'none';
   if(enabled)setDragging(true);
  },
  onDragLeave(event:DragEvent<HTMLElement>){
   depth.current=Math.max(0,depth.current-1);
   if(event.relatedTarget instanceof Node){
    if(!event.currentTarget.contains(event.relatedTarget))reset();
   }else if(!depth.current)reset();
  },
  onDrop(event:DragEvent<HTMLElement>){
   if(!hasFileTransfer(event.dataTransfer))return;
   event.preventDefault();
   event.stopPropagation();
   reset();
   if(enabled)onFiles(clipboardFiles(event.dataTransfer));
  },
 }};
}
