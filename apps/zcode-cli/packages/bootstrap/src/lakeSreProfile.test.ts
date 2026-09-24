import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadZCodeAgentProfiles } from "./subagents.js";

test("CLI bootstrap reads SRE Beaver model selection from the shared state file", async () => {
  const root = await mkdtemp(join(tmpdir(), "lake-sre-bootstrap-"));
  const storageRoot = join(root, ".zcode");
  try {
    await mkdir(join(storageRoot, "v2"), { recursive: true });
    await writeFile(
      join(storageRoot, "v2", "agents-state.json"),
      JSON.stringify({
        builtInModelSelectionOverrides: {
          "lake-sre": { providerId: "test-provider", modelId: "test-model" },
        },
        pluginAgentModelSelectionOverrides: {},
        disabledAgentIds: [],
      }),
      "utf8",
    );
    const loaded = await loadZCodeAgentProfiles({ storageRoot, workingDirectory: root });
    assert.deepEqual(loaded.builtInModelSelectionOverrides["lake-sre"], {
      providerId: "test-provider",
      modelId: "test-model",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
