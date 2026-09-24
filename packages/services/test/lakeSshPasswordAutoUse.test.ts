import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import type { ICredentialService } from "../src/credential/credential.js";
import { createLakeCatalogService } from "../src/lake-catalog/lakeCatalogService.js";
import { createTerminalService } from "../src/terminal/terminalService.js";
import type { ISettingService } from "../src/setting/setting.js";

test(
  "saved Lake SSH password is automatically used for a terminal password prompt",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "lake-ssh-auto-use-"));
    const binDir = join(dir, "bin");
    const originalPath = process.env.PATH;
    const values = new Map<string, string>();
    const credentials: ICredentialService = {
      async load(key) {
        return values.get(key) ?? null;
      },
      async save(key, value) {
        values.set(key, value);
      },
      async delete(key) {
        values.delete(key);
      },
    };
    const catalog = createLakeCatalogService({
      databasePath: join(dir, "catalog.sqlite"),
      credentialService: credentials,
    });
    let terminal: ReturnType<typeof createTerminalService> | undefined;
    try {
      await mkdir(binDir);
      const fakeSsh = join(binDir, "ssh");
      await writeFile(
        fakeSsh,
        `#!/usr/bin/env node
process.stdin.setRawMode(true);
process.stdin.resume();
let answer = "";
process.stdin.on("data", (chunk) => {
  for (const char of chunk.toString()) {
    if (char === "\\r" || char === "\\n") {
      process.stdout.write(answer === "test-password" ? "\\r\\nPASSWORD_ACCEPTED\\r\\n" : "\\r\\nPASSWORD_REJECTED\\r\\n");
      process.exit(answer === "test-password" ? 0 : 1);
    }
    answer += char;
  }
});
process.stdout.write("ops@127.0.0.1's password:");
`,
      );
      await chmod(fakeSsh, 0o755);
      process.env.PATH = [binDir, originalPath].filter(Boolean).join(delimiter);

      const lake = await catalog.createLake({ name: "test" });
      const host = await catalog.createResourceInLake(lake.id, {
        name: "loopback",
        kind: "host",
        environment: "development",
      });
      await catalog.saveSshProfile(host.id, { host: "127.0.0.1", port: 22, username: "ops" });
      await catalog.saveSshPassword(host.id, "test-password");
      terminal = createTerminalService({
        settingService: {
          async get() {
            return {};
          },
        } as ISettingService,
        lakeCatalogService: catalog,
        credentialService: credentials,
        enableLakeSsh: true,
      });
      const created = await terminal.createLakeSsh({ resourceId: host.id, cols: 80, rows: 24 });
      let output = "";
      const dataSubscription = terminal.onDynamicData(created.id)((data) => {
        output += data;
      });
      const exitCode = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("fake SSH did not exit")), 5_000);
        terminal?.onDynamicExit(created.id)((code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      dataSubscription.dispose();
      assert.equal(exitCode, 0);
      assert.match(output, /PASSWORD_ACCEPTED/);
      assert.doesNotMatch(output, /test-password/);
    } finally {
      terminal?.disposeAll();
      catalog.close();
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
