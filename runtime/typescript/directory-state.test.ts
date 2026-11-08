import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  directoryStateCommand,
  directoryStateRoot,
  validateDirectoryState,
} from "./directory-state";

const directory = "/tmp/operator.observation";
const hash = (str: string) => createHash("sha256").update(str).digest("hex");
const now = "2026-01-02T03:04:05Z";
const root = {
  path: ".",
  type: "directory",
  uid: 99,
  gid: 99,
  mode: 0o700,
  size: 0,
  ino: 42,
  mtimeUs: 0,
  treeSha256: hash("tree"),
};
const fixture = {
  schemaVersion: 1,
  directory,
  uid: 99,
  startedAt: now,
  observedAt: now,
  complete: true,
  issues: [],
  present: true,
  treeSha256: root.treeSha256,
  entryCount: 1,
  hashedBytes: 0,
  displayDepth: 3,
  entries: [root],
  processes: [],
};
const parse = (value: unknown) =>
  validateDirectoryState(JSON.stringify(value), directory);

test("directory-state accepts only a single absolute private-directory candidate and drops root before loading Python", () => {
  assert.equal(directoryStateRoot(directory), directory);
  for (const value of [
    "/tmp",
    "/tmp/",
    "/tmp/.",
    "/tmp/../etc",
    "/tmp/a/b",
    "/tmp/x\n",
    "/etc/passwd",
    "/tmp/x;id",
    null,
  ])
    assert.throws(() => directoryStateCommand(value as string));
  const command = directoryStateCommand(directory);
  assert.match(command, /^\/usr\/bin\/env -i /);
  assert.ok(
    command.includes("/usr/sbin/runuser -u nobody -- /usr/bin/env -i "),
  );
  assert.ok(command.includes("cd / || exit 1"));
  assert.ok(command.includes("/usr/bin/python3"));
  assert.ok(command.includes('"-EsSB"') || command.includes(" -EsSB "));
});

test("incomplete visibility is explicit; malformed complete states, identity and chronology cannot authorize review", () => {
  assert.ok(parse(fixture));
  const absent = {
    ...fixture,
    present: false,
    entryCount: 0,
    treeSha256: null,
    entries: [],
  };
  assert.ok(parse(absent));
  assert.ok(
    parse({
      ...absent,
      complete: false,
      present: null,
      issues: ["visibility or identity: 13"],
    }),
  );
  const proc = {
    uid: 99,
    pid: 42,
    ppid: 1,
    startTicks: 123,
    cwd: directory,
    cwdDeleted: false,
    argv: ["sh", "-c", "[sha256:" + hash("source") + "]"],
    argvSha256: hash("argv"),
    tcpListeners: [{ address: "127.0.0.1", port: 8443 }],
  };
  assert.ok(parse({ ...fixture, processes: [proc] }));
  for (const value of [
    { ...fixture, uid: 0 },
    { ...fixture, treeSha256: hash("different") },
    { ...fixture, directory: "/tmp/other" },
    { ...fixture, startedAt: "2027-01-01T00:00:00Z" },
    { ...fixture, observedAt: "invalid" },
    { ...fixture, issues: ["changed"] },
    { ...fixture, complete: false },
    { ...absent, present: null },
    { ...absent, hashedBytes: 1 },
    { ...fixture, entryCount: 0 },
    { ...fixture, entries: [{ ...root, mode: 0o755 }] },
    { ...fixture, entries: [{ ...root, path: "../elsewhere" }] },
    { ...fixture, processes: [{ ...proc, uid: 100 }] },
    { ...fixture, processes: [{ ...proc, pid: -1 }] },
    {
      ...fixture,
      processes: [
        { ...proc, tcpListeners: [{ address: "somewhere", port: 80 }] },
      ],
    },
    { ...fixture, processes: [proc, proc] },
  ])
    assert.throws(() => parse(value));
});

test(
  "the actual unprivileged Linux scanner hashes content, never follows links, rejects hardlinks and handles absence",
  {
    skip:
      process.platform !== "linux" ||
      !["root", "nobody"].includes(process.env.USER ?? ""),
  },
  () => {
    const uid = Number(
      execFileSync("id", ["-u", "nobody"], { encoding: "utf8" }).trim(),
    );
    const gid = Number(
      execFileSync("id", ["-g", "nobody"], { encoding: "utf8" }).trim(),
    );
    const dir = mkdtempSync("/tmp/lake-directory-state-"),
      outside = mkdtempSync("/tmp/lake-state-outside-");
    const run = (target: string) =>
      JSON.parse(
        validateDirectoryState(
          execFileSync("/bin/sh", ["-c", directoryStateCommand(target)], {
            encoding: "utf8",
            timeout: 30000,
          }),
          target,
        ),
      );
    try {
      const marker = "private contents only their digest may appear";
      chownSync(dir, uid, gid);
      chmodSync(dir, 0o700);
      writeFileSync(dir + "/file", marker);
      chownSync(dir + "/file", uid, gid);
      writeFileSync(outside + "/secret", "outside marker must never appear");
      symlinkSync(outside + "/secret", dir + "/external");
      const first = run(dir);
      assert.equal(first.complete, true, first.issues.join(","));
      assert.equal(
        first.entries.find((entry: any) => entry.path === "file").sha256,
        hash(marker),
      );
      assert.equal(
        first.entries.find((entry: any) => entry.path === "external").target,
        undefined,
      );
      assert.equal(
        first.entries.find((entry: any) => entry.path === "external")
          .targetSha256,
        hash(outside + "/secret"),
      );
      assert.ok(!JSON.stringify(first).includes(marker));
      assert.ok(!JSON.stringify(first).includes("outside marker"));
      assert.equal(run(dir).treeSha256, first.treeSha256);
      linkSync(dir + "/file", dir + "/second-name");
      assert.equal(run(dir).complete, false);
      unlinkSync(dir + "/second-name");
      chmodSync(dir, 0o755);
      assert.equal(run(dir).complete, false);
      rmSync(dir, { recursive: true, force: true });
      const gone = run(dir);
      assert.deepEqual(
        [gone.complete, gone.present, gone.entryCount, gone.processes],
        [true, false, 0, []],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  },
);
