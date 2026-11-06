import assert from "node:assert/strict";
import test from "node:test";
import {
  commandPolicy,
  isLiteralProgramDiscovery,
} from "../../shared/command-policy";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const command of [
  "command -v kubectl",
  "command -V mysql mysqldump",
  "hostname; command -v mysql; command -v kubectl; command -v mysqldump",
]) {
  test(`literal program discovery is a read-only observation: ${command}`, () => {
    assert.equal(commandPolicy(command).risk, "readonly");
    assert.ok(commandPolicy(command).safeCommand);
    assert.equal(isLiteralProgramDiscovery(command), true);
  });
}

test("compiled lookup preserves the inspected PATH and never executes discovered programs", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "lake-lookup-")),
    executable = join(directory, "lake_fixture_lookup_cli"),
    marker = join(directory, "executed");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(executable, `#!/bin/sh\nprintf executed > '${marker}'\n`);
  chmodSync(executable, 0o700);
  const policy = commandPolicy("command -v lake_fixture_lookup_cli");
  const output = execFileSync("/bin/sh", ["-c", policy.safeCommand!], {
    env: { PATH: directory + ":/usr/bin:/bin" },
    encoding: "utf8",
  });
  assert.equal(output.trim(), executable);
  assert.equal(existsSync(marker), false);
  assert.throws(
    () =>
      execFileSync(
        "/bin/sh",
        [
          "-c",
          commandPolicy("command -v lake_fixture_absent_cli").safeCommand!,
        ],
        { env: { PATH: directory + ":/usr/bin:/bin" } },
      ),
    { status: 1 },
  );
});

for (const command of [
  "command -v kubectl && kubectl config current-context && kubectl get pods -A -o wide",
  "command -v kubectl || which kubectl",
])
  test(`program lookup does not force dangerous-command confirmation: ${command}`, () => {
    const policy = commandPolicy(command);
    assert.equal(
      policy.risk,
      "write",
      "lookup discovery does not grant a readonly proof to an opaque CLI",
    );
    assert.equal(policy.safeCommand, undefined);
  });

for (const command of [
  "command -v --help",
  "command -v kubectl -p",
  "command kubectl get pods -A",
  "command -p kubectl get pods -A",
  "/tmp/command -v kubectl",
  "command -v kubectl && kubectl delete pods fixture",
  "command -v kubectl && sudo kubectl get pods -A",
  "command -v kubectl; rm -f fixture",
  'command -v kubectl && bash -c "kubectl get pods -A"',
  'command -v "$(touch fixture)"',
])
  test(`lookup cannot hide a dangerous execution: ${command}`, () => {
    assert.equal(commandPolicy(command).risk, "dangerous");
  });

for (const command of [
  "hostname; command -v mysql; mysql -e 'SHOW DATABASES'",
  "command -v mysql > fixture",
  "command -v mysql | cat",
  "hostname; command -v '$PATH'",
  "command -v mysql;",
  "command -v mysql &",
  "hostname; command -v mysql\nrm -f fixture",
]) {
  test(`historical discovery proof excludes non-discovery syntax: ${command}`, () => {
    assert.equal(isLiteralProgramDiscovery(command), false);
  });
}

for (const command of [
  'sh -c "printf hello && pwd"',
  'docker exec fixture sh -c "command -v mysql || true"',
  `kubectl -n fixture exec fixture-db -- sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -B -e "SELECT COUNT(*) FROM information_schema.tables"'`,
  `docker exec fixture sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "SHOW DATABASES"'`,
  'docker exec fixture sh -c "printenv | cut -d= -f1 | sort"',
  `kubectl -n fixture exec fixture-db -- sh -c 'mysql -e "CHECKSUM TABLE fixture_table"'`,
])
  test(`bounded shell and container inspection follows ordinary command permission: ${command}`, () => {
    assert.equal(commandPolicy(command).risk, "write");
    assert.equal(commandPolicy(command).safeCommand, undefined);
  });
for (const command of [
  "command -v kubectl\nrm -rf fixture",
  'sh -c "printf ok; rm -rf fixture"',
  'docker exec fixture sh -c "rm -rf fixture"',
  'kubectl exec fixture -- sh -c "mysql -e \"DROP DATABASE fixture\""',
  'docker exec --privileged fixture sh -c "printf ok"',
  'docker exec fixture sh -c "if true; then rm -rf fixture; fi"',
  'docker exec fixture sh -c "BASH_ENV=fixture bash -c true"',
  `docker exec fixture sh -c 'mysql --version --init-command="DROP DATABASE fixture"'`,
  `docker exec fixture sh -c 'mysql -e "SELECT 1" -e "DROP DATABASE fixture" -e "SELECT 2"'`,
])
  test(`inspection cannot hide mutation, elevated access, custom initialization or control flow: ${command}`, () => {
    assert.equal(commandPolicy(command).risk, "dangerous");
  });

test("MySQL client metacommands cannot be hidden in an inspection query", () => {
  assert.equal(
    commandPolicy(
      `docker exec fixture sh -c 'mysql -e "SELECT 1; \\! rm -rf fixture"'`,
    ).risk,
    "dangerous",
  );
});

test("ordinary escaped SQL data remains eligible for command auto-approval", () => {
  const command = String.raw`kubectl exec fixture -- sh -c 'mysql -e "SELECT CONCAT(\"a\", \"\\n\")"'`;
  assert.equal(commandPolicy(command).risk, "write");
});

test("vertical result formatting does not turn a metadata query into arbitrary execution", () => {
  assert.equal(
    commandPolicy(
      String.raw`docker exec fixture sh -c 'mysql -e "SHOW TABLE STATUS\\G"'`,
    ).risk,
    "write",
  );
});
