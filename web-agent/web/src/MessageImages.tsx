import {useEffect,useRef,useState} from 'react';
import type {AIImage} from '../../shared/contracts';
import {Glyph} from './Icons';
const source=(image:AIImage)=>image.url||`data:${image.mimeType};base64,${image.base64}`;
function ImagePreview({image,onClose}:{image:AIImage;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null,node=dialog.current;node?.showModal();return()=>{node?.close();if(previous?.isConnected)previous.focus({preventScroll:true})}},[]);
 return <dialog ref={dialog} className="message-image-preview" aria-label={`图片预览：${image.name||'图片'}`} onCancel={event=>{event.preventDefault();onClose()}} onClick={event=>{if(event.target===event.currentTarget)onClose()}}><header><span>{image.name||'图片'}</span><button type="button" className="icon-button" aria-label="关闭图片预览" onClick={onClose}><Glyph name="close" size={18}/></button></header><img src={source(image)} alt={image.name||'图片原图'} width={image.width>0?image.width:undefined} height={image.height>0?image.height:undefined}/></dialog>;
}
export function MessageImages({images}:{images:AIImage[]}){
 const [selected,setSelected]=useState<string|null>(null);
 const preview=images.find(image=>image.id===selected);
 return <><div className="message-images" aria-label="消息图片">{images.map(image=><figure key={image.id} className="ai-image"><button type="button" className="message-image-open" aria-label={`查看图片：${image.name||'图片'}`} onClick={()=>setSelected(image.id)}><img src={source(image)} alt={image.name||'用户附加图片'} width={image.width>0?image.width:undefined} height={image.height>0?image.height:undefined} loading="lazy" decoding="async"/></button></figure>)}</div>{preview&&<ImagePreview key={preview.id} image={preview} onClose={()=>setSelected(null)}/>}</>;
}
