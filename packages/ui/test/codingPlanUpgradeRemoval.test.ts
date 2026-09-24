import assert from "node:assert/strict";
import test from "node:test";
import {
  createDisabledCodingPlanEntryInventory,
  shouldEnableCodingPlanUpgrade,
} from "../src/lib/codingPlanUpgradeGate.js";

test("升级套餐页在本地定制下整页下线", () => {
  assert.equal(shouldEnableCodingPlanUpgrade(), false);
});

test("下线期间入口查询态为 ready，入口不会被显示成重试", () => {
  const inventory = createDisabledCodingPlanEntryInventory();
  assert.equal(inventory.status, "ready");
  assert.equal(inventory.entryPlanList, "");
  // retry 是 no-op：下线期间不重放、也不触发厂家套餐查询。
  assert.doesNotThrow(() => inventory.retry());
});
