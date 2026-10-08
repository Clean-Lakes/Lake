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
