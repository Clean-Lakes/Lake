import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export async function privateInput(path: string, limit = 1024 * 1024): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error("私钥需要绝对路径");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > limit) throw new Error("私钥文件必须是权限为 0600 的普通文件，且不超过 1 MiB");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || (opened.mode & 0o077) || opened.size > limit) throw new Error("私钥文件在检查后发生变化");
    const value = await file.readFile();
    if (value.length > limit || !/^-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----$/u.test(value.toString("utf8", 0, Math.min(value.length, 80)).split("\n")[0].trim())) {
      value.fill(0); throw new Error("文件不是可识别的 SSH 私钥格式");
    }
    return value;
  } finally { await file.close(); }
}
