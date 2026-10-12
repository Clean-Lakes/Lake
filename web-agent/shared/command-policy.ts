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
      if (!/\s/.test(c)) { const doubled = command[i + 1] === c && c !== ";"; words.push({ word: doubled ? c + command[++i] : c, operator: true }); }
    } else { word += c; started = true; }
  }
  if (started) words.push({ word, operator: false });
  return { words, dynamic: dynamic || !!mode, substitution };
}

export function commandPolicy(command: string): CommandPolicy {
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
    if (dangerPrograms.has(program) || program.startsWith("mkfs.") ||
      (["sh", "bash", "zsh", "fish", "python", "python3", "perl", "ruby", "node", "awk", "eval", "exec", "source", ".", "env", "command", "xargs", "nice", "timeout", "nohup"].includes(program)) ||
      (program === "find" && args.some(arg => /^-(?:delete|exec|execdir|ok|okdir)$/.test(arg))) ||
      (["systemctl", "service", "launchctl", "docker", "kubectl"].includes(program) && args.some(arg => /^(?:stop|restart|kill|delete|rm|down|bootout|unload|scale|apply|exec)$/.test(arg)))) dangerous = true;
  }
  if (dangerous) return { risk: "dangerous", riskReason: sensitive ? "可能访问凭据或直接操作磁盘，需要明确确认目标。" : "可能删除数据、影响服务、提升权限或执行任意代码，需要再次确认目标。" };
  if (parsed.words.some(token => token.operator && /^[<>]+$/.test(token.word))) return { risk: "write", riskReason: "命令包含重定向，可能读写文件或改变输出目标。" };
  if (parsed.dynamic || parsed.words.some(token => token.operator && token.word === "&") || groups.some(group => !group.length)) return { risk: "write", riskReason: "包含动态展开、后台运行或复杂 Shell 语法，无法可靠判定为只读。" };

  for (const group of groups) {
    const path = group[0]!, program = path.split("/").at(-1)!;
    const args = group.slice(1);
    let safe = readPrograms.has(program) && (!path.includes("/") || /^\/(?:usr\/)?s?bin\/[^/]+$/.test(path));
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
  const safeCommand = groups.map((group, index) => `${index ? joins[index - 1] + " " : ""}command -p ${group.map(quote).join(" ")}`).join(" ");
  return { risk: "readonly", riskReason: "完整命令仅包含可识别的只读检查，无写入或危险操作。", safeCommand };
}

export const dangerConfirmation = (resourceName: string) => `执行 ${resourceName}`;
