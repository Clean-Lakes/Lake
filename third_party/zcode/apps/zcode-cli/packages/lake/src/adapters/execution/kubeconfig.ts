import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { lstat } from "node:fs/promises";
import { object, type Params } from "../../domain/validation.js";

export async function kubeconfigView(path: string, args: string[]): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error("kubeconfig 需要绝对路径");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error("kubeconfig 不是普通文件或超过 4 MiB");
  return new Promise((resolve, reject) => {
    execFile("kubectl", ["--kubeconfig", path, "config", ...args], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, timeout: 10_000, windowsHide: true }, (error, output) => {
      if (error) reject(new Error("kubectl 无法读取 kubeconfig，请检查文件和 kubectl 安装"));
      else resolve(output);
    });
  });
}
export async function kubeContexts(path: string): Promise<Params> {
  const raw = await kubeconfigView(path, ["view", "--output=json"]);
  try {
    const config = object(JSON.parse(raw.toString()));
    return { "current-context": config["current-context"] ?? "", contexts: config.contexts ?? [] };
  } finally { raw.fill(0); }
}
