export function renderJsonResult(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}
export function resultExitCode(status: string): number {
  return status === "succeeded" || status === "verified"
    ? 0
    : status === "qualified"
      ? 2
      : status === "cancelled"
        ? 130
        : status === "waiting"
          ? 3
          : 1;
}

export function statusText(
  text: string,
  status: string,
  color = "auto",
): string {
  if (color === "never" || (color === "auto" && !process.stderr.isTTY))
    return text;
  const code =
    status === "succeeded"
      ? 32
      : status === "failed"
        ? 31
        : status === "waiting"
          ? 33
          : 36;
  return `\x1b[${code}m${text}\x1b[0m`;
}

// Remote output is text, never terminal instructions (including OSC hyperlinks).
export function terminalText(text: string): string {
  return text
    .replace(
      /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[ -/]*[@-~])/g,
      "",
    )
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function renderHostStatus(s: any): string {
  const gib = (n: number) => (n / 2 ** 30).toFixed(1) + " GiB";
  return [
    `本机 ${s.host.hostname} · ${s.host.platform}/${s.host.arch}`,
    `CPU ${s.cpu.usagePercent ?? "未知"}% · ${s.cpu.logicalCores} 核 · 负载 ${s.cpu.loadAverage.map((n: number) => n.toFixed(2)).join(" / ")}`,
    `内存 ${gib(s.memory.totalBytes)} · OS 空闲 ${gib(s.memory.freeBytes)}（缓存口径不同，空闲量不能单独判断内存压力）`,
    `磁盘 已用 ${s.disk.usedPercent ?? "未知"}% · 可用 ${gib(s.disk.availableBytes)} / ${gib(s.disk.totalBytes)}`,
    `运行时间 ${(s.uptimeSeconds / 3600).toFixed(1)} 小时`,
    `采集时间 ${s.observedAt}`,
  ].join("\n");
}

export function renderEvidenceReport(content: string): string {
  let report: any;
  try {
    report = JSON.parse(content);
  } catch {
    return terminalText(content);
  }
  if (typeof report.summary === "string" && report.summary.trim())
    return terminalText(report.summary);
  if (!Array.isArray(report.findings)) return terminalText(content);
  const lines: string[] = [];
  for (const finding of report.findings) {
    const value = finding.value?.execution ?? finding.value;
    if (value?.source === "local-system-status")
      lines.push(renderHostStatus(value));
    else
      lines.push(
        `${finding.source} · ${finding.observedAt}\n${JSON.stringify(value, null, 2).slice(0, 8000)}`,
      );
  }
  if (!lines.length) lines.push(`任务：${report.objective ?? ""}`);
  if (report.gaps?.length)
    lines.push(
      `尚未确认：${report.gaps.map((g: any) => (typeof g === "string" ? g : JSON.stringify(g))).join("；")}`,
    );
  lines.push(
    `验收：${report.delivery?.status === "verified" ? "已验证" : "部分验证"}`,
  );
  return terminalText(lines.join("\n\n"));
}
