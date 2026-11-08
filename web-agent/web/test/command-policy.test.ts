import assert from "node:assert/strict";
import test from "node:test";
import {
  commandPolicy,
  isLiteralProgramDiscovery,
} from "../../shared/command-policy";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  chownSync,
  mkdirSync,
  lstatSync,
  symlinkSync,
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

test("only explicitly scoped temporary paths and compiled unprivileged inventories are classified", async()=>{
  const {compileNobodyInspection}=await import("../../shared/command-policy");
  const dir="/tmp/release.verify-2026";
  const raw="runuser -u nobody -- /bin/bash -c 'id; ls -la "+dir+"; find "+dir+' -maxdepth 4 -printf "%y %s %p\\n"'+String.fromCharCode(39);
  const compiled=compileNobodyInspection(raw)!;
  assert.equal(compiled.directory,dir); assert.equal(compiled.inventoryDepth,4);
  assert.ok(compiled.command.includes("/usr/sbin/runuser -u nobody --"));
  assert.ok(compiled.command.includes("cd / || exit 1; if test -x /usr/bin/python3"));
  assert.notEqual(commandPolicy(raw).risk,"readonly");
  for(const bad of [raw.replace("nobody","root"),raw.replace("runuser","/tmp/runuser"),raw.replace("id;","touch /tmp/file;"),
      raw.replace("ls -la","ls -la > /tmp/bad"),raw.replace("-printf","-fprintf"),raw.replace("-printf","-delete -printf"),
      raw.replace("id;","$(touch /tmp/bad);"),raw.replace(" -maxdepth","/../escape -maxdepth"),raw+"; touch /tmp/escape",
      raw.replace("id;","id | touch /tmp/bad;"),raw.replace("ls -la","bash -lc"),raw.replace("find ","/tmp/find ")])
    assert.equal(compileNobodyInspection(bad),undefined,bad);
  for(const cmd of ["nl -ba "+dir+"/app.log","sha256sum -- "+dir+"/quota/app.log"]){
    assert.notEqual(commandPolicy(cmd).risk,"readonly");
    assert.equal(compileNobodyInspection("runuser -u nobody -- /bin/bash -c '"+cmd+"'"),undefined);
  }
  for(const cmd of ["nl -ba "+dir+"/../x","sha256sum -c "+dir+"/list","sha256sum /etc/passwd","nl --body-numbering=p "+dir+"/app.log","sha256sum "+dir+"/a > "+dir+"/f"])
    assert.notEqual(commandPolicy(cmd).risk,"readonly",cmd);
});

test("only compiles a bounded nobody delay followed by literal one-line output", async () => {
  const {compileNobodyDelay} = await import("../../shared/command-policy");
  const shell = (script: string) => "runuser -u nobody -- /bin/sh -c '" + script.replaceAll("'", "'\"'\"'") + "'";
  for (const script of ['sleep 5 && printf "%s\\n" "finished"', 'sleep 0; printf "finished\\n"']) {
    const source = shell(script);
    assert.match(compileNobodyDelay(source)!, /^\/usr\/bin\/env -i .*\/usr\/sbin\/runuser -u nobody -- \/usr\/bin\/env -i /);
    assert.notEqual(commandPolicy(source).risk, "readonly");
  }
  const sample = shell('sleep 5 && printf "%s\\n" complete');
  for (const source of [sample.replace("nobody", "root"), sample.replace("runuser", "/tmp/runuser"),
    sample.replace("/bin/sh", "/tmp/sh"), sample + " > /tmp/destination", sample + "; touch /tmp/x",
    ...['sleep 601 && printf "done\\n"', 'sleep -1 && printf "done\\n"', 'sleep 0 && printf "abc%n\\n"',
      'sleep 0 || printf "done\\n"', 'sleep 0 && printf "%s\\n" "$(id)"', 'sleep 0 && printf "%s\\n" ok > file',
      'sleep 0 && printf "done\\n" && rm -f file', 'sleep 0 && printf -v var done'].map(shell)]) {
    assert.equal(compileNobodyDelay(source), undefined, source);
  }
});

test("the inventory opens a private root and never follows a link or a raced subdirectory", {skip:process.platform==="win32"}, async t => {
  const {directoryInventoryProgram}=await import("../../shared/command-policy");
  const root=mkdtempSync("/tmp/lake-inventory-"), outside=mkdtempSync("/tmp/lake-outside-"), alias=root+"-link";
  t.after(()=>{for(const path of [alias,root,outside]) rmSync(path,{force:true,recursive:true});});
  chmodSync(root,0o700);
  writeFileSync(join(outside,"external-marker"),"secret material");
  mkdirSync(join(root,"pivot"));
  symlinkSync(outside,join(root,"child-link"));
  symlinkSync(join(outside,"external-marker"),join(root,"file-link"));
  symlinkSync(outside,alias);
  const options: {encoding:"utf8"; uid?:number; gid?:number}={encoding:"utf8"};
  if(process.getuid?.()===0){
    const rejected=spawnSync("python3",["-I","-S","-B","-c",directoryInventoryProgram,root,"4"],options);
    assert.notEqual(rejected.status,0);
    const uid=Number(execFileSync("id",["-u","nobody"]).toString().trim());
    const gid=Number(execFileSync("id",["-g","nobody"]).toString().trim());
    for(const path of [root,outside,join(root,"pivot")]) chownSync(path,uid,gid);
    Object.assign(options,{uid,gid});
  }
  const run=(path: string, prefix="")=>spawnSync("python3",["-I","-S","-B","-c",prefix+directoryInventoryProgram,path,"4"],options);
  const ok=run(root);
  assert.equal(ok.status,0,ok.stderr);
  assert.match(ok.stdout,/^l \d+ .*\/child-link$/m);
  assert.match(ok.stdout,/^l \d+ .*\/file-link$/m);
  assert.doesNotMatch(ok.stdout,/external-marker|secret material/);
  assert.notEqual(run(alias).status,0);
  chmodSync(root,0o755);
  assert.notEqual(run(root).status,0);
  chmodSync(root,0o700);
  const race=String.raw`import os
original_open = os.open
def race(name, flags, *args, **kwargs):
    if os.path.basename(name) == b"pivot":
        os.rmdir(name)
        os.symlink(`+JSON.stringify(outside)+String.raw`,name)
    return original_open(name,flags,*args,**kwargs)
os.open=race
`;
  const result=run(root,race);
  assert.notEqual(result.status,0);
  assert.equal(result.stdout,"");
  assert.ok(lstatSync(join(root,"pivot")).isSymbolicLink());
});
