import type { Resource, ToolResult } from "../domain/entities.js";
import { toolResult } from "../domain/entities.js";
import { requireCondition, LakeError } from "../domain/errors.js";
export interface ConfigChangePort {
  replaceConfig(
    resource: Resource,
    path: string,
    expectedHash: string,
    artifactId: string,
    actionId: string,
    signal: AbortSignal,
  ): Promise<{
    oldHash: string;
    newHash: string;
    backupPath: string;
    unit: string;
  }>;
  rollbackConfig(
    resource: Resource,
    path: string,
    newHash: string,
    backupPath: string,
    signal: AbortSignal,
  ): Promise<void>;
  readConfig(
    resource: Resource,
    path: string,
  ): Promise<{
    hash: string;
  }>;
}
export async function replaceConfigAndVerify(
  adapter: ConfigChangePort,
  resource: Resource,
  parameters: Record<string, unknown>,
  signal: AbortSignal,
  verify: () => Promise<boolean>,
): Promise<ToolResult> {
  const path = String(parameters.path);
  const receipt = await adapter.replaceConfig(
    resource,
    path,
    String(parameters.expectedHash),
    String(parameters.artifactId),
    String(parameters.__actionId),
    signal,
  );
  if (await verify()) return toolResult({ ...receipt, verified: true });
  if (parameters.rollback !== true)
    return toolResult({ ...receipt, verified: false }, { status: "error" });
  await rollbackIfUnchanged(
    adapter,
    resource,
    path,
    receipt.newHash,
    receipt.backupPath,
    signal,
  );
  const restored =
    (await adapter.readConfig(resource, path)).hash === receipt.oldHash &&
    (await verify());
  return toolResult(
    { ...receipt, verified: false, rolledBack: restored },
    {
      status: "error",
      error: {
        code: "precondition_failed",
        message:
          "Change failed verification; restoration was separately checked",
        retryable: false,
      },
    },
  );
}
export async function rollbackIfUnchanged(
  adapter: ConfigChangePort,
  resource: Resource,
  path: string,
  newHash: string,
  backupPath: string,
  signal: AbortSignal,
): Promise<void> {
  requireCondition(
    (await adapter.readConfig(resource, path)).hash === newHash,
    "precondition_failed",
    "Drift prevents rollback",
  );
  await adapter.rollbackConfig(resource, path, newHash, backupPath, signal);
}
