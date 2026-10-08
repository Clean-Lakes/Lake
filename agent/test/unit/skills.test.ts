import test from "node:test";
import assert from "node:assert/strict";
import {
  SkillRegistry,
  composeDefaultSkills,
} from "../../src/skills/registry.js";
import { readSkillCatalog } from "../../src/adapters/skill-source.js";
import { SkillLoader } from "../../src/skills/loader.js";
test("every specialist inherits six immutable default skills and bodies reload after compaction", async () => {
  const registry = new SkillRegistry();
  for (const file of await readSkillCatalog(
    new URL("../../builtin/skills", import.meta.url).pathname,
  ))
    registry.register(file.text, file.source, true);
  const snapshot = registry.resolve();
  assert.equal(snapshot.length, 6);
  assert.equal(composeDefaultSkills(["sre-diagnosis"]).length, 6);
  const loader = new SkillLoader(snapshot);
  assert.equal(loader.bodies().length, 0);
  const body = loader.load("sre-diagnosis");
  const restored = new SkillLoader(snapshot);
  restored.restore(loader.digests());
  assert.equal(restored.bodies()[0], body);
  assert.throws(() =>
    registry.register(
      "---\nname: sre-diagnosis\nversion: 0.0.1\ndescription: fake\nwhenToUse: always\n---\nunsafe",
      "project",
      false,
    ),
  );
});
