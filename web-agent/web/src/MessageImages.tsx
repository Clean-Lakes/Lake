import {useLayoutEffect,useRef,useState} from 'react';
import type {AIImage} from '../../shared/contracts';
import {Glyph} from './Icons';
import {canAnimateControls,controlMotionEase} from './controlMotion';

const source=(image:AIImage)=>image.url||`data:${image.mimeType};base64,${image.base64}`;

function thumbnailBounds(trigger:HTMLButtonElement) {
  const bounds=trigger.querySelector("img")?.getBoundingClientRect();
  return bounds&&bounds.width>0&&bounds.height>0
    &&bounds.right>0&&bounds.bottom>0&&bounds.left<window.innerWidth&&bounds.top<window.innerHeight
    ?bounds:null;
}

function imageTransform(frame:DOMRect,target:DOMRect) {
  return `translate(${target.x-frame.x}px,${target.y-frame.y}px) scale(${target.width/frame.width},${target.height/frame.height})`;
}

function ImagePreview({image,trigger,onClose}:{image:AIImage;trigger:HTMLButtonElement;onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null);
  const picture=useRef<HTMLImageElement>(null);
  const motion=useRef<Animation|null>(null);
  const closing=useRef(false);

  useLayoutEffect(()=>{
    const node=dialog.current,preview=picture.current;
    if(!node||!preview)return;
    node.showModal();
    const from=thumbnailBounds(trigger),to=preview.getBoundingClientRect();
    if(from&&to.width>0&&to.height>0&&preview.animate&&canAnimateControls()){
      node.dataset.imageMoving="true";
      const animation=preview.animate([{transform:imageTransform(to,from)},{transform:"none"}],
        {duration:210,easing:controlMotionEase});
      motion.current=animation;
      void animation.finished.then(()=>{if(!closing.current)delete node.dataset.imageMoving;},()=>{});
    }
    return()=>{
      motion.current?.cancel();
      motion.current=null;
      node.close();
      if(trigger.isConnected)trigger.focus({preventScroll:true});
    };
  },[trigger]);

  function close(){
    if(closing.current)return;
    const node=dialog.current,preview=picture.current,to=thumbnailBounds(trigger);
    if(!node||!preview||!to||!preview.animate||!canAnimateControls()){onClose();return;}
    const current=preview.getBoundingClientRect();
    motion.current?.cancel();
    const frame=preview.getBoundingClientRect();
    if(frame.width<=0||frame.height<=0){onClose();return;}
    closing.current=true;
    node.dataset.imageMoving="true";
    node.dataset.imageClosing="true";
    const animation=preview.animate([{transform:imageTransform(frame,current)},{transform:imageTransform(frame,to)}],
      {duration:160,easing:controlMotionEase,fill:"forwards"});
    motion.current=animation;
    void animation.finished.then(onClose,()=>{});
  }

  return <dialog ref={dialog} className="message-image-preview" aria-label={`图片预览：${image.name||'图片'}`}
    onCancel={event=>{event.preventDefault();close();}} onClick={event=>{if(event.target===event.currentTarget)close();}}>
    <header><span>{image.name||'图片'}</span><button type="button" className="icon-button" aria-label="关闭图片预览" onClick={close}><Glyph name="close" size={18}/></button></header>
    <img ref={picture} src={source(image)} alt={image.name||'图片原图'} width={image.width>0?image.width:undefined} height={image.height>0?image.height:undefined}/>
  </dialog>;
}

export function MessageImages({images}:{images:AIImage[]}){
  const [selected,setSelected]=useState<{id:string;trigger:HTMLButtonElement}|null>(null);
  const preview=images.find(image=>image.id===selected?.id);
  return <>
    <div className="message-images" aria-label="消息图片">{images.map(image=><figure key={image.id} className="ai-image">
      <button type="button" className="message-image-open" aria-label={`查看图片：${image.name||'图片'}`}
        onClick={event=>setSelected({id:image.id,trigger:event.currentTarget})}>
        <img src={source(image)} alt={image.name||'用户附加图片'} width={image.width>0?image.width:undefined} height={image.height>0?image.height:undefined} loading="lazy" decoding="async"/>
      </button>
    </figure>)}</div>
    {preview&&selected&&<ImagePreview key={preview.id} image={preview} trigger={selected.trigger} onClose={()=>setSelected(null)}/>}
  </>;
}
