import test from "node:test";
import assert from "node:assert/strict";
import {compileServiceInspection,reportedServiceIdentity,serviceInspectionSource} from "./service-inspection";

const target="/tmp/private.example-01";
const source=serviceInspectionSource(target);

test("recognizes a complete nobody service snapshot and rebuilds a fixed privileged envelope",()=>{
  const plan=compileServiceInspection(source)!;
  assert.equal(plan.directory,target);
  assert.equal(plan.profile,"service-inspection-v1");
  assert.match(plan.command,/^\/usr\/bin\/env -i .* \/usr\/sbin\/runuser -u nobody -- \/usr\/bin\/env -i /);
  assert.ok(plan.command.includes("os.O_NOFOLLOW"));
  assert.ok(plan.command.includes("cd / || exit 1"));
  assert.ok(plan.command.includes("-ww"));
  assert.ok(!plan.command.includes("grep -v grep"));
  assert.equal(compileServiceInspection(source.replace('ps -p','ps -ww -p'))?.command,plan.command);
  assert.equal(compileServiceInspection(source.replace('printf "current="; ',''))?.command,plan.command);
});

test("never authorizes a partial snapshot, side effect, filename substitution or arbitrary process",()=>{
  for(const raw of [
    source.replace("nobody","root"), source.replace("runuser","/tmp/runuser"),
    source.replaceAll(target,"/tmp/../etc"),source.replace("shared/app.pid","../../etc/shadow"),
    source.replace('printf "pid="','printf -v PATH /tmp'),source.replace('printf "port="','echo "$(touch marker)"'),
    source.replace('readlink current','readlink current > leak'),source.replace('set -eu','export BASH_ENV=/tmp/hook'),
    source.replace('case "$port"','eval "$port"; case "$port"'),source+"; rm marker",
    source.replace('pid=$(/bin/cat shared/app.pid)','pid=$(sh /tmp/command)'),
    source.replace('/bin/grep -v grep','/bin/grep -v grep || touch marker'),
    source.replace('ss -ltnp "sport = :$port"','ss -ltnp'),source.replace('ps -p "$pid"','ps -p 1'),
  ]) assert.equal(compileServiceInspection(raw),undefined,raw);
});

test("old failed output must contain the corroborated PID, listener and terminal empty filter",()=>{
  const old="current=releases/v1\npid=321\nport=18443\nprocess:\n321\nlistener:\nLISTEN 0 5 127.0.0.1:18443  *:* users:((\"python3\",pid=321,fd=3))\nscoped processes:\n";
  assert.deepEqual(reportedServiceIdentity(old),{current:"releases/v1",pid:321,port:18443,address:"127.0.0.1"});
  for(const change of [old.replace('pid=321,fd','pid=1321,fd'),old.replace(':18443 ',':8443 '),old+'321 unrelated',old.replace('releases/v1','/etc/shadow')])
    assert.equal(reportedServiceIdentity(change),undefined);
});
