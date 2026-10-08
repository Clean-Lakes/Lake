import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { InvocationSchema, type Invocation } from "../domain/invocation.js";
import { LakeError, requireCondition } from "../domain/errors.js";

export const commands = [
  "chat",
  "exec",
  "run",
  "resume",
  "fork",
  "review",
  "serve",
  "open",
  "sessions",
  "resources",
  "services",
  "credentials",
  "grants",
  "budget",
  "approve",
  "cancel",
  "terminal",
  "doctor",
  "actions",
  "artifacts",
  "criteria",
  "models",
  "completion",
  "features",
  "help",
  "version",
  "secrets",
];
export const unsupportedCommands = [
  "login",
  "logout",
  "mcp",
  "plugin",
  "mcp-server",
  "app-server",
  "remote-control",
  "app",
  "update",
  "sandbox",
  "debug",
  "apply",
  "archive",
  "delete",
  "unarchive",
  "cloud",
  "exec-server",
];
const strings = [
  "home",
  "port",
  "prompt",
  "intent",
  "lake",
  "environment",
  "provider",
  "file",
  "kind",
  "id",
  "action",
  "digest",
  "task",
  "criterion",
  "session",
  "terminal",
  "effects",
  "max-calls",
  "max-tokens",
  "manifest",
  "local-provider",
  "remote",
  "remote-auth-token-env",
  "output-schema",
  "color",
];
const booleans = [
  "open",
  "json",
  "stdin",
  "last",
  "all",
  "include-non-interactive",
  "no-alt-screen",
  "strict-config",
  "oss",
  "full-auto",
  "dangerously-bypass-approvals-and-sandbox",
  "dangerously-bypass-hook-trust",
  "search",
  "skip-git-repo-check",
  "ephemeral",
  "ignore-user-config",
  "ignore-rules",
];
export interface CliOptions {
  command: string;
  args: string[];
  values: Record<string, any>;
}
export function parseCli(args: string[]): CliOptions {
  const options: Record<string, any> = {};
  for (const n of strings) options[n] = { type: "string" };
  for (const n of booleans) options[n] = { type: "boolean" };
  Object.assign(options, {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "V" },
    model: { type: "string", short: "m" },
    config: { type: "string", short: "c", multiple: true },
    profile: { type: "string", short: "p" },
    cd: { type: "string", short: "C" },
    sandbox: { type: "string", short: "s" },
    "ask-for-approval": { type: "string", short: "a" },
    "output-last-message": { type: "string", short: "o" },
    resource: { type: "string", multiple: true },
    "add-dir": { type: "string", multiple: true },
    image: { type: "string", short: "i", multiple: true },
    enable: { type: "string", multiple: true },
    disable: { type: "string", multiple: true },
  });
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options });
  } catch (error) {
    throw new LakeError(
      "invalid_input",
      error instanceof Error && error.message.startsWith("Unknown option")
        ? "Unknown option: " +
          (error.message
            .match(/Unknown option '([^']+)'/)?.[1]
            ?.split("=")[0]
            ?.replace(/[^a-zA-Z0-9-]/g, "")
            .slice(0, 80) ?? "invalid")
        : "Invalid CLI arguments",
    );
  }
  const values = parsed.values as Record<string, any>,
    words = [...parsed.positionals];
  let command = words[0] ?? "chat";
  const aliases: Record<string, string> = { e: "exec", a: "apply" };
  command = aliases[command] ?? command;
  if (commands.includes(command) || unsupportedCommands.includes(command))
    words.shift();
  else command = "chat";
  if (values.version) command = "version";
  if (values.help) {
    if (
      parsed.positionals[0] &&
      (commands.includes(command) || unsupportedCommands.includes(command))
    )
      words.unshift(command);
    command = "help";
  }
  return { command, args: words, values };
}
export function assertSupported(options: CliOptions): void {
  requireCondition(
    !unsupportedCommands.includes(options.command),
    "capability_unavailable",
    `Lake has no ${options.command} backend; see lake help`,
  );
  for (const key of [
    "remote",
    "remote-auth-token-env",
    "image",
    "search",
    "enable",
    "disable",
    "output-schema",
    "ephemeral",
    "ignore-rules",
    "dangerously-bypass-hook-trust",
    "oss",
    "strict-config",
    "ignore-user-config",
  ])
    if (options.values[key] !== undefined && options.values[key] !== false)
      throw new LakeError(
        "capability_unavailable",
        `--${key} is not implemented by Lake`,
      );
  requireCondition(
    !options.values.color ||
      ["auto", "always", "never"].includes(options.values.color),
    "invalid_input",
    "Invalid --color",
  );
}
export function invocationOptions(
  values: Record<string, any>,
  preferences: {
    defaults?: Record<string, unknown>;
    profiles?: Record<string, Record<string, unknown>>;
  } = {},
): {
  invocation: Invocation;
  providerId?: string;
  selection: Record<string, any>;
} {
  let layer: Record<string, any> = { ...(preferences.defaults ?? {}) };
  if (values.profile) {
    const profile = preferences.profiles?.[values.profile];
    requireCondition(profile, "not_found", "CLI profile not found");
    layer = { ...layer, ...profile };
  }
  const allowed = new Set([
    "model",
    "model_provider",
    "model_reasoning_effort",
    "sandbox_mode",
    "approval_policy",
    "limits.sessionMaxModelCalls",
    "limits.sessionMaxEstimatedTokens",
    "lake",
    "environment",
    "resource",
  ]);
  for (const override of values.config ?? []) {
    const at = override.indexOf("=");
    requireCondition(at > 0, "invalid_input", "Use -c key=value");
    const key = override.slice(0, at);
    requireCondition(
      allowed.has(key),
      "invalid_input",
      `Unsupported config field: ${key}`,
    );
    const raw = override.slice(at + 1);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
    }
    layer[key] = value;
  }
  for (const key of Object.keys(layer))
    requireCondition(
      allowed.has(key),
      "invalid_input",
      `Unsupported CLI profile field: ${key}`,
    );
  const cwd = resolve(values.cd ?? process.cwd()),
    roots = [
      cwd,
      ...(values["add-dir"] ?? []).map((p: string) => resolve(cwd, p)),
    ];
  const invocation = InvocationSchema.parse({
    cwd,
    workspaceRoots: [...new Set(roots)],
    sandboxMode: values["dangerously-bypass-approvals-and-sandbox"]
      ? "danger-full-access"
      : (values.sandbox ??
        (values["full-auto"]
          ? "workspace-write"
          : (layer.sandbox_mode ?? "workspace-write"))),
    approvalPolicy: values["dangerously-bypass-approvals-and-sandbox"]
      ? "never"
      : (values["ask-for-approval"] ??
        (values["full-auto"]
          ? "on-request"
          : (layer.approval_policy ?? "on-request"))),
    bypassApprovals: Boolean(
      values["dangerously-bypass-approvals-and-sandbox"],
    ),
    ...((values.model ?? layer.model)
      ? { model: values.model ?? layer.model }
      : {}),
    ...(layer.model_reasoning_effort
      ? { reasoningEffort: layer.model_reasoning_effort }
      : {}),
    ...(layer["limits.sessionMaxModelCalls"] !== undefined
      ? { maxCalls: layer["limits.sessionMaxModelCalls"] }
      : {}),
    ...(layer["limits.sessionMaxEstimatedTokens"] !== undefined
      ? { maxTokens: layer["limits.sessionMaxEstimatedTokens"] }
      : {}),
  });
  const providerId =
    values["local-provider"] ?? values.provider ?? layer.model_provider;
  return {
    invocation,
    ...(providerId ? { providerId } : {}),
    selection: layer,
  };
}
export function helpText(command = ""): string {
  const top = `Lake CLI 0.0.1\n\nUsage: lake [OPTIONS] [PROMPT]\n       lake [OPTIONS] <COMMAND> [ARGS]\n\nCommands:\n  exec, e     Run a task non-interactively (stdin supported)\n  resume      Continue a session; picker or --last\n  fork        Start a new task from saved context; no action replay\n  review      Read-only project review\n  chat        Interactive conversation (default)\n  models      List configured models\n  serve/open  Local API and Web workbench\n  sessions/resources/services/grants/actions/artifacts/terminal/doctor\n  completion  Shell completion (bash/zsh/fish)\n  features    Inspect implemented features\n\nOptions:\n  -m, --model <MODEL>          Model ID or provider alias\n  -c, --config <key=value>     Repeatable invocation override\n  -p, --profile <NAME>         Named CLI preset\n  -C, --cd <DIR>               Workspace root\n      --add-dir <DIR>         Additional workspace root\n  -s, --sandbox <MODE>         read-only / workspace-write / danger-full-access\n  -a, --ask-for-approval <POLICY>  untrusted / on-request / never\n      --full-auto             workspace-write with on-request approvals\n      --dangerously-bypass-approvals-and-sandbox  Auto-approve granted templates\n      --no-alt-screen         Inline terminal (Lake default)\n      --home <DIR>            Private Lake home\n      --lake/--environment/--resource <UUID>  Explicit operations scope\n      --provider <ID>         Provider selection\n      --intent <TYPE>         diagnose / recover / change\n  -h, --help                  Help without starting a daemon\n  -V, --version               Version\n\nLake executes registered Powers; sandbox flags never grant arbitrary shell or new hosts.\nUnsupported: cloud, remote app-server, MCP/plugin hosting, images, web search, ephemeral runs.\n`;
  if (command === "exec" || command === "run")
    return (
      `Usage: lake ${command} [OPTIONS] [PROMPT|-]\n       lake exec resume [SESSION_ID] [PROMPT]\n\n--json emits JSONL for exec; run --json keeps its single result JSON.\n-o, --output-last-message <FILE> saves the final response.\nPrompt missing or '-' reads stdin; piped input appends to an explicit prompt.\n\n` +
      top
    );
  if (command === "resume" || command === "fork")
    return (
      `Usage: lake ${command} [OPTIONS] [SESSION_ID] [PROMPT]\n--last selects the most recent matching working directory. --all removes that filter.\n\n` +
      top
    );
  if (command && commands.includes(command))
    return `Usage: lake ${command} [ARGS] [OPTIONS]\n\n` + top;
  return top;
}
