import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLakeCLI } from "../dist/contract.js";

test("TypeScript CLI preserves desktop lake/model/resource/conversation/settings envelopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "lake-ts-cli-")), previous = process.env.LAKE_HOME;
  process.env.LAKE_HOME = root;
  const run = async (argv, input = "") => {
    let stdout = "", stderr = "";
    const code = await runLakeCLI({ argv, stdin: (async function* () { if (input) yield Buffer.from(input); })(), stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
    assert.equal(code, 0, stderr); return JSON.parse(stdout);
  };
  try {
    assert.equal(await run(["current", "--json"]), null);
    await run(["add", "fixture", "--desc", "fixture lake"]);
    await run(["use", "fixture"]);
    assert.equal((await run(["current", "--json"])).name, "fixture");
    await run(["model", "configure", "--provider", "fixture", "--model", "vendor/fixture-model", "--base-url", "https://example.invalid/v1", "--wire-api", "openai_chat"]);
    await run(["model", "add", "--provider", "fixture", "--model", "fixture-second"]);
    const models = await run(["model", "ls", "--json"]);
    assert.equal(models.current, "vendor/fixture-model"); assert.equal(models.models.length, 2);
    await run(["model", "login", "--provider", "fixture"], "synthetic-fixture-key\n");
    const settings = await run(["settings"], JSON.stringify({ action: "get" }));
    assert(settings.models.every(model => model.has_key)); assert(!JSON.stringify(settings).includes("synthetic-fixture-key"));
    const resource = await run(["res", "add", "fixture/host", "--ssh", "operator@example.invalid:22", "--json"]);
    await run(["res", "authz", "fixture/host", "allow"]);
    assert.equal((await run(["res", "ls", "fixture", "--json"]))[0].id, resource.id);
    const conversation = await run(["conversation", "create", "fixture", "--json"]);
    const path = join(root, "project"); await mkdir(path);
    const project = await run(["code", "add", "fixture", "Project", "--path", path, "--json"]);
    await run(["code", "bind", conversation.id, project.id]);
    assert.equal((await run(["conversation", "show", conversation.id, "--json"])).conversation.project_id, project.id);
    await run(["conversation", "archive", conversation.id]);
    assert.equal((await run(["conversation", "archived", "--json"])).length, 1);
    await run(["conversation", "restore", conversation.id]);
    assert.equal((await run(["conversation", "list", "--json"])).length, 1);
    await run(["model", "logout", "--provider", "fixture"]);
    assert((await run(["settings"], '{"action":"get"}')).models.every(model => !model.has_key));
  } finally { if (previous === undefined) delete process.env.LAKE_HOME; else process.env.LAKE_HOME = previous; await rm(root, { recursive: true, force: true }); }
});
