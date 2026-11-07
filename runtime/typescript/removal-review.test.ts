import {test} from "node:test";
import assert from "node:assert/strict";
import {removalReviewScope} from "./removal-review";

test("a foreground unlink and bounded loopback checks can be reviewed, never a second effect or an injected command", () => {
  const dir="/tmp/lake-ops-fixture";
  const source = (suffix:string) => `runuser -u nobody -- /bin/bash -c 'test "$(id -u)" = 99 || exit 1; cd ${dir} || exit 1; test "$(<run.id)" = job && test "$(<maintenance)" = job || exit 1; rm -- maintenance || exit 1; ${suffix}'`;
  const probes = 'for n in 1 2 3; do printf "probe=%s time=" "$n"; date -u +%FT%TZ; result=$(curl --noproxy "*" --max-time 3 -sS -w "\\n%{http_code}" http://127.0.0.1:8000/health) || exit 1; printf "%s\\n" "$result"; test "$result" = "$(printf "job OK\\n200")" || exit 1; if test "$n" != 3; then sleep 2; fi; done';
  assert.deepEqual(removalReviewScope(source(probes)),{directory:dir,removedName:"maintenance"});
  for(const changed of ['rm -- second || exit 1', 'touch other', 'date -u > out', 'test "$(rm other)" = ok',
    'printf "%s" "$(whoami)"', 'result=$(curl -sS -k https://example.test/)', 'sleep 5 &', 'exit 0; rm -rf /tmp/other'])
    assert.equal(removalReviewScope(source(changed)),undefined);
});
