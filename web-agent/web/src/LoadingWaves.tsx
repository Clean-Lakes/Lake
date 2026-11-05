import {Glyph} from './Icons';
import {usePageVisible} from './usePageVisible';

/** The original Lake water-surface motion, shared by model and channel waits. */
export function LoadingWaves() {
 const visible=usePageVisible();
 return <span className="turn-status-mark" data-hidden={!visible||undefined} aria-hidden="true"><Glyph name="waves" size={18} className="reply-duration-spinner turn-activity-mark"/></span>;
}
