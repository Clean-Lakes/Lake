import assert from "node:assert/strict";
import test from "node:test";
import { AgentType } from "@zcode/contracts";
import { buildGeneralPurposeSystemPrompt } from "./general-purpose.js";
import { buildExploreAgentPrompt } from "./explore.js";
import { formatAgentProfilesForPrompt, normalizeAgentProfiles } from "./profile.js";
import { buildSreSystemPrompt } from "./sre.js";

test("built-in agents identify themselves using Lake display language", () => {
  for (const prompt of [
    buildGeneralPurposeSystemPrompt(),
    buildExploreAgentPrompt({ embeddedSearchEnabled: false }),
    buildSreSystemPrompt(),
  ]) {
    assert.match(prompt, /Lake/);
    assert.doesNotMatch(prompt, /ZCode/);
  }
});

test("SRE Beaver is a diagnostic built-in with read-only tools", () => {
  assert.equal(AgentType.Sre, "lake-sre");
  const profile = normalizeAgentProfiles([], {
    builtInModelSelectionOverrides: {
      "lake-sre": { providerId: "test-provider", modelId: "test-model" },
    },
  }).find((candidate) => candidate.name === "lake-sre");
  assert.ok(profile);
  assert.equal(profile.source, "built-in");
  assert.deepEqual(profile.modelSelection, {
    providerId: "test-provider",
    modelId: "test-model",
  });
  assert.deepEqual(profile.tools, ["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);
  assert.doesNotMatch(profile.systemPrompt, /execute remediation automatically/i);
  assert.match(profile.systemPrompt, /evidence|observations/i);
  assert.match(profile.systemPrompt, /approval/i);
  assert.match(formatAgentProfilesForPrompt([]) ?? "", /lake-sre: Read-only software reliability/);
  assert.equal(
    normalizeAgentProfiles([
      {
        name: "lake-sre",
        description: "Existing custom SRE",
        source: "user",
        systemPrompt: "custom",
      },
    ]).find((candidate) => candidate.name === "lake-sre")?.description,
    "Existing custom SRE",
  );
});
