import type { LakeSshProfile } from "../lake-catalog/lakeCatalog.js";

/** 构造 argv 而非 shell 命令；指纹确认必须由 OpenSSH 的终端交互处理。 */
export function buildLakeSshArgs(profile: LakeSshProfile): string[] {
  return [
    "-tt",
    "-o",
    "StrictHostKeyChecking=ask",
    "-p",
    String(profile.port),
    "-l",
    profile.username,
    ...(profile.privateKeyPath ? ["-i", profile.privateKeyPath] : []),
    profile.host,
  ];
}
