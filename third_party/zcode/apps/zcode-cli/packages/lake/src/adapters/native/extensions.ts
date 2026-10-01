import {
  resolveZCodePlugins,
  getZCodePluginsOverview,
  listZCodeSkills,
  setZCodePluginEnabled,
  inspectWorkspaceHookTrust,
  grantWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
} from "@zcode/bootstrap";
import type { DataPort } from "../../app/ports.js";
import type { JsonValue } from "../../domain/json.js";
import { object, text, type Params } from "../../domain/validation.js";
import { createConfig } from "@zcode/adapters/config";
import { readSettings } from "../config/files.js";
import { nativeEnvironment } from "../agent/extensions.js";
import { registeredRoot } from "../workspace/files.js";

export class NativeExtensions {
  constructor(
    private readonly data: DataPort,
    private readonly root: string,
  ) {}
  async request(method: string, params: Params): Promise<JsonValue> {
    const requested = text(params, "project_path");
    if (requested) {
      const projects = (await this.data.request("code.list", {})) as Params[];
      if (!projects.some((project) => project.path === requested))
        throw new Error("工作区尚未登记");
      await registeredRoot(requested);
    }
    const options = {
      env: nativeEnvironment(this.root),
      ...(requested ? { workingDirectory: requested } : {}),
    };
    if (method === "native.plugin.set") {
      await setZCodePluginEnabled({
        ...options,
        plugin: text(params, "name"),
        enabled: params.enabled === true,
      });
    } else if (method === "native.hook.set") {
      if (!requested) throw new Error("Hook 需要已登记项目");
      const target = { workspacePath: requested };
      if (params.enabled === true) await grantWorkspaceHookTrust(target);
      else await revokeWorkspaceHookTrustCli(target);
    } else if (method !== "native.extensions") throw new Error("未知的原生扩展操作");
    const native = resolveZCodePlugins(options);
    const plugins = await getZCodePluginsOverview(options),
      skills = await listZCodeSkills(options),
      hook = requested ? await inspectWorkspaceHookTrust({ workspacePath: requested }) : undefined;
    const configured = new Map<string, Params>(
      Object.entries(
        createConfig({ workingDirectory: requested || process.cwd(), env: options.env }).config.mcp
          .servers,
      ).map(([name, server]) => [name, object(server as unknown as Params)]),
    );
    const saved = await readSettings(this.root);
    for (const server of saved.mcp as Params[]) configured.set(text(server, "name"), server);
    return {
      mcp: [
        ...[...configured]
          .filter(([name]) => name !== "lake")
          .map(([name, server]) => ({
            name,
            transport: server.transport ?? server.type ?? "stdio",
            enabled: server.enabled !== false,
          })),
        ...native.plugins.flatMap((plugin) =>
          plugin.mcpServerNames.map((name) => ({
            name,
            transport: "native",
            enabled: plugin.enabled,
          })),
        ),
      ],
      plugins: plugins.installedPlugins.map((plugin) => ({
        name: plugin.id,
        version: plugin.version ?? "",
        state: plugin.enabled ? "enabled" : "disabled",
        sha256: "",
        mcp_servers: native.plugins.find((item) => item.id === plugin.id)?.mcpServerNames ?? [],
        hook_declarations: plugin.hookDetails?.length ?? 0,
      })),
      skills: skills.skills.map((skill) => ({ name: skill.name, scope: "native", sha256: "" })),
      hook: {
        status: hook
          ? hook.reasonCode === "workspace_hooks_trusted_persistent"
            ? "enabled"
            : hook.items.length
              ? "disabled"
              : "absent"
          : "unbound",
        sha256: hook?.bundleDigest ?? "",
        hooks: hook?.items.length ?? 0,
      },
    };
  }
}
