export type CommandRisk = "readonly" | "write" | "dangerous";
export type CommandPolicy = { risk: CommandRisk; riskReason: string; safeCommand?: string };

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const dangerPrograms = new Set(["sudo", "su", "doas", "rm", "rmdir", "shred", "dd", "mkfs", "wipefs", "fdisk", "parted", "shutdown", "reboot", "halt", "poweroff", "kill", "killall", "pkill", "chmod", "chown", "chgrp", "chattr"]);
const readPrograms = new Set(["pwd", "uname", "uptime", "df", "du", "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "find", "ps", "free", "vmstat", "vm_stat", "iostat", "top", "date", "hostname", "whoami", "id", "who", "w", "stat", "file", "readlink", "printf", "echo", "true", "false", "sleep"]);

/** Parse only literal POSIX words and simple command chains. Unsupported syntax never auto-runs. */
function tokenize(command: string): { words: Array<{ word: string; operator: boolean }>; dynamic: boolean; substitution: boolean } {
  const words: Array<{ word: string; operator: boolean }> = [];
  let word = "", started = false, mode = "", dynamic = false, substitution = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (mode === "'") { if (c === "'") mode = ""; else word += c; continue; }
    if (c === "\\") {
      const next = command[++i];
      if (!next) { dynamic = true; break; }
      if (mode === '"' && !['$', '`', '"', '\\'].includes(next)) word += "\\";
      word += next; started = true; continue;
    }
    if (c === "'" && !mode) { mode = "'"; started = true; continue; }
    if (c === '"') { mode = mode ? "" : '"'; started = true; continue; }
    if (c === "`" || (c === "$" && command[i + 1] === "(")) substitution = true;
    if (c === "$" || c === "`" || (!mode && /[(){}*?\[\]~#]/.test(c))) dynamic = true;
    if (!mode && (/\s/.test(c) || /[|&;<>]/.test(c))) {
      if (started) { words.push({ word, operator: false }); word = ""; started = false; }
      if (c === "\n" || c === "\r") words.push({word:";",operator:true});
      else if (!/\s/.test(c)) { const doubled = command[i + 1] === c && c !== ";"; words.push({ word: doubled ? c + command[++i] : c, operator: true }); }
    } else { word += c; started = true; }
  }
  if (started) words.push({ word, operator: false });
  return { words, dynamic: dynamic || !!mode, substitution };
}

const temporaryPath = /^\/tmp\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,80}(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

/** The human request must name the complete directory, rather than a prefix,
 * neighboring path, or URL. The resource binding is checked by the caller. */
export function requestedInspectionRoot(path: string, requests: readonly string[]) {
  if (!temporaryPath.test(path)) return false;
  const root = path.split("/").slice(0,3).join("/");
  const literal = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mention = new RegExp("(?<![a-zA-Z0-9_./:@-])" + literal + "(?![a-zA-Z0-9_./-])");
  return requests.some(request => mention.test(request));
}
const inventoryFormat = "%y %s %p\\n";
export type NobodyInspection = { command: string; directory: string; inventoryDepth?: number };

/** A deliberately small util-linux SSH compiler. The outer identity and all
 * programs/options/data words are regenerated, never copied as a shell script. */
export function compileNobodyInspection(source: string): NobodyInspection | undefined {
  if (source.length > 8192 || /[\0\r\n]/.test(source)) return;
  const outer = /^(?:\/(?:usr\/)?sbin\/)?runuser -u nobody -- \/bin\/bash -c '([^']+)'$/.exec(source);
  if (!outer) return;
  const parsed = tokenize(outer[1]!);
  if (parsed.dynamic || parsed.substitution || parsed.words.length > 128) return;
  const groups: string[][] = [[]], joins: string[] = [];
  for (const token of parsed.words) {
    if (!token.operator) groups.at(-1)!.push(token.word);
    else if ([";", "&&"].includes(token.word)) { joins.push(token.word); groups.push([]); }
    else return;
  }
  const render: string[] = [];
  let directory: string | undefined, inventoryDepth: number | undefined;
  for (const [i, group] of groups.entries()) {
    const [name,...args] = group;
    if (!name) return;
    const program = name.replace(/^\/usr\/bin\//,"");
    const paths = args.filter(v=>v.startsWith("/"));
    for (const path of paths) {
      if (program === "df" && path === "/") continue;
      if (!temporaryPath.test(path)) return;
      const root=path.split("/").slice(0,3).join("/");
      if (directory && directory!==root) return;
      directory=root;
    }
    let valid = false;
    if (program==="id") valid=!args.length || args.length===1 && ["-u","-g"].includes(args[0]!);
    if (program==="find") {
      valid = args.length===5 && temporaryPath.test(args[0]!) && args[1]==="-maxdepth" && /^[0-8]$/.test(args[2]!) &&
        args[3]==="-printf" && args[4]===inventoryFormat;
      if(valid && args[0]===directory && i===2 && groups.length===3 &&
        groups[0]!.join(" ")==="id" && groups[1]!.join(" ")==="ls -la "+directory && joins.every(j=>j===";"))
        inventoryDepth=Number(args[2]);
    }
    if (["ls","du","df","wc","nl","sha256sum","cat"].includes(program)) {
      const options: Record<string,string[]> = {ls:["","-la","-l","-al"],du:["-sk","-ks","-sh"],df:["-Pk","-kP"],
        wc:["-c","-l"],nl:["-ba"],sha256sum:[""],cat:[""]};
      const index=args.findIndex(v=>v.startsWith("/"));
      const optionsIn = args.slice(0,index);
      if (optionsIn.at(-1)==="--") optionsIn.pop();
      valid = index>=0 && args.length-index<=8 && options[program]!.includes(optionsIn.join(" ")) &&
        args.slice(index).every(v=>temporaryPath.test(v) || program==="df" && v==="/");
    }
    if (!valid) return;
    render.push((i ? joins[i-1]+" " : "")+"/usr/bin/"+program+" "+args.map(quote).join(" "));
  }
  if(!directory) return;
  const clean="/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/bin LC_ALL=C";
  const script="builtin cd -- / || exit 1; "+render.join(" ");
  return {directory,inventoryDepth,command:clean+" /usr/sbin/runuser -u nobody -- "+clean+" /bin/bash --noprofile --norc -c "+quote(script)};
}

/** Rebuild a literal sleep and one line of output as nobody. No user shell or
 * inherited environment runs, and the command never opens a file or a network connection. */
export function compileNobodyDelay(source: string): string | undefined {
  if (source.length > 2048 || /[\0\r\n]/.test(source)) return;
  const outer = tokenize(source);
  if (outer.dynamic || outer.substitution || outer.words.length !== 7 || outer.words.some(t => t.operator)) return;
  const [command, flag, user, separator, shell, option, body] = outer.words.map(t => t.word);
  if (!["runuser", "/usr/sbin/runuser", "/sbin/runuser"].includes(command!) ||
      flag !== "-u" || user !== "nobody" || separator !== "--" ||
      !["/bin/sh", "/bin/bash"].includes(shell!) || option !== "-c") return;

  const inner = tokenize(body!);
  if (inner.dynamic || inner.substitution || inner.words.some((t, index) => t.operator !== (index === 2))) return;
  const [sleep, duration, join, printf, format, argument] = inner.words.map(t => t.word);
  if (!["sleep", "/usr/bin/sleep", "/bin/sleep"].includes(sleep!) || !/^(?:0|[1-9]\d{0,2})$/.test(duration ?? "") ||
      Number(duration) > 600 || !["&&", ";"].includes(join!) || !["printf", "/usr/bin/printf"].includes(printf!)) return;

  let line: string;
  if (inner.words.length === 6 && format === "%s\\n") line = argument!;
  else if (inner.words.length === 5 && format?.endsWith("\\n") && !/[\\%]/.test(format.slice(0,-2))) line = format.slice(0,-2);
  else return;
  if (line.length > 256 || /[\u0000-\u001f\u007f]/.test(line)) return;
  const clean = "/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C";
  const script = `/usr/bin/sleep ${duration} ${join} /usr/bin/printf '%s\\n' ${quote(line)}`;
  return `${clean} /usr/sbin/runuser -u nobody -- ${clean} /bin/sh -c ${quote(script)}`;
}

function literalFileInspection(program:string,args:string[],requests:readonly string[]) {
  if (!["nl","sha256sum"].includes(program)) return false;
  const paths = program==="nl" ? args[0]==="-ba" ? args.slice(1) : [] : args;
  const files = paths[0]==="--" ? paths.slice(1) : paths;
  return files.length>0 && files.length<=8 && files.every(path=>requestedInspectionRoot(path,requests));
}

function programLookup(group: string[]): boolean {
  return (
    group[0] === "command" &&
    ["-v", "-V"].includes(group[1] ?? "") &&
    group.length >= 3 &&
    group
      .slice(2)
      .every((word) => /^[A-Za-z_][A-Za-z0-9_.+-]{0,127}$/.test(word))
  );
}

/** Narrow compatibility proof, not the broader confirmation-only inspection grammar. */
export function isLiteralProgramDiscovery(command: string): boolean {
  const parsed = tokenize(command),
    groups: string[][] = [[]];
  if (parsed.dynamic || parsed.substitution || parsed.words.length > 128)
    return false;
  for (const token of parsed.words) {
    if (!token.operator) groups.at(-1)!.push(token.word);
    else if ([";", "&&", "||"].includes(token.word)) groups.push([]);
    else return false;
  }
  return (
    groups.some(programLookup) &&
    groups.every(
      (group) =>
        programLookup(group) || (group.length === 1 && group[0] === "hostname"),
    )
  );
}

function compileLookup(group: string[]): string {
  // -p must not replace the PATH being inspected. Pass it as data into a fresh
  // standard shell, bypassing user functions without losing /usr/local/bin etc.
  const script = 'PATH=$1; export PATH; shift; command "$@"';
  return `command -p sh -c ${quote(script)} lake-program-lookup "$PATH" ${group.map(quote).join(" ")}`;
}

// These bounded adapters only decide whether an *additional* danger prompt is
// needed when ordinary commands are already authorized. They never confer a
// readonly proof, a task grant, or permission to bypass an explicit project rule.
const inspectionPrograms = new Set([
  ...readPrograms,
  "cut",
  "sort",
  "printenv",
  "which",
  "test",
  "[",
]);
const shellControls = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
]);
function mysqlInspection(args: string[]): boolean {
  if (args.length === 1 && ["--version", "-V"].includes(args[0]!)) return true;
  const queries: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--execute="))
      queries.push(args[i]!.slice("--execute=".length));
    else if (args[i] === "--execute" || /^-[NBsr]*e$/.test(args[i]!))
      queries.push(args[++i] ?? "");
    if (
      /^--(?:init-command|init-command-add|execute-command|plugin-dir|defaults-file|defaults-extra-file)(?:=|$)/.test(
        args[i] ?? "",
      )
    )
      return false;
  }
  return (
    queries.length > 0 &&
    queries.every(
      (sql) =>
        sql.trim() &&
        !/[\r\n]|\\(?![0bnrtZgG\\'"_%])/.test(sql) &&
        sql
          .split(";")
          .filter((part) => part.trim())
          .every((part) =>
            /^\s*(?:SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|CHECKSUM\s+TABLE)\b/i.test(
              part,
            ),
          ) &&
        !/\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|CALL|DO|SET|LOAD|OUTFILE|DUMPFILE|INTO|FOR\s+UPDATE|SYS_EXEC|SYS_EVAL|LOAD_FILE)\b/i.test(
          sql,
        ),
    )
  );
}
function inspectionScript(script: string, depth: number): boolean {
  if (depth > 4) return false;
  const parsed = tokenize(script);
  if (parsed.substitution || parsed.words.length > 1000) return false;
  const groups: string[][] = [[]];
  for (const token of parsed.words) {
    if (token.operator) {
      if (!["|", "&&", "||", ";"].includes(token.word)) return false;
      groups.push([]);
    } else groups.at(-1)!.push(token.word);
  }
  if (groups.at(-1)?.length === 0) groups.pop();
  return (
    groups.length > 0 &&
    groups.every((group) => inspectionGroup(group, depth + 1))
  );
}
function execPayload(group: string[]): string[] | undefined {
  const [program, ...args] = group;
  if (program === "docker") {
    if (args[0] !== "exec") return;
    let i = 1;
    while (["-i", "-t", "-it", "-ti"].includes(args[i] ?? "")) i++;
    if (args[i] === "--") i++;
    if (!/^[\w][\w.-]*$/.test(args[i] ?? "")) return;
    return args.slice(i + 1);
  }
  if (program !== "kubectl") return;
  let i = 0;
  const option = () => {
    const word = args[i] ?? "";
    if (
      [
        "-n",
        "--namespace",
        "--context",
        "--kubeconfig",
        "--request-timeout",
        "-c",
        "--container",
      ].includes(word) &&
      args[i + 1] &&
      !args[i + 1]!.startsWith("-")
    ) {
      i += 2;
      return true;
    }
    if (
      /^(?:--namespace|--context|--kubeconfig|--request-timeout|--container)=.+$/.test(
        word,
      ) ||
      ["-i", "-t", "-it", "-ti"].includes(word)
    ) {
      i++;
      return true;
    }
    return false;
  };
  while (i < args.length && args[i] !== "exec") {
    if (!option()) return;
  }
  if (args[i++] !== "exec") return;
  let pod = false;
  while (i < args.length && args[i] !== "--") {
    if (option()) continue;
    if (pod || !/^(?:pods?\/)?[\w][\w.-]*$/.test(args[i] ?? "")) return;
    pod = true;
    i++;
  }
  return pod && args[i] === "--" ? args.slice(i + 1) : undefined;
}
function inspectionGroup(original: string[], depth = 0): boolean {
  if (depth > 4) return false;
  let group = original;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(group[0] ?? "")) {
    if (!group[0]!.startsWith("MYSQL_PWD=")) return false;
    group = group.slice(1);
  }
  const [program, ...args] = group;
  if (
    !program ||
    shellControls.has(program) ||
    (group !== original && !["mysql", "mariadb"].includes(program))
  )
    return false;
  if (program === "command") return programLookup(group);
  if (["sh", "bash"].includes(program))
    return (
      args.length === 2 &&
      ["-c", "-lc"].includes(args[0]!) &&
      inspectionScript(args[1]!, depth + 1)
    );
  if (["kubectl", "docker"].includes(program)) {
    const inner = execPayload(group);
    return !!inner?.length && inspectionGroup(inner, depth + 1);
  }
  if (["mysql", "mariadb"].includes(program)) return mysqlInspection(args);
  if (!inspectionPrograms.has(program) || dangerPrograms.has(program))
    return false;
  if (
    program === "find" &&
    args.some((arg) =>
      /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(
        arg,
      ),
    )
  )
    return false;
  if (
    program === "sort" &&
    args.some(
      (arg) =>
        arg === "-o" ||
        arg.startsWith("--output") ||
        arg.startsWith("--compress-program"),
    )
  )
    return false;
  if (program === "printf" && args[0] === "-v") return false;
  if (
    program === "date" &&
    !args.every((arg) => arg === "-u" || arg === "--utc" || arg.startsWith("+"))
  )
    return false;
  return true;
}

