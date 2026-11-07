// Eligibility for an operator review, never a dispatch policy. Only a foreground
// single-file unlink and bounded observations are supported. Parse a small
// literal grammar rather than treating arbitrary shell after rm as a probe.
export function removalReviewScope(command: string) {
  const shell = /^runuser -u nobody -- \/bin\/bash -c '([^'\n\r]{1,8192})'$/.exec(command);
  if (!shell) return;
  const clauses = shell[1]!.split(";").map(part => part.trim());
  const atom = /^(?:[A-Za-z0-9_.:%+-]+|"[A-Za-z0-9_.:%+ -]+"|"\$[A-Za-z_][A-Za-z0-9_]*"|"\$\(id -u\)"|"\$\(<[A-Za-z0-9_][A-Za-z0-9_.-]*\)"|"\$\(printf "[A-Za-z0-9 _.:%+\\-]+"\)")$/;
  const assertion = (statement: string) => statement.split(" && ").every(part => {
    const args = /^test (.+?) (?:=|!=) (.+)$/.exec(part);
    return !!args && atom.test(args[1]!) && atom.test(args[2]!);
  });
  let directory: string | undefined, removedName: string | undefined;
  for (let clause of clauses) {
    const cd = /^cd (?:-- )?(\/[A-Za-z0-9_./-]+) \|\| exit [1-9][0-9]?$/.exec(clause);
    if (cd) {
      if (directory || removedName || cd[1]!.split("/").slice(1).some(part => !part || part === "." || part === "..")) return;
      directory = cd[1]; continue;
    }
    const removal = /^rm -- ([A-Za-z0-9_][A-Za-z0-9_.-]*) \|\| exit [1-9][0-9]?$/.exec(clause);
    if (removal) {
      if (!directory || removedName) return;
      removedName = removal[1]; continue;
    }
    clause = clause.replace(/ \|\| exit [1-9][0-9]?$/, "");
    if (assertion(clause)) continue;
    if (!removedName) return;
    if (/^(?:fi|done)$/.test(clause) || /^for [a-zA-Z_][\w]* in(?: [0-9]{1,2}){1,12}$/.test(clause)) continue;
    clause = clause.replace(/^(?:if|do|then) /, "");
    if (assertion(clause) || /^sleep [0-9]{1,2}$/.test(clause) || /^date -u(?: \+[A-Za-z0-9:%+._-]+)?$/.test(clause) ||
        /^printf "[A-Za-z0-9% :=+._\\-]+"(?: "\$[A-Za-z_][\w]*"){0,4}$/.test(clause)) continue;
    // No redirects, proxy, headers, authentication, uploads, alternate config or
    // client-supplied shell in the optional loopback GET.
    if (/^[a-zA-Z_][\w]*=\$\(curl (?:(?:--noproxy "\*"|--max-time [1-9][0-9]?|-sS|-s|-w "(?:\\n)?%\{http_code\}") )+http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[A-Za-z0-9._\/-]*\)$/.test(clause)) continue;
    return;
  }
  if (directory && removedName) return {directory, removedName};
}
