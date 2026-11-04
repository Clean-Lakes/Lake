import {usePageVisible} from './usePageVisible';

/** Three fishing floats share the lake; the caller supplies the live status label. */
export function ThinkingBuoys() {
 const visible=usePageVisible();
 return <span className="thinking-buoys" data-hidden={!visible||undefined} aria-hidden="true"><span className="thinking-buoys-pond"/>{[0,1,2].map(index=><span className="thinking-buoys-float" key={index}><i className="thinking-buoys-ring"/><i className="thinking-buoys-ring thinking-buoys-ring-outer"/><span className="thinking-buoys-above"><i className="thinking-buoys-body"><b/></i></span><i className="thinking-buoys-reflection"/></span>)}</span>;
}