export function commandPolicy(command: string, requests: readonly string[] = []): CommandPolicy {
  const parsed = tokenize(command);
  const sensitive = /(?:\.lake\/secrets|\.ssh\/(?:id_|.*\.pem)|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|(?:^|[\/\s])\.env(?:\b|\.)|keychain|\/dev\/(?:disk|sd[a-z]|nvme))/i.test(command);
  const groups: string[][] = [[]];
  const joins: string[] = [];
  for (const { word, operator } of parsed.words) {
    if (operator && ["|", "&&", "||", ";"].includes(word)) { joins.push(word); groups.push([]); }
    else groups.at(-1)!.push(word);
  }
  let dangerous = sensitive || parsed.substitution;
  for (const group of groups) {
    const program = group[0]?.split("/").at(-1) ?? "";
    const args = group.slice(1);
    // Lookup and bounded inspection wrappers follow the ordinary-command switch.
    // Unknown scripts and explicit destructive operations still require confirmation.
    const inspection = inspectionGroup(group);
    if (dangerPrograms.has(program) || program.startsWith("mkfs.") ||
      (["sh", "bash", "zsh", "fish", "python", "python3", "perl", "ruby", "node", "awk", "eval", "exec", "source", ".", "env", "command", "xargs", "nice", "timeout", "nohup"].includes(program) && !inspection) ||
      (program === "find" && args.some(arg => /^-(?:delete|exec|execdir|ok|okdir)$/.test(arg))) ||
      (["systemctl", "service", "launchctl", "docker", "kubectl"].includes(program) && args.some(arg => /^(?:stop|restart|kill|delete|rm|down|bootout|unload|scale|apply|exec)$/.test(arg)) && !inspection)) dangerous = true;
  }
  if (dangerous) return { risk: "dangerous", riskReason: sensitive ? "可能访问凭据或直接操作磁盘，需要明确确认目标。" : "可能删除数据、影响服务、提升权限或执行任意代码，需要再次确认目标。" };
  if (parsed.words.some(token => token.operator && /^[<>]+$/.test(token.word))) return { risk: "write", riskReason: "命令包含重定向，可能读写文件或改变输出目标。" };
  if (parsed.dynamic || parsed.words.some(token => token.operator && token.word === "&") || groups.some(group => !group.length)) return { risk: "write", riskReason: "包含动态展开、后台运行或复杂 Shell 语法，无法可靠判定为只读。" };

  for (const group of groups) {
    const path = group[0]!, program = path.split("/").at(-1)!;
    const args = group.slice(1);
    let safe = (readPrograms.has(program) && (!path.includes("/") || /^\/(?:usr\/)?s?bin\/[^/]+$/.test(path))) || programLookup(group) || (path===program || path==="/usr/bin/"+program) && literalFileInspection(program,args,requests);
    if (program === "date") safe &&= args.every(arg => arg === "-u" || arg === "--utc" || arg.startsWith("+"));
    if (program === "hostname") safe &&= args.every(arg => ["-f", "-s", "-d", "-i", "-I", "-a", "--fqdn"].includes(arg));
    if (program === "file") safe &&= !args.some(arg => arg === "--compile" || /^-[^-]*C/.test(arg));
    if (program === "find") safe &&= !args.some(arg => /^-(?:fprint|fprint0|fprintf|fls)$/.test(arg));
    if (program === "top") safe &&= args.length > 0 && args.some((arg, i) => ["-l", "-n"].includes(arg) && /^[1-9]\d?$/.test(args[i + 1] ?? "")) && args.every(arg => /^(?:-b|-l|-n|-d|-s|\d+(?:\.\d+)?)$/.test(arg));
    if (["grep", "egrep", "fgrep"].includes(program)) safe &&= !args.some(arg => /^--(?:pre|pre-glob)=/.test(arg));
    if (program === "printf") safe &&= args[0] !== "-v";
    if (!safe) return { risk: "write", riskReason: "该程序或参数可能改变状态，或暂不能可靠判定为只读；请先核对影响。" };
  }
  // command -p bypasses user-defined functions and a modified PATH in the persistent shell.
  const safeCommand = groups.map((group, index) => `${index ? joins[index - 1] + " " : ""}${programLookup(group) ? compileLookup(group) : `command -p ${group.map(quote).join(" ")}`}`).join(" ");
  return { risk: "readonly", riskReason: "完整命令仅包含可识别的只读检查，无写入或危险操作。", safeCommand };
}

export const dangerConfirmation = (resourceName: string) => `执行 ${resourceName}`;
