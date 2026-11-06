import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Resource } from "../../shared/contracts";
import { Glyph } from "./Icons";
import { api, readableError } from "./api";
import { ServiceResourceFields } from "./ServiceResourceFields";
import {
  serviceResourceType,
  serviceDraftFromResource,
  serviceResourceInput,
} from "./serviceResourceModel";

export function ServiceConfigEdit({
  resource,
  connected,
  onClose,
  onSaved,
}: {
  resource: Resource;
  connected: boolean;
  onClose: () => void;
  onSaved: (resource: Resource) => void;
}) {
  const [name, setName] = useState(resource.name),
    [draft, setDraft] = useState(() => serviceDraftFromResource(resource));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null),
    type = serviceResourceType(resource);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  if (!type) return null;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!type || busy || !connected || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const config = serviceResourceInput(type, draft);
      const next = await api.editServiceResource(resource.id, {
        name: name.trim(),
        settings: config.settings,
      });
      onSaved(next);
      onClose();
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="modal terminal-config-dialog resource-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="service-config-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Tab") {
            const nodes = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),[tabindex="0"]',
              ),
            ].filter(
              (n) =>
                n.getClientRects().length && !n.closest("fieldset:disabled"),
            );
            const first = nodes[0],
              last = nodes.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="modal-header">
          <span className="modal-icon">
            <Glyph name="server" size={20} />
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭资源配置编辑"
            disabled={busy}
            onClick={onClose}
          >
            <Glyph name="close" size={14} />
          </button>
        </div>
        <h2 id="service-config-title">编辑资源配置</h2>
        <p className="modal-description">
          已有凭据不会回显，留空保留。保存不会自动连接服务。
        </p>
        <form onSubmit={save}>
          <label className="field-label">
            名称
            <input
              ref={input}
              required
              maxLength={160}
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <ServiceResourceFields
            type={type}
            value={draft}
            onChange={setDraft}
            disabled={busy}
            projectId={resource.projectId}
            existing={resource}
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={busy || !connected || !name.trim()}
            >
              {busy ? "正在保存…" : "保存配置"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
