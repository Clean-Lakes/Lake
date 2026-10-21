import {useEffect, useState} from 'react';
import {Glyph} from './Icons';

// Purely visual; the existing turn metadata remains the single spoken status.
// Retain the mark briefly on exit so a completed packet doesn't cut it off.
export function ReplyActivity({active}: {active: boolean}) {
  const [visible, setVisible] = useState(active);
  useEffect(() => {
    if (active) { setVisible(true); return; }
    if (!visible) return;
    const timer = setTimeout(() => setVisible(false), 180);
    return () => clearTimeout(timer);
  }, [active, visible]);
  if (!active && !visible) return null;
  return <div className={`reply-activity${active ? '' : ' is-leaving'}`} aria-hidden="true">
    <span className="reply-activity-clip"><span className="reply-activity-breath"><Glyph name="lakeActivity" size={20}/></span></span>
  </div>;
}
