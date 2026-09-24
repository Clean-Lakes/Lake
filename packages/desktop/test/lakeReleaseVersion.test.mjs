import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the next Lake desktop release is version 0.0.2", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.version, "0.0.2");
});
