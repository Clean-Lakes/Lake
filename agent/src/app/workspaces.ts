import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { LakeApplication } from "./application.js";
import { stableId } from "../specialists/task-progress.js";
import { requireCondition, LakeError } from "../domain/errors.js";
export async function resolveWorkspaces(
  app: LakeApplication,
  paths: string[],
  mode: string,
): Promise<{
  lakeId: string;
  environmentId: string;
  resourceIds: string[];
  roots: string[];
}> {
  const privateRoots = await Promise.all(
    [app.paths.home, app.paths.agent, resolve(app.paths.home, "secrets")].map(
      async (p) => realpath(p).catch(() => resolve(p)),
    ),
  );
  const roots = [
    ...new Set(
      await Promise.all(
        paths.map(async (path) => {
          const root = await realpath(resolve(path));
          requireCondition(
            (await stat(root)).isDirectory(),
            "invalid_input",
            "Workspace must be a directory",
          );
          requireCondition(
            !privateRoots.some((p) => root === p || root.startsWith(p + "/")),
            "scope_denied",
            "Private Lake state cannot be a workspace",
          );
          return root;
        }),
      ),
    ),
  ];
  const lakeId = stableId("local-workspaces"),
    environmentId = stableId("local-development");
  const resources = roots.map((root) => ({
    id: stableId("workspace:" + root),
    lakeId,
    environmentId,
    kind: "local",
    name: basename(root) || root,
    endpoint: root,
    identity: root,
    settings: {},
  }));
  for (let attempt = 0; attempt < 3; attempt++)
    try {
      await app.importResources({
        lakes: (await app.store.get("lakes", lakeId))
          ? []
          : [
              {
                id: lakeId,
                name: "本地工作区",
                description: "Explicit CLI working directories",
              },
            ],
        environments: (await app.store.get("environments", environmentId))
          ? []
          : [
              {
                id: environmentId,
                lakeId,
                name: "开发环境",
                classification: "development",
              },
            ],
        resources: (
          await Promise.all(
            resources.map(async (r) =>
              (await app.store.get("resources", r.id)) ? undefined : r,
            ),
          )
        ).filter(Boolean),
      });
      break;
    } catch (error) {
      if (
        !(error instanceof LakeError && error.code === "conflict") ||
        attempt === 2
      )
        throw error;
    }
  for (const r of resources)
    await app.grants.create(
      r.id,
      mode === "read-only" ? ["read"] : ["read", "change"],
      "local-user",
      stableId("workspace-grant:" + r.id + ":" + mode),
    );
  return {
    lakeId,
    environmentId,
    resourceIds: resources.map((r) => r.id),
    roots,
  };
}
