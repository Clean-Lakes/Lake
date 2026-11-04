type Frames={request:(callback:FrameRequestCallback)=>number;cancel:(id:number)=>void};

// Historical content is placed before it becomes visible. Streaming updates
// use the ordinary follower after this entrance, never replay the whole scroll.
export function prepareSessionEntrance(settle:()=>void,reveal:()=>void,frames:Frames={request:callback=>requestAnimationFrame(callback),cancel:id=>cancelAnimationFrame(id)}){
 let second:number|undefined;
 settle();
 const first=frames.request(()=>{settle();second=frames.request(()=>{settle();reveal();});});
 return()=>{frames.cancel(first);if(second!==undefined)frames.cancel(second);};
}
