import test from "node:test";
import assert from "node:assert/strict";
import { testHome } from "../fixtures/home.js";
import { addSession } from "../fixtures/session.js";
import { BudgetService } from "../../src/agent/budget.js";
test("concurrent requests cannot spend the last call twice and unknown usage is charged", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const { session } = await addSession(h, 1);
  const budget = new BudgetService(h.store);
  const results = await Promise.allSettled([
    budget.reserve(session.id, session.id, 500),
    budget.reserve(session.id, session.id, 500),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const result = results.find((r) => r.status === "fulfilled")!;
  assert(result.status === "fulfilled");
  await budget.settle(result.value, null, "fixture");
  const updated = await h.store.get<any>("sessions", session.id);
  assert.equal(updated.budget.calls, 1);
  assert.equal(updated.budget.tokens, 500);
  assert.equal(updated.budget.reservedCalls, 0);
  await assert.rejects(budget.reserve(session.id, session.id, 1));
});

test("configured prices calculate cost; missing usage or price stays unknown", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const { session } = await addSession(h);
  const budget = new BudgetService(h.store, [
    { id: "priced", inputPricePerMillion: 2, outputPricePerMillion: 4 },
  ]);
  for (const [usage, provider] of [
    [{ input: 1000, output: 2000, cached: 500 }, "priced"],
    [null, "priced"],
    [{ input: 1, output: 1, cached: null }, "unknown"],
  ] as const) {
    const id = await budget.reserve(session.id, session.id, 4000);
    await budget.settle(id, usage, provider);
  }
  const rows = await h.store.list<any>("model_usage");
  assert.equal(rows[0].cost, 0.01);
  assert.equal(rows[0].costSource, "configured-price");
  assert.equal(rows[1].cost, null);
  assert.equal(rows[2].cost, null);
});
