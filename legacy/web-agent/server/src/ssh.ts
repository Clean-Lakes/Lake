import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import type { Resource } from "../../shared/contracts.js";
import { ApiFailure } from "./store.js";

export function sshConfig(value: unknown): NonNullable<Resource["ssh"]> {
  if (!value || typeof value !== "object") throw new ApiFailure(400, "SSH connection details required");
  const item = value as Record<string, unknown>;
  if (typeof item.host !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/.test(item.host)) {
    throw new ApiFailure(400, "SSH host must be a hostname or IP address");
  }
  if (typeof item.username !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(item.username)) {
    throw new ApiFailure(400, "SSH username is invalid");
  }
  const port = item.port ?? 22;
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new ApiFailure(400, "SSH port must be 1..65535");
  if (typeof item.identityFile !== "string" || !item.identityFile || item.identityFile.length > 1000 || /[\r\n\0]/.test(item.identityFile)) {
    throw new ApiFailure(400, "Specify a credential file under ~/.lake/secrets/");
  }
  // Only resolve paths and inspect permissions. Lake never reads private-key contents.
  let path: string;
  try {
    const root = realpathSync(join(homedir(), ".lake", "secrets"));
    const directory = statSync(root);
    if ((directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()) throw Error("invalid credential directory permissions");
    path = realpathSync(isAbsolute(item.identityFile) ? item.identityFile : join(root, item.identityFile));
    const metadata = statSync(path);
    if (!path.startsWith(root + sep) || !metadata.isFile() || ![0o600, 0o400].includes(metadata.mode & 0o777) || metadata.uid !== process.getuid?.()) {
      throw Error("invalid credential permissions");
    }
  } catch { throw new ApiFailure(400, "SSH credential must be an existing private file owned by you under ~/.lake/secrets/ (0600 or 0400)"); }
  return { host: item.host, port: Number(port), username: item.username, identityFile: path };
}

export function sshArguments(config: NonNullable<Resource["ssh"]>): string[] {
  return [
    "-F", "/dev/null", "-tt", "-e", "none", "-a", "-x",
    "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "AddKeysToAgent=no",
    "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
    "-o", `UserKnownHostsFile=${join(homedir(), ".ssh", "known_hosts")}`,
    "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
    "-p", String(config.port), "-l", config.username, "-i", config.identityFile,
    config.host, "exec /bin/sh",
  ];
}
