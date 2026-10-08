import { parseDocument } from "yaml";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Resource, ToolResult } from "../domain/entities.js";
import { toolResult } from "../domain/entities.js";
import type { CredentialPort } from "../domain/ports.js";
import { requireCondition } from "../domain/errors.js";
import { canonicalActionDigest } from "../operations/action-digest.js";
import { runProcess } from "./process.js";
export class KubeAdapter {
  constructor(
    private readonly credentials: CredentialPort,
    private readonly executable = "kubectl",
  ) {}
  async executeRead(
    resource: Resource,
    operation: string,
    parameters: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    requireCondition(resource.credentialRef, "scope_denied");
    const context = resource.settings.context,
      namespace = resource.settings.namespace;
    requireCondition(
      typeof context === "string" &&
        context.length > 0 &&
        typeof namespace === "string" &&
        /^[a-z0-9][a-z0-9-]*$/.test(namespace),
      "invalid_input",
    );
    const bytes = await this.credentials.resolve(resource.credentialRef);
    const text = Buffer.from(bytes).toString();
    bytes.fill(0);
    const document = parseDocument(text);
    requireCondition(!document.errors.length, "invalid_input");
    const config = document.toJSON();
    for (const entry of config.users ?? [])
      requireCondition(
        !entry.user?.["client-key"] &&
          !entry.user?.["client-certificate"] &&
          !entry.user?.tokenFile,
        "scope_denied",
        "Embed private credential data in the imported kubeconfig",
      );
    for (const entry of config.clusters ?? [])
      requireCondition(
        !entry.cluster?.["certificate-authority"],
        "scope_denied",
        "Embed certificate authority data in the imported kubeconfig",
      );
    for (const entry of config.users ?? [])
      if (entry.user?.exec)
        requireCondition(
          resource.settings.trustedExecHash ===
            canonicalActionDigest(entry.user.exec),
          "scope_denied",
          "Untrusted kubeconfig exec plugin",
        );
    const selected = config.contexts?.find((c: any) => c.name === context);
    requireCondition(selected, "scope_denied");
    const cluster = config.clusters?.find(
      (c: any) => c.name === selected.context.cluster,
    );
    requireCondition(
      cluster?.cluster?.server === resource.endpoint &&
        !cluster.cluster["insecure-skip-tls-verify"],
      "identity_mismatch",
    );
    const dir = await mkdtemp(join(tmpdir(), "lake-kube-")),
      path = join(dir, "config");
    await writeFile(path, text, { mode: 0o600 });
    const args = [
      "--kubeconfig",
      path,
      "--context",
      context,
      "--namespace",
      namespace,
      "--request-timeout=20s",
    ];
    try {
      if (operation === "events") args.push("get", "events", "-o", "json");
      else if (operation === "logs") {
        requireCondition(
          typeof parameters.name === "string" &&
            /^[a-z0-9][a-z0-9.-]*$/.test(parameters.name),
          "invalid_input",
        );
        args.push(
          "logs",
          parameters.name,
          "--tail=" + String(parameters.lines ?? 100),
        );
      } else {
        requireCondition(
          ["get", "describe"].includes(operation) &&
            [
              "pod",
              "deployment",
              "statefulset",
              "service",
              "endpoints",
              "event",
            ].includes(String(parameters.kind)),
          "scope_denied",
        );
        args.push(operation, String(parameters.kind));
        if (parameters.name) {
          requireCondition(
            /^[a-z0-9][a-z0-9.-]*$/.test(String(parameters.name)),
            "invalid_input",
          );
          args.push(String(parameters.name));
        }
        if (operation === "get") args.push("-o", "json");
      }
      const output = await runProcess(this.executable, args, {
        signal,
        timeoutMs: 30000,
        env: { PATH: process.env.PATH, HOME: dir, KUBECONFIG: path },
      });
      requireCondition(
        output.exitCode === 0,
        "capability_unavailable",
        "Kubernetes read unavailable",
      );
      return toolResult(
        { output: output.stdout, observedAt: new Date().toISOString() },
        { retryPolicy: "safe_read" },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
