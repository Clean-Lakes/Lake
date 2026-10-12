import assert from "node:assert/strict";
import { test } from "node:test";
import { rebaseMentions, referencedResources } from "../../shared/references.js";
void test("selected mentions disambiguate overlapping and duplicate asset names", () => {
  const text = "检查 @prod-backup 和 @prod";
  const first = text.indexOf("@prod-backup"), second = text.lastIndexOf("@prod");
  const refs = [{ resourceId: "backup", label: "@prod-backup", start: first, end: first + 12 }, { resourceId: "chosen-prod", label: "@prod", start: second, end: second + 5 }];
  assert.deepEqual(referencedResources(text, refs, ["backup", "chosen-prod", "other-prod"]), ["backup", "chosen-prod"]);
  const prefixed = "现在" + text; const updated = rebaseMentions(text, prefixed, refs);
  assert.deepEqual(referencedResources(prefixed, updated, ["backup", "chosen-prod"]), ["backup", "chosen-prod"]);
  const removed = prefixed.replace("@prod-backup", "其他"); const remaining = rebaseMentions(prefixed, removed, updated);
  assert.deepEqual(referencedResources(removed, remaining, ["backup", "chosen-prod"]), ["chosen-prod"]);
  assert.deepEqual(referencedResources(text, refs, ["other-prod"]), []);
});
