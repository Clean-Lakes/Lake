import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSubagentsService } from "../src/subagents/subagentsService.js";

test("SRE Beaver is listed as a built-in and its model override survives reopening", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "lake-sre-beaver-"));
  try {
    const service = createSubagentsService({ homeDir, isDesktopRuntime: true });
    const initial = await service.list({ workspacePath: homeDir, mode: "settingsUserOnly" });
    const sre = initial.agents.find((agent) => agent.name === "lake-sre");
    assert.ok(sre);
    assert.equal(sre.id, "built-in:built-in:lake-sre");
    assert.equal(sre.readOnly, true);
    assert.deepEqual(sre.tools, ["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);

    await service.setBuiltInModelOverride({
      agentName: "lake-sre",
      modelSelection: { providerId: "test-provider", modelId: "test-model" },
    });
    const reopened = createSubagentsService({ homeDir, isDesktopRuntime: true });
    const persisted = await reopened.list({ workspacePath: homeDir, mode: "settingsUserOnly" });
    assert.deepEqual(
      persisted.agents.find((agent) => agent.name === "lake-sre")?.modelSelectionOverride,
      { providerId: "test-provider", modelId: "test-model" },
    );

    await assert.rejects(
      service.createAgent({
        config: { name: "lake-sre", description: "custom", systemPrompt: "custom" },
        provider: "glm",
        scope: "user",
      }),
      /reserved by a built-in agent/i,
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("an existing custom lake-sre profile remains editable beside the built-in", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "lake-sre-legacy-"));
  try {
    const profileDir = join(homeDir, ".zcode", "agents");
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, "lake-sre.md"),
      "---\nname: lake-sre\ndescription: Existing custom SRE\n---\nCustom prompt\n",
      "utf8",
    );
    const service = createSubagentsService({ homeDir, isDesktopRuntime: true });
    const listed = await service.list({ workspacePath: homeDir, mode: "settingsUserOnly" });
    const matches = listed.agents.filter((agent) => agent.name === "lake-sre");
    assert.deepEqual(
      matches.map((agent) => agent.source),
      ["built-in", "user"],
    );
    const custom = matches[1];
    assert.ok(custom);
    assert.equal(custom.description, "Existing custom SRE");
    const updated = await service.updateAgent({
      agentId: custom.id,
      oldFilePath: custom.path,
      config: { name: "lake-sre", description: "Edited custom SRE", systemPrompt: "custom" },
      provider: "glm",
      scope: "user",
    });
    assert.equal(updated.agent.description, "Edited custom SRE");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
