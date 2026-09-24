import { join } from "node:path";

export const LAKE_CLI_LOG_ARCHIVE_PREFIX = ".lake/cli/log";
export const LAKE_CUA_RUN_ARCHIVE_PREFIX = ".lake/computer-use/run";

export function resolveLakeCliDir(dataRoot: string): string {
  return join(dataRoot, "cli");
}

export function resolveLakeCuaHelperRunDir(dataRoot: string): string {
  return join(dataRoot, "computer-use", "run");
}
