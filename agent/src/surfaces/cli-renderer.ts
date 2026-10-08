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
