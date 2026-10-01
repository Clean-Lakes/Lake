export type { JsonValue } from "./domain/json.js";
export type { LakeCommand, LakeEvent, LakeRuntime, LakeRuntimeOptions } from "./domain/protocol.js";
export { createLakeRuntime } from "./adapters/runtime.js";
export { runLakeCLI } from "./adapters/cli/main.js";
export type { LakeCLIContext } from "./domain/cli.js";
