import {Glyph} from './Icons';
import {useEffect, useRef, useState, type FormEvent} from "react";
import type {WorkSession} from "../../shared/contracts";
import {api, readableError} from "./api";

export function SessionEdit({session, connected, onClose, onSaved}: {
  session: WorkSession; connected: boolean; onClose: () => void; onSaved: (session: WorkSession) => void;
}) {
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus(); input.current?.select();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !connected || !title.trim()) return;
    setBusy(true); setError("");
    try {
      const saved = await api.renameSession(session.id, title.trim());
      onSaved(saved); onClose();
    } catch (error) { setError(readableError(error)); }
    finally { setBusy(false); }
  }
  return <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-session-title" onKeyDown={event => {
      if (event.key === "Escape" && !busy) {event.preventDefault(); event.stopPropagation(); onClose();}
      if (event.key === "Tab") {
        const fields = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
        const first = fields[0], last = fields.at(-1);
        if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
        if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
      }
    }}>
      <div className="modal-header"><span className="modal-icon"><Glyph name="edit" size={20}/></span><button type="button" className="icon-button" aria-label="关闭编辑会话" disabled={busy} onClick={onClose}><Glyph name="close" size={14}/></button></div>
      <h2 id="edit-session-title">编辑会话</h2>
      <form onSubmit={event => void save(event)}>
        <label className="field-label">会话名称<input ref={input} value={title} maxLength={200} required autoComplete="off" disabled={busy} onChange={event => setTitle(event.target.value)}/></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={busy || !connected || !title.trim()}>{busy ? "正在保存…" : "保存名称"}</button></div>
      </form>
    </section>
  </div>;
}
