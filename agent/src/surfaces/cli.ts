#!/usr/bin/env node
import { readFile, writeFile, rename, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  parseCli,
  assertSupported,
  helpText,
  commands,
} from "./cli-options.js";
import { runConversation } from "./cli-exec.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLakeApplication } from "../app/application.js";
import { createHttpServer } from "./http-server.js";
import { CredentialStore } from "../storage/credentials.js";
import { Redactor } from "../storage/redaction.js";
import { connectOrStartDaemon } from "./daemon-client.js";
import { renderJsonResult } from "./cli-renderer.js";
import { publicError, requireCondition } from "../domain/errors.js";
import { VERSION } from "../version.js";
export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const options = parseCli(args),
    values = options.values;
  if (options.command === "help") {
    process.stdout.write(helpText(options.args[0]));
    return;
  }
  assertSupported(options);
  if (options.command === "completion") {
    const shell = options.args[0];
    requireCondition(
      ["bash", "zsh", "fish"].includes(shell ?? ""),
      "invalid_input",
      "Use completion bash|zsh|fish",
    );
    const words = commands.join(" ");
    process.stdout.write(
      shell === "bash"
        ? `complete -W '${words} --model --config --profile --cd --add-dir --sandbox --ask-for-approval --json --last --help --version' lake\n`
        : shell === "zsh"
          ? `#compdef lake\n_arguments '1:command:(${words})' '*:argument:_files'\n`
          : `complete -c lake -f -a '${words}'\n`,
    );
    return;
  }
  if (options.command === "features") {
    renderJsonResult({
      interactive: true,
      exec: true,
      resume: true,
      fork: true,
      profiles: true,
      modelTools: true,
      workspaceScope: true,
      resourceApprovals: true,
      jsonl: true,
      cloud: false,
      mcpHost: false,
      images: false,
      arbitraryShell: false,
    });
    return;
  }
  const home = resolve(
    values.home ?? process.env.LAKE_HOME ?? join(homedir(), ".lake"),
  );
  const command = options.command,
    [sub, id] = options.args;
  if (command === "version" || values.version) {
    renderJsonResult({ version: VERSION, node: process.versions.node });
    return;
  }
  if (command === "credentials" && sub === "import") {
    requireCondition(
      !process.stdin.isTTY,
      "invalid_input",
      "Redirect private credential input from a file or pipe",
    );
    requireCondition(
      values.stdin && values.kind && values.id,
      "invalid_input",
      "Use credentials import --kind --id --stdin",
    );
    const store = new CredentialStore(join(home, "secrets"), new Redactor());
    await store.importFromFd(values.kind + "/" + values.id, 0);
    renderJsonResult({
      imported: true,
      reference: values.kind + "/" + values.id,
    });
    return;
  }
  if (command === "secrets" && sub === "migrate") {
    const { migrateFromSignedPipe } = await import(
      "../storage/legacy-migration.js"
    );
    requireCondition(
      values.manifest,
      "invalid_input",
      "Use the signed lake secrets migrate --manifest file",
    );
    await migrateFromSignedPipe(
      home,
      JSON.parse(await readFile(values.manifest, "utf8")),
    );
    renderJsonResult({ migrated: true });
    return;
  }
  if (command === "serve") {
    const app = await createLakeApplication({ home });
    const uiRoot = new URL("../../ui/dist/", import.meta.url).pathname;
    const http = await createHttpServer(app, {
      port: Number(values.port ?? 0),
      uiRoot,
    });
    const infoPath = join(app.paths.agent, "runtime/daemon.json"),
      temp = infoPath + "." + crypto.randomUUID();
    await writeFile(
      temp,
      JSON.stringify({
        origin: http.origin,
        token: http.auth.token,
        nonce: http.auth.nonce,
        pid: process.pid,
      }),
      { mode: 0o600 },
    );
    await rename(temp, infoPath);
    process.stderr.write(`Lake ${VERSION}: ${http.origin}\n`);
    if (values.open) {
      const url = http.origin + "/#bootstrap=" + http.auth.issue();
      app.redactor.register(url);
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
        stdio: "ignore",
      }).on("error", () =>
        process.stderr.write(
          "Open the local workbench through the launch command.\n",
        ),
      );
    }
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await http.close();
      await rm(infoPath, { force: true });
      await app.stop();
    };
    process.once("SIGTERM", () => void stop());
    process.once("SIGINT", () => void stop());
    return;
  }
  const client = await connectOrStartDaemon(home);
  if (["chat", "run", "exec", "resume", "fork", "review"].includes(command)) {
    await runConversation(client, options);
    return;
  }
  if (command === "models") {
    const config = await client.request("GET", "config");
    renderJsonResult(config);
    return;
  }

  if (command === "open") {
    const { ticket } = await client.request("POST", "launch", {});
    spawn(
      process.platform === "darwin" ? "open" : "xdg-open",
      [client.info.origin + "/#bootstrap=" + ticket],
      { stdio: "ignore" },
    );
    return;
  }
  if (command === "doctor") {
    const config = await client.request("GET", "config");
    renderJsonResult({
      version: VERSION,
      node: process.versions.node,
      daemon: "ready",
      providers: config.providers,
      capabilities: await client.request("GET", "diagnostics"),
    });
    return;
  }
  if (command === "resources" || command === "services") {
    if (sub === "list") {
      renderJsonResult(await client.request("GET", command));
      return;
    }
    requireCondition(
      sub === "import" && values.file,
      "invalid_input",
      "Use import --file",
    );
    renderJsonResult(
      await client.request(
        "POST",
        command,
        JSON.parse(await readFile(values.file, "utf8")),
      ),
    );
    return;
  }
  if (command === "actions" && sub === "show" && id) {
    const action = await client.request("GET", `actions/${id}`);
    const artifact = action.parameters.artifactId
      ? await client.request("GET", `artifacts/${action.parameters.artifactId}`)
      : null;
    renderJsonResult({ action, artifact });
    return;
  }
  if (command === "artifacts" && sub === "show" && id) {
    renderJsonResult(await client.request("GET", `artifacts/${id}`));
    return;
  }
  if (command === "grants") {
    if (sub === "create") {
      requireCondition(
        values.resource && values.effects,
        "invalid_input",
        "Use grants create --resource --effects",
      );
      renderJsonResult(
        await client.request("POST", "grants", {
          resourceId: values.resource[0],
          effects: values.effects.split(","),
        }),
      );
      return;
    }
    requireCondition(sub === "revoke" && id, "invalid_input");
    const grant = (await client.request("GET", "resources")).grants?.find(
      (g: any) => g.id === id,
    );
    requireCondition(grant, "not_found");
    renderJsonResult(
      await client.request("POST", `grants/${id}/revoke`, {}, grant.revision),
    );
    return;
  }
  if (command === "sessions") {
    if (sub === "list") {
      renderJsonResult(await client.request("GET", "sessions"));
      return;
    }
    const selected = id ?? values.session;
    requireCondition(selected, "invalid_input");
    const snapshot = await client.request(
      "GET",
      `sessions/${selected}/snapshot`,
    );
    if (sub === "show") {
      renderJsonResult(snapshot);
      return;
    }
    requireCondition(sub === "resume", "invalid_input");
    renderJsonResult(
      await client.request(
        "POST",
        `sessions/${selected}/resume`,
        {},
        snapshot.session.revision,
      ),
    );
    return;
  }
  if (command === "approve") {
    requireCondition(
      values.action && values.digest,
      "invalid_input",
      "Use approve --action --digest",
    );
    const action = await client.request("GET", `actions/${values.action}`);
    renderJsonResult(
      await client.request(
        "POST",
        `actions/${values.action}/approve`,
        { digest: values.digest },
        action.revision,
      ),
    );
    return;
  }
  if (command === "cancel") {
    requireCondition(values.task, "invalid_input", "Use cancel --task");
    const task = await client.request("GET", `tasks/${values.task}`);
    renderJsonResult(
      await client.request(
        "POST",
        `tasks/${values.task}/cancel`,
        {},
        task.revision,
      ),
    );
    return;
  }
  if (command === "criteria" && sub === "confirm") {
    requireCondition(values.task && values.criterion, "invalid_input");
    const task = await client.request("GET", `tasks/${values.task}`);
    renderJsonResult(
      await client.request(
        "POST",
        `tasks/${values.task}/criteria/${encodeURIComponent(values.criterion)}/confirm`,
        { confirmed: true },
        task.revision,
      ),
    );
    return;
  }
  if (command === "budget") {
    requireCondition(
      sub === "update" &&
        values.session &&
        values["max-calls"] &&
        values["max-tokens"],
      "invalid_input",
    );
    const snap = await client.request(
      "GET",
      `sessions/${values.session}/snapshot`,
    );
    renderJsonResult(
      await client.request(
        "POST",
        `sessions/${values.session}/budget`,
        {
          maxCalls: Number(values["max-calls"]),
          maxTokens: Number(values["max-tokens"]),
        },
        snap.session.revision,
      ),
    );
    return;
  }
  if (command === "terminal") {
    requireCondition(
      sub === "attach" && values.session && values.terminal,
      "invalid_input",
    );
    const snapshot = await client.request(
      "GET",
      `sessions/${values.session}/snapshot`,
    );
    const terminal = snapshot.execution_sessions.find(
      (t: any) => t.id === values.terminal,
    );
    requireCondition(terminal, "not_found");
    const { epoch } = await client.request(
      "POST",
      `terminals/${terminal.id}/control`,
      { confirmed: true },
      terminal.revision,
    );
    let inputQueue = Promise.resolve();
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    const listener = (b: Buffer) => {
      if (b.includes(29)) {
        void stop();
        return;
      }
      inputQueue = inputQueue
        .then(async () => {
          const current = (
            await client.request("GET", `sessions/${values.session}/snapshot`)
          ).execution_sessions.find((t: any) => t.id === terminal.id);
          await client.request(
            "POST",
            `terminals/${terminal.id}/input`,
            { text: b.toString(), epoch },
            current.revision,
          );
        })
        .catch((error) => {
          process.stderr.write(publicError(error).message + "\n");
        });
    };
    process.stderr.write("SSH 人工接管；Ctrl+] 确认操作停止并交还终端。\n");
    process.stdin.on("data", listener);
    const stop = async () => {
      process.stdin.off("data", listener);
      process.stdin.setRawMode?.(false);
      await inputQueue;
      const current = (
        await client.request("GET", `sessions/${values.session}/snapshot`)
      ).execution_sessions.find((t: any) => t.id === terminal.id);
      await client.request(
        "POST",
        `terminals/${terminal.id}/release`,
        { stopped: true },
        current.revision,
      );
      process.stdin.pause();
    };
    process.once("SIGINT", () => void stop());
    let cursor = "0";
    while (process.stdin.listenerCount("data")) {
      const chunks = await client.request(
        "GET",
        `terminals/${terminal.id}/output?after=${cursor}`,
      );
      for (const chunk of chunks) {
        process.stdout.write(chunk.text);
        cursor = chunk.cursor;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return;
  }
  requireCondition(false, "invalid_input", "Unknown command");
}
if (
  process.argv[1] &&
  (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)
)
  void runCli().catch((error) => {
    process.stderr.write(JSON.stringify({ error: publicError(error) }) + "\n");
    process.exitCode = 1;
  });
