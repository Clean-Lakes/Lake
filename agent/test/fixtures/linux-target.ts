import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { runProcess } from "../../src/adapters/process.js";
import { requireCondition, LakeError } from "../../src/domain/errors.js";
export async function startLinuxTarget() {
  const dir = await mkdtemp(join(tmpdir(), "lake-linux-fixture-")),
    name = "lake-systemd-" + randomUUID();
  const key = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }),
    parsed = ssh2.utils.parseKey(key.privateKey);
  if (parsed instanceof Error || Array.isArray(parsed))
    throw new LakeError(
      "prerequisite_missing",
      "Fixture key generation failed",
    );
  const publicPath = join(dir, "authorized_keys");
  await writeFile(
    publicPath,
    "ssh-rsa " + parsed.getPublicSSH().toString("base64") + " lake-test\n",
    { mode: 0o644 },
  );
  const command = async (args: string[]) => {
    const result = await runProcess("docker", args, {
      signal: new AbortController().signal,
      timeoutMs: 30000,
      maxBytes: 65536,
    });
    requireCondition(
      result.exitCode === 0,
      "prerequisite_missing",
      "Linux fixture setup failed: " + result.stderr.slice(0, 1200),
    );
    return result.stdout.trim();
  };
  try {
    await command([
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--privileged",
      "--cgroupns=private",
      "--tmpfs",
      "/run",
      "--tmpfs",
      "/run/lock",
      "--mount",
      `type=bind,src=${publicPath},dst=/run/lake/authorized_keys,readonly`,
      "-p",
      "127.0.0.1::2222",
      "-p",
      "127.0.0.1::8080",
      "lake-agent-systemd-test:0.0.1",
    ]);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        const result = await runProcess(
          "docker",
          ["exec", name, "systemctl", "is-active", "ssh", "lake-fixture"],
          { signal: new AbortController().signal, timeoutMs: 3000 },
        );
        if (
          result.exitCode === 0 &&
          result.stdout.trim().split("\n").length === 2 &&
          result.stdout
            .trim()
            .split("\n")
            .every((v) => v === "active")
        ) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) {
      const diagnostic = await runProcess(
        "docker",
        ["exec", name, "journalctl", "-u", "ssh", "--no-pager", "-n", "10"],
        { signal: new AbortController().signal },
      );
      throw new LakeError(
        "prerequisite_missing",
        "systemd fixture did not start: " + diagnostic.stdout.slice(0, 2000),
      );
    }
    const ports = JSON.parse(
      await command([
        "inspect",
        "--format",
        "{{json .NetworkSettings.Ports}}",
        name,
      ]),
    );
    const sshPort = ports["2222/tcp"][0].HostPort,
      httpPort = ports["8080/tcp"][0].HostPort;
    const fingerprint = (
      await command([
        "exec",
        name,
        "ssh-keygen",
        "-lf",
        "/etc/ssh/ssh_host_ed25519_key.pub",
        "-E",
        "sha256",
      ])
    ).split(" ")[1]!;
    return {
      name,
      endpoint: `ssh://127.0.0.1:${sshPort}`,
      healthUrl: `http://127.0.0.1:${httpPort}`,
      identity: fingerprint,
      privateKey: key.privateKey,
      configPath: "/etc/lake-fixture/config.json",
      unit: "lake-fixture.service",
      exec: (argv: string[]) => command(["exec", name, ...argv]),
      async close() {
        await runProcess("docker", ["rm", "-f", name], {
          signal: new AbortController().signal,
        }).catch(() => {});
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await runProcess("docker", ["rm", "-f", name], {
      signal: new AbortController().signal,
    }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
