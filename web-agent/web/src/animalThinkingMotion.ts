import type {LakeAvatarName} from './lakeAvatarCatalog';
import {lakeAvatarThinking,thinkingPoseOffsets} from './lakeAvatarThinking';

export type AnimalThinkingMotion={setPaused:(paused:boolean)=>void;setReducedMotion:(reduced:boolean)=>void;dispose:()=>void};
type MotionNode=SVGElement&{style:CSSStyleDeclaration};

function transform(value:string){
 const translation=/t(-?[\d.]+),(-?[\d.]+)/.exec(value),rotation=/r(-?[\d.]+)/.exec(value),scale=/s([\d.]+),([\d.]+)/.exec(value),parts:string[]=[];
 if(translation)parts.push(`translate(${translation[1]}px,${translation[2]}px)`);
 if(rotation)parts.push(`rotate(${rotation[1]}deg)`);
 if(scale)parts.push(`scale(${scale[1]},${scale[2]})`);
 return parts.join(' ')||'translate(0,0)';
}

/** Own only this character's animations, so activity and visibility retain phase. */
export function createAnimalThinkingMotion(root:ParentNode,role:LakeAvatarName,{paused=false,reducedMotion=false,phase=0}:{paused?:boolean;reducedMotion?:boolean;phase?:number}={}):AnimalThinkingMotion{
 const definition=lakeAvatarThinking[role],tracks:{node:MotionNode;frames:Keyframe[];original:string}[]=[];
 let animations:Animation[]=[],reduced=reducedMotion,stopped=paused,disposed=false;
 for(const[channel,poses]of Object.entries(definition.poses)){
  const node=root.querySelector<MotionNode>(`.avatar-${channel}`);
  if(!node||!poses)continue;
  tracks.push({node,original:node.style.transform,frames:poses.map((pose,index)=>({offset:thinkingPoseOffsets[index],transform:transform(pose),easing:'ease-in-out'}))});
 }
 for(const node of root.querySelectorAll<MotionNode>('.avatar-eye'))tracks.push({node,original:node.style.transform,frames:[{offset:0,transform:'scaleY(1)'},{offset:.66,transform:'scaleY(1)'},{offset:.68,transform:'scaleY(.15)'},{offset:.71,transform:'scaleY(1)'},{offset:1,transform:'scaleY(1)'}]});
 const rest=()=>tracks.forEach(({node,frames})=>{node.style.transform=String(frames[0].transform);});
 const cancel=()=>{animations.forEach(animation=>animation.cancel());animations=[];};
 const start=()=>{
  rest();if(disposed||reduced)return;
  for(const{node,frames}of tracks){
   if(typeof node.animate!=='function')continue;
   const animation=node.animate(frames,{duration:definition.durationMs,iterations:Infinity,easing:'linear'});
   animation.currentTime=((-phase%definition.durationMs)+definition.durationMs)%definition.durationMs;
   if(stopped)animation.pause();
   animations.push(animation);
  }
 };
 start();
 return {
  setPaused(value){if(disposed||stopped===value)return;stopped=value;animations.forEach(animation=>value?animation.pause():animation.play());},
  setReducedMotion(value){if(disposed||reduced===value)return;reduced=value;cancel();start();},
  dispose(){if(disposed)return;disposed=true;cancel();tracks.forEach(({node,original})=>{node.style.transform=original;});},
 };
}
