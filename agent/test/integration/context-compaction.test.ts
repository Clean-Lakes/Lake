import test from "node:test";
import assert from "node:assert/strict";
import { testHome } from "../fixtures/home.js";
import { addSession } from "../fixtures/session.js";
import { BudgetService } from "../../src/agent/budget.js";
import { compact } from "../../src/agent/compaction.js";
import { ContextBuilder } from "../../src/agent/context.js";
import { SkillLoader } from "../../src/skills/loader.js";
test("compaction retains prior summary, fresh constraints and frozen skills; invalid summaries are charged", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const { session } = await addSession(h);
  const budget = new BudgetService(h.store);
  let prior = "";
  const summary = await compact(
    {
      async *stream(r) {
        prior = r.messages[1]!.content!;
        yield {
          type: "complete",
          message: {
            role: "assistant",
            content: JSON.stringify({
              facts: ["known fact"],
              unresolvedActions: ["unknown action"],
              evidenceIds: ["proof-1"],
              userConstraints: ["no restart"],
              decisions: [],
            }),
          },
          usage: { input: 10, output: 20, cached: null },
        };
      },
    },
    budget,
    session.id,
    session.id,
    "fixture",
    [{ role: "user", content: "long history" }],
    100,
    new AbortController().signal,
    "old proof",
  );
  assert(prior.includes("old proof"));
  const skill = {
    name: "sre-diagnosis",
    version: "1.0.0",
    description: "Diagnostic",
    whenToUse: "SRE",
    body: "Keep unknown outcomes unresolved",
    digest: "frozen",
    source: "builtin",
  };
  const loader = new SkillLoader([skill]);
  loader.restore(["frozen"]);
  const built = new ContextBuilder().build({
    identity: "SRE",
    baseline: "Rules",
    objective: "Restore",
    constraints: ["new user constraint"],
    shared: { evidenceIds: ["proof-1"] },
    inbox: ["latest instruction"],
    skills: [skill.name],
    loadedSkills: loader.bodies(),
    history: [],
    tools: [],
    window: 4096,
    maxOutput: 100,
    summary,
  });
  assert(JSON.stringify(built.messages).includes("new user constraint"));
  assert(
    JSON.stringify(built.messages).includes("Keep unknown outcomes unresolved"),
  );
  assert(JSON.stringify(built.messages).includes("proof-1"));
  await assert.rejects(
    compact(
      {
        async *stream() {
          yield {
            type: "complete",
            message: { role: "assistant", content: '{"facts":"wrong"}' },
            usage: null,
          };
        },
      },
      budget,
      session.id,
      session.id,
      "fixture",
      [],
      100,
      new AbortController().signal,
    ),
  );
  assert.equal(
    (await h.store.get<any>("sessions", session.id)).budget.calls,
    2,
  );
});
