import {HttpError} from "./store";

/** Two time-stamped Linux ps observations. Only identified executable/script
 * paths beneath the requested directory are returned, never other arguments. */
export function directoryProcessSample(directory: unknown) {
  if (typeof directory!=="string" || directory.length>512 ||
      !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(directory) ||
      directory.split("/").some(part=>part==="." || part==="..")) {
    throw new HttpError(400,"进程目录需要规范的绝对路径");
  }
  const script = [
    '[ "$(uname -s)" = Linux ] || exit 64',
    'for sample in 1 2; do',
    '  printf "sample=%s utc=%s cpu_unit=percent metric=ps_lifetime_average\\n" "$sample" "$(date -u +%FT%TZ)"',
    '  rows=$(ps -eo pid=,pcpu=,comm=,args=) || exit 69',
    '  printf "%s\\n" "$rows" | awk -v dir="$1/" \'',
    '    { for(i=4;i<=NF;i++) if(index($i,dir)==1 && $i ~ /^\\/[[:alnum:]_.\\/-]+$/) {',
    '      file="/proc/"$1"/stat"; if((getline stat < file)>0) {',
    '        sub(/^.*\\) /,"",stat); split(stat,fields," ");',
    '        printf "pid=%s start_ticks=%s cpu=%s executable=%s path=%s\\n",$1,fields[20],$2,$3,$i',
    '      } close(file); break',
    '    } }\'',
    '  if [ "$sample" = 1 ]; then sleep 2; fi',
    'done',
  ].join("\n");
  return {script, directory};
}
