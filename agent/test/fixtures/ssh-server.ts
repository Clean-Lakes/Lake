import ssh2 from "ssh2";
import { generateKeyPairSync, createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
export async function startSshFixture() {
  const host = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const user = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const key = ssh2.utils.parseKey(host.privateKey);
  if (key instanceof Error) throw key;
  const identity =
    "SHA256:" +
    createHash("sha256")
      .update(key.getPublicSSH())
      .digest("base64")
      .replace(/=+$/, "");
  let executions = 0;
  const connections = new Set<any>();
  const server = new ssh2.Server({ hostKeys: [host.privateKey] }, (client) => {
    connections.add(client);
    client.on("error", () => {});
    client.on("close", () => connections.delete(client));
    client.on("authentication", (ctx) =>
      ctx.username === "fixture" ? ctx.accept() : ctx.reject(),
    );
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (accept, _reject, info) => {
          executions++;
          const stream = accept();
          if (
            info.command.includes("systemctl") &&
            info.command.includes("show")
          )
            stream.write(
              "ActiveState=active\nSubState=running\nMainPID=123\nInvocationID=fixture\n",
            );
          else if (info.command.includes("uname"))
            stream.write("Linux fixture 6.1\n");
          else if (info.command.includes("journalctl"))
            stream.write("fixture service started\n");
          else {
            stream.stderr.write("unsupported fixture command");
            stream.exit(1);
            stream.end();
            return;
          }
          stream.exit(0);
          stream.end();
        });
        session.on("pty", (accept) => accept());
        session.on("shell", (accept) => {
          const channel = accept();
          channel.write("fixture shell\r\n");
          channel.on("data", (b: Buffer) => channel.write(b));
        });
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as AddressInfo;
  return {
    endpoint: `ssh://127.0.0.1:${address.port}`,
    identity,
    privateKey: user.privateKey,
    get executions() {
      return executions;
    },
    async close() {
      for (const c of connections) c.end();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
