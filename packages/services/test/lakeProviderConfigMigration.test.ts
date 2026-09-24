import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { migrateZCodeProviderConfig } from "../src/model-provider/migrateZCodeProviderConfig.js";

const emptyConfig = {
  schemaVersion: 1,
  config: {
    providerConfigRules: { providerRules: [] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  },
};
const oldConfig = {
  schemaVersion: 1,
  config: {
    providerOrder: ["legacy-provider"],
    providerConfigRules: {
      providerRules: [
        {
          providerId: "legacy-provider",
          providerName: "Legacy provider",
          config: { group: "standard-personal", personalModelIds: ["legacy-model"] },
        },
      ],
    },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  },
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "lake-provider-migration-"));
  const lakeDir = join(dir, ".lake", "v2");
  const zcodeDir = join(dir, ".zcode", "v2");
  await Promise.all([mkdir(lakeDir, { recursive: true }), mkdir(zcodeDir, { recursive: true })]);
  const lakeFilePath = join(lakeDir, "provider_config.json");
  const zcodeFilePath = join(zcodeDir, "provider_config.json");
  const migrationMarkerPath = join(lakeDir, "provider_config.zcode-imported");
  return {
    dir,
    lakeFilePath,
    zcodeFilePath,
    migrationMarkerPath,
    migrate: () => migrateZCodeProviderConfig({ lakeFilePath, zcodeFilePath, migrationMarkerPath }),
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

test("imports old provider config into an existing empty Lake config once", async () => {
  const f = await fixture();
  try {
    const source = JSON.stringify(oldConfig);
    await writeFile(f.zcodeFilePath, source);
    await writeFile(f.lakeFilePath, JSON.stringify(emptyConfig));
    assert.equal(await f.migrate(), "imported");
    const imported = JSON.parse(await readFile(f.lakeFilePath, "utf8"));
    assert.deepEqual(
      imported.config.providerConfigRules.providerRules,
      oldConfig.config.providerConfigRules.providerRules,
    );
    assert.equal(await readFile(f.zcodeFilePath, "utf8"), source);
    await readFile(f.migrationMarkerPath, "utf8");

    // 用户在 Lake 中清空配置后不能因重启再次导入旧供应商。
    await writeFile(f.lakeFilePath, JSON.stringify(emptyConfig));
    assert.equal(await f.migrate(), "already-complete");
    assert.deepEqual(JSON.parse(await readFile(f.lakeFilePath, "utf8")), emptyConfig);
  } finally {
    await f.dispose();
  }
});

test("preserves a nonempty Lake config and resolves concurrent hosts with one migration", async () => {
  const f = await fixture();
  try {
    await writeFile(f.zcodeFilePath, JSON.stringify(oldConfig));
    const lakeOwned = {
      ...emptyConfig,
      config: {
        ...emptyConfig.config,
        providerConfigRules: {
          providerRules: [{ providerId: "lake-provider", config: { group: "standard-personal" } }],
        },
      },
    };
    const lakeContent = JSON.stringify(lakeOwned);
    await writeFile(f.lakeFilePath, lakeContent);
    assert.equal(await f.migrate(), "kept-lake");
    assert.equal(await readFile(f.lakeFilePath, "utf8"), lakeContent);

    await rm(f.migrationMarkerPath);
    await writeFile(f.lakeFilePath, JSON.stringify(emptyConfig));
    const outcomes = await Promise.all([f.migrate(), f.migrate()]);
    assert.deepEqual(outcomes.sort(), ["already-complete", "imported"]);
  } finally {
    await f.dispose();
  }
});

test("invalid old config is not imported or marked complete", async () => {
  const f = await fixture();
  try {
    await writeFile(f.zcodeFilePath, "{invalid");
    const lakeContent = JSON.stringify(emptyConfig);
    await writeFile(f.lakeFilePath, lakeContent);
    assert.equal(await f.migrate(), "invalid-source");
    assert.equal(await readFile(f.lakeFilePath, "utf8"), lakeContent);
    await assert.rejects(readFile(f.migrationMarkerPath), { code: "ENOENT" });
  } finally {
    await f.dispose();
  }
});

test("new Lake provider creation persists across Provider Runtime restart", async () => {
  const f = await fixture();
  const builtin = fileURLToPath(
    new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
  );
  try {
    await writeFile(f.zcodeFilePath, JSON.stringify(oldConfig));
    for (let run = 0; run < 2; run += 1) {
      const runtime = createProviderConfigRuntime({
        zcodeBuiltinFilePath: builtin,
        personalFilePath: f.lakeFilePath,
        priorProductPersonalFilePath: f.zcodeFilePath,
        migrationMarkerPath: f.migrationMarkerPath,
        personalPollingIntervalMs: false,
        watch: false,
      });
      try {
        await runtime.start();
        if (run === 0) {
          await runtime.configService.createPersonalProvider({ providerName: "Lake owned" });
        } else {
          const config = await runtime.configService.read();
          assert.ok(
            config.personalProviders.rules().some((rule) => rule.providerName === "Lake owned"),
          );
          assert.ok(config.personalProviders.getRule("legacy-provider"));
        }
      } finally {
        runtime.dispose();
      }
    }
  } finally {
    await f.dispose();
  }
});
