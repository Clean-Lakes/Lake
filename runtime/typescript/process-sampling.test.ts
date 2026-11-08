import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {directoryProcessSample} from "./process-sampling";

test("SSH without a tty requests full-width ps rows and identifies a script before its scoped Python interpreter", t => {
  const dir=mkdtempSync(join(tmpdir(), "lake-process-sample-"));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const root="/tmp/lake-ops-UK-fixture";
  const python=root+"/.qa-runtime/bin/python3";
  const script=root+"/cpu_probe.py";
  const rows=[
    `101 19.6 python3 ${python} -I -u -- ${script} private-value`,
    `102 10.0 python3 /usr/bin/python3 -c pass ${root}/unrelated.py`,
    `103 10.1 python3 /usr/bin/python3 -m pkg ${root}/unrelated.py`,
    `104 0.0 native ${root}/native --key private-value`,
    `105 0.1 python3 /usr/bin/python3 ${root}/../elsewhere/other.py`,
  ].join("\n");
  for(const pid of [101,102,103,104,105]){
    mkdirSync(join(dir,String(pid)));
    // Field 22 of /proc/PID/stat is the task start time, after a parenthesized
    // comm which is itself allowed to contain spaces and closing parentheses.
    writeFileSync(join(dir,String(pid),"stat"),`${pid} (example ) process) S ${Array(18).fill(0).join(" ")} 72342\n`);
  }
  const tool=(name:string,body:string)=>writeFileSync(join(dir,name),"#!/bin/sh\n"+body+"\n",{mode:0o700});
  tool("uname","echo Linux");
  tool("sleep",":");
  tool("ps",`if [ "$*" != "-eww -o pid=,pcpu=,comm=,args=" ]; then echo 101; exit 0; fi
cat <<'ROWS'
${rows}
ROWS`);
  // Provide private synthetic procfs data to the unmodified system awk.
  const cmd=directoryProcessSample(root).script.replace('file="/proc/"',`file="${dir}/"`);
  const shell=()=>spawnSync("/bin/sh",["-c",cmd,"lake-sample",root],{env:{PATH:dir+":/usr/bin:/bin",LC_ALL:"C"},encoding:"utf8"});
  const result=shell();
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.split(`pid=101 start_ticks=72342 cpu=19.6 executable=python3 path=${script}\n`).length-1,2);
  assert.equal(result.stdout.split("pid=104 ").length-1,2);
  assert.doesNotMatch(result.stdout,/private-value|unrelated|\.qa-runtime|elsewhere|pid=(102|103|105)/);
  tool("ps","echo 101");
  assert.equal(shell().status,69,"Malformed or truncated ps rows are a collection failure");
});
