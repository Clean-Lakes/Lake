import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
export function startPty(args: string[], executable = process.execPath) {
  const bridge = spawn(
    "python3",
    [
      "-B",
      new URL("./pty-bridge.py", import.meta.url).pathname,
      executable,
      ...args,
    ],
    {
      cwd: new URL("../../", import.meta.url).pathname,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "",
    exit: number | undefined,
    error = "";
  const lines = createInterface({ input: bridge.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    if (value.output)
      output += Buffer.from(value.output, "base64").toString("utf8");
    if (value.exit !== undefined) exit = value.exit;
  });
  bridge.stderr.on("data", (data) => {
    error += data;
  });
  const done = new Promise<void>((resolve, reject) => {
    bridge.once("error", reject);
    bridge.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(error)),
    );
  });
  void done.catch(() => {});
  return {
    get output() {
      return output;
    },
    get exitCode() {
      return exit;
    },
    write(text: string) {
      bridge.stdin.write(JSON.stringify({ write: text }) + "\n");
    },
    resize(rows: number, columns: number) {
      bridge.stdin.write(JSON.stringify({ resize: [rows, columns] }) + "\n");
    },
    signal(signal: string) {
      bridge.stdin.write(JSON.stringify({ signal }) + "\n");
    },
    async waitFor(text: string, timeout = 10000) {
      const end = Date.now() + timeout;
      while (!output.includes(text) && exit === undefined && Date.now() < end)
        await new Promise((r) => setTimeout(r, 20));
      assert(
        output.includes(text),
        `Missing ${text}: ${output.slice(-3000)} ${error}`,
      );
    },
    async close() {
      if (exit === undefined) {
        bridge.stdin.end();
      }
      await done;
      lines.close();
    },
    done,
  };
}
