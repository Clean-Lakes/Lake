import type { LakeRuntime } from "./contract.js";
export async function listLakes(runtime: LakeRuntime) {
  return runtime.dispatch({ method: "lake.list", params: {} });
}
