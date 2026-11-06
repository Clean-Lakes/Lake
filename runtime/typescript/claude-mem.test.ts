import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  cp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { LakeStore } from "./store";
import { ClaudeMemIndex, openClaudeMemIndex } from "./claude-mem";
import { createHash } from "node:crypto";
import { createServer as createListener } from "node:net";

async function fixture(t: any) {
  const home = await mkdtemp(join(tmpdir(), "lake-claude-index-")),
    store = await LakeStore.open(home, join(home, "data"));
  store.put("settings", "layeredMemoryStoreId", "isolated-store");
  const observations = new Map<number, any>();
  let next = 1,
    failAfterSave = false,
    redirect = false;
  const saves: any[] = [],
    deleted: number[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : undefined,
      url = new URL(req.url!, "http://local");
    let result: any;
    if (url.pathname === "/api/health")
      result = { status: "ok", version: "15.10.0" };
    else if (url.pathname === "/api/memory/save") {
      if (redirect) {
        res.writeHead(302, { Location: "http://127.0.0.1:1/foreign" });
        res.end();
        return;
      }
      saves.push(input);
      let row = [...observations.values()].find(
        (row) =>
          row.project === input.project &&
          row.metadata.sourceFingerprint === input.metadata.sourceFingerprint,
      );
      if (!row) {
        row = { id: next++, ...input };
        observations.set(row.id, row);
      }
      if (failAfterSave) {
        failAfterSave = false;
        res.writeHead(503);
        res.end("{}");
        return;
      }
      result = { success: true, id: row.id, project: row.project };
    } else if (url.pathname === "/api/search") {
      // Include a forged foreign match: the client must verify both ownership and
      // local provenance instead of accepting returned text or arbitrary IDs.
      const ids = [...observations.values()]
        .filter((row) => row.project === url.searchParams.get("project"))
        .map((row) => row.id);
      result = {
        content: [
          {
            type: "text",
            text:
              ids
                .map((id) => `| #${id} | 10:00 | discovery | note |`)
                .join("\n") + "\n| #999 | foreign |",
          },
        ],
      };
    } else if (url.pathname === "/api/observations/batch")
      result = input.ids
        .map((id: number) =>
          id === 999
            ? {
                id,
                project: "foreign",
                metadata: { sourceFingerprint: "fake" },
                narrative: "MUST_NOT_USE_FOREIGN_TEXT",
              }
            : observations.get(id),
        )
        .filter(Boolean);
    else if (
      req.method === "DELETE" &&
      url.pathname.startsWith("/api/observation/")
    ) {
      const id = Number(url.pathname.split("/").at(-1));
      deleted.push(id);
      observations.delete(id);
      result = { success: true };
    } else {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + (server.address() as any).port,
    index = new ClaudeMemIndex(store, origin, () => {});
  t.after(async () => {
    await index.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    store,
    index,
    observations,
    saves,
    deleted,
    origin,
    failNext() {
      failAfterSave = true;
    },
    redirect(value = true) {
      redirect = value;
    },
  };
}
const doc = (id = "a", scopeKey = "role-a", revision = 1) => ({
  id,
  scopeKey,
  revision,
  title: "K2 entrance",
  body: "K2 entrance 192.0.2.75, instance db/mysql141-0; historical only.",
});

test("Claude-Mem ranks only locally mapped scoped notes, deduplicates writes and preserves independent namespaces", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.index.rank([doc()], ["role-a"], "K2", () => {}), [
    "a",
  ]);
  const saved = f.saves.length;
  assert.deepEqual(await f.index.rank([doc()], ["role-a"], "K2", () => {}), [
    "a",
  ]);
  assert.equal(f.saves.length, saved);
  await f.index.rank([doc("b", "role-b")], ["role-b"], "K2", () => {});
  assert.equal(f.observations.size, 2);
  assert.notEqual(f.saves[0].project, f.saves[1].project);
  assert.deepEqual(await f.index.rank([doc()], ["role-a"], "K2", () => {}), [
    "a",
  ]);
  await f.index.forget(["a"]);
  assert.equal(f.observations.size, 1);
  assert.ok([...f.observations.values()][0].text.includes("reference b@1"));
});

test("updated notes replace old index rows and uncertain saves can still be erased by fingerprint", async (t) => {
  const f = await fixture(t);
  await f.index.rank([doc()], ["role-a"], "K2", () => {});
  await f.index.rank([doc("a", "role-a", 2)], ["role-a"], "K2", () => {});
  assert.equal(f.observations.size, 1);
  assert.equal(f.deleted.length, 1);
  f.failNext();
  await assert.rejects(() =>
    f.index.rank([doc("b")], ["role-a"], "K2", () => {}),
  );
  assert.ok(
    f.store
      .list<any>("claudeMemIndex")
      .some((row) => row.entryId === "b" && !row.observationId),
  );
  await f.index.forget(["b"]);
  assert.equal(f.observations.size, 0);
  assert.equal(f.store.list("claudeMemIndex").length, 0);
});

test("index export rejects remote destinations and redirects and revalidates before returning a result", async (t) => {
  const f = await fixture(t);
  for (const url of [
    "https://example.com",
    "http://localhost:1234",
    "http://127.0.0.1:1234/path",
    "http://x@127.0.0.1:1234",
  ])
    assert.throws(() => new ClaudeMemIndex(f.store, url, () => {}), /loopback/);
  f.redirect();
  await assert.rejects(() => f.index.rank([doc()], ["role-a"], "K2", () => {}));
  f.redirect(false);
  let validations = 0;
  await assert.rejects(
    () =>
      f.index.rank([doc()], ["role-a"], "K2", () => {
        if (++validations === 3) throw new Error("scope revoked");
      }),
    /scope revoked/,
  );
  await f.index.forget(["a"]);
  assert.equal(f.observations.size, 0);
});

test(
  "managed upstream worker requires a private credential and exits with its Lake owner",
  { skip: !process.env.LAKE_TEST_CLAUDE_MEM_ENGINE_ROOT },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "lake-managed-index-")),
      store = await LakeStore.open(home, join(home, "web-agent")),
      root = join(home, "claude-mem");
    await mkdir(root, { mode: 0o700 });
    await cp(
      process.env.LAKE_TEST_CLAUDE_MEM_ENGINE_ROOT!,
      join(root, "engine"),
      { recursive: true },
    );
    const guard = join(root, "guard.cjs");
    await copyFile(new URL("../claude-mem/guard.cjs", import.meta.url), guard);
    const listener = createListener();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const port = (listener.address() as any).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const hash = async (path: string) =>
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    await writeFile(
      join(root, "index.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        managed: true,
        port,
        bunSHA256: await hash(
          join(root, "engine/node_modules/@oven/bun-darwin-aarch64/bin/bun"),
        ),
        workerSHA256: await hash(
          join(
            root,
            "engine/node_modules/claude-mem/plugin/scripts/worker-service.cjs",
          ),
        ),
        guardSHA256: await hash(guard),
      }),
      { mode: 0o600 },
    );
    const index = await openClaudeMemIndex(store, () => {});
    assert.ok(index);
    t.after(async () => {
      await index.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    });
    const origin = "http://127.0.0.1:" + port;
    assert.equal(
      (await fetch(origin + "/api/health")).status,
      401,
      "a model command cannot read the private index without the host credential",
    );
    assert.equal((await index.health()).version, "15.10.0");
    assert.deepEqual(await index.rank([doc()], ["role-a"], "K2", () => {}), [
      "a",
    ]);
    const token = (await readFile(join(root, "token"), "utf8")).trim();
    assert.equal(
      (
        await fetch(origin + "/api/health", {
          headers: {
            Authorization: "Bearer " + token,
            Origin: "http://localhost:1",
          },
        })
      ).status,
      401,
    );
    await index.forget(["a"]);
    await index.close();
    await assert.rejects(() => fetch(origin + "/api/health"));
  },
);

test(
  "real upstream Claude-Mem protocol validates save/search/batch/delete when explicitly supplied",
  { skip: !process.env.LAKE_TEST_CLAUDE_MEM_URL },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "lake-real-claude-index-")),
      store = await LakeStore.open(home, join(home, "data"));
    store.put("settings", "layeredMemoryStoreId", home);
    const index = new ClaudeMemIndex(
      store,
      process.env.LAKE_TEST_CLAUDE_MEM_URL!,
      () => {},
    );
    t.after(async () => {
      await index.forget(["a", "b"]);
      await index.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    });
    assert.equal((await index.health()).version, "15.10.0");
    assert.deepEqual(await index.rank([doc()], ["role-a"], "K2", () => {}), [
      "a",
    ]);
    await index.rank([doc("b", "role-b")], ["role-b"], "K2", () => {});
    assert.deepEqual(await index.rank([doc()], ["role-a"], "K2", () => {}), [
      "a",
    ]);
    await index.forget(["a"]);
    assert.deepEqual(await index.rank([], ["role-a"], "K2", () => {}), []);
  },
);
