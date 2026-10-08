import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TerminalController } from "./terminal-controller";
const controller = new TerminalController();
export function TerminalPanel({
  terminals,
  onChanged,
  onError,
}: {
  terminals: Record<string, any>[];
  onChanged: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [selected, setSelected] = useState(""),
    [epoch, setEpoch] = useState<number | null>(null);
  const container = useRef<HTMLDivElement>(null),
    current = useRef<Record<string, any> | undefined>(undefined),
    lease = useRef(epoch);
  const active = terminals.find((t) => t.id === selected) ?? terminals[0];
  useEffect(() => {
    if (active?.mode !== "interactive" || active?.inputEpoch !== epoch)
      setEpoch(null);
  }, [active?.mode, active?.inputEpoch]);
  current.current = active;
  lease.current = epoch;
  useEffect(() => {
    if (!container.current || !active) return;
    const term = new Terminal({
      theme: { background: "#102330", foreground: "#d8e4ec" },
      fontSize: 12,
      convertEol: true,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current);
    fit.fit();
    let cursor = "0",
      stopped = false,
      inputQueue = Promise.resolve();
    const data = term.onData((text) => {
      if (lease.current === null || !current.current) return;
      const t = current.current;
      inputQueue = inputQueue
        .then(() => controller.sendInput(t, text, lease.current!))
        .catch(onError);
    });
    const poll = async () => {
      while (!stopped) {
        try {
          for (const chunk of await controller.subscribe(active.id, cursor)) {
            const output = String(chunk.text).replace(
              /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g,
              "",
            );
            term.write(output);
            cursor = chunk.cursor;
          }
        } catch (error) {
          if (!stopped) onError(error);
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    };
    void poll();
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(container.current);
    return () => {
      stopped = true;
      data.dispose();
      observer.disconnect();
      term.dispose();
    };
  }, [active?.id]);
  return (
    <section className="terminals">
      <div className="terminal-tabs">
        {terminals.map((t) => (
          <button
            key={t.id}
            className={active?.id === t.id ? "selected" : ""}
            onClick={() => {
              setSelected(t.id);
              setEpoch(null);
            }}
          >
            {t.powerId} · {String(t.id).slice(0, 6)}
          </button>
        ))}
        {active && (
          <span>
            {active.status} · 输入 {active.inputHolder ?? "空闲"}
          </span>
        )}
        <div className="spacer" />
        {active && active.powerId === "ssh" && (
          <>
            {active.mode !== "interactive" ? (
              <button
                onClick={async () => {
                  try {
                    setEpoch(await controller.requestControl(active));
                    await onChanged();
                  } catch (error) {
                    onError(error);
                  }
                }}
              >
                接管 SSH 终端
              </button>
            ) : (
              <button
                onClick={async () => {
                  try {
                    await controller.release(active);
                    setEpoch(null);
                    await onChanged();
                  } catch (error) {
                    onError(error);
                  }
                }}
              >
                确认手工操作已停止，交还
              </button>
            )}
          </>
        )}
      </div>
      {active?.controlExpiredAt && (
        <p className="notice">
          人工控制已过期，SSH
          已关闭。确认远端手工操作已停止后交还；资源写锁继续保留。
        </p>
      )}
      <div ref={container} className="terminal-screen" />
      {!active && <p className="muted">专员创建的终端将在这里共享。</p>}
    </section>
  );
}
