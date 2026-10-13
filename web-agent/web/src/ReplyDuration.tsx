import {useEffect,useState} from "react";
import {ActivityIndicator} from "./ActivityIndicator";
import {StatusText} from "./StatusText";
import type {ReplyTiming} from "../../shared/contracts";
import {replyDurationText} from "./replyDurationState";

export function ReplyDuration({timing,waiting=false}: {timing?:ReplyTiming;waiting?:boolean}) {
 const [now,setNow]=useState(Date.now);
 const live=timing?.status==="running";
 useEffect(() => {
  setNow(Date.now());
  if (!live) return;
  const timer=window.setInterval(() => setNow(Date.now()),1000);
  return () => window.clearInterval(timer);
 },[timing?.messageId,timing?.startedAt,live]);
 const label=timing && replyDurationText(timing,now,waiting);
 if (!label) return null;
 return <div className={`reply-duration ${live ? "is-live" : "is-finished"}`} aria-label="回答耗时" title="从本轮开始处理到结束的总耗时，包含等待确认，不包含排队等待">{live && !waiting ? <ActivityIndicator className="reply-duration-spinner"/> : <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>}<StatusText text={label} active={live && !waiting} className="reply-duration-label"/></div>;
}
