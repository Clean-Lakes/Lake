import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileVault } from "../dist/adapters/vault.js";
import { LakeSettings } from "../dist/adapters/config/settings.js";

test("model catalog and MCP secrets preserve old settings shapes without leaking credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "lake-ts-settings-")), vault = new FileVault(root), settings = new LakeSettings(root, vault);
  try {
    const fixtureSecret = "synthetic-fixture-credential";
    await settings.request({ action: "model_save", model: "fixture-model", provider: "fixture", base_url: "https://example.invalid/v1", wire_api: "openai_chat", api_key: fixtureSecret });
    const configText = await readFile(join(root, "config.toml"), "utf8");
    assert(!configText.includes(fixtureSecret));
    assert.equal((await settings.request({ action: "get" })).models[0].has_key, true);
    await settings.request({ action: "mcp_save", server: { name: "fixture-mcp", transport: "stdio", command: "fixture-command", env: { FIXTURE_SECRET: fixtureSecret }, enabled: true } });
    assert(!(await readFile(join(root, "settings.json"), "utf8")).includes(fixtureSecret));
    assert(!JSON.stringify(await settings.request({ action: "get" })).includes("secret_ref"));
    await settings.request({ action: "mcp_save", server: { name: "fixture-mcp", transport: "stdio", command: "changed-command", enabled: true } });
    assert.equal(JSON.parse((await vault.load("mcp", "fixture-mcp")).toString()).env.FIXTURE_SECRET, fixtureSecret);
    await settings.request({ action: "mcp_delete", name: "fixture-mcp" });
    assert.equal(await vault.has("mcp", "fixture-mcp"), false);
    await assert.rejects(settings.request({ action: "model_save", model: "bad", provider: "bad", base_url: "http://example.invalid" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
