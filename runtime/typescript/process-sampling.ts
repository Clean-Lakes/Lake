import {HttpError} from "./store";

/** Emit two Linux ps observations without returning unrelated command arguments. */
export function directoryProcessSample(directory: unknown) {
  if (typeof directory !== "string" || directory.length > 512 ||
      !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(directory) ||
      directory.split("/").some(part => part === "." || part === "..")) {
    throw new HttpError(400, "进程目录需要规范的绝对路径");
  }

  // Older procps truncates even the format columns when SSH has no tty.
  // An interpreter installed under the target can also run scripts elsewhere.
  const script = String.raw`
[ "$(uname -s)" = Linux ] || exit 64
for sample in 1 2; do
  printf 'sample=%s utc=%s cpu_unit=percent metric=ps_lifetime_average\n' "$sample" "$(date -u +%FT%TZ)"
  rows=$(ps -eww -o pid=,pcpu=,comm=,args=) || exit 69
  printf '%s\n' "$rows" | awk -v dir="$1/" '
    function within(path) {
      return index(path,dir)==1 && path ~ /^\/[[:alnum:]_.\/-]+$/ && path !~ /\/(\.\.?)(\/|$)/
    }
    $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+([.][0-9]+)?$/ && NF>=4 {
      haveRows=1; path=""
      if ($3 ~ /^(python([0-9]+([.][0-9]+)*)?|pythonw|pypy[0-9]*)$/) {
        # Python -c and -m have no script operand. Only the interpreter itself
        # can match in those cases, never an argument passed to the program.
        i=5
        while (i<=NF && $i ~ /^-[bBEiIOPqsSuvx]+$/) i++
        if ($i=="--") i++
        if (i<=NF && within($i)) path=$i
        else if (within($4)) path=$4
      } else {
        for (i=4;i<=NF;i++) if (within($i)) {path=$i;break}
      }
      if (!path) next
      file="/proc/"$1"/stat"
      if ((getline stat < file)>0) {
        sub(/^.*\) /,"",stat); split(stat,fields," ")
        if (fields[20] ~ /^[0-9]+$/)
          printf "pid=%s start_ticks=%s cpu=%s executable=%s path=%s\n",$1,fields[20],$2,$3,path
      }
      close(file)
    }
    END { if (!haveRows) exit 69 }
  ' || exit 69
  if [ "$sample" = 1 ]; then sleep 2; fi
done`.trim();
  return {script, directory};
}
