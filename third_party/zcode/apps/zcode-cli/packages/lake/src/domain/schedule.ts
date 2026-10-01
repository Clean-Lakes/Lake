interface Field { values: Set<number>; wildcard: boolean }
function field(value: string, min: number, max: number): Field {
  const values = new Set<number>();
  for (const part of value.split(",")) {
    if (!/^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?$/u.test(part)) throw new Error("cron 字段无效");
    const [base, stride] = part.split("/"), step = stride ? Number(stride) : 1;
    let [start, end] = base === "*" ? [min, max] : base.split("-").map(Number);
    end ??= stride ? max : start;
    if (step < 1 || step > max - min + 1 || start < min || end > max || start > end) throw new Error("cron 范围或步长无效");
    for (let i = start; i <= end; i += step) values.add(i);
  }
  if (max === 7 && values.has(7)) values.add(0);
  return { values, wildcard: value === "*" };
}
export function nextSchedule(kind: string, expression: string, timezone: string, after: number): number {
  if (!Number.isSafeInteger(after) || expression.length > 256) throw new Error("计划时间或表达式无效");
  const zone = timezone === "Local" || !timezone ? Intl.DateTimeFormat().resolvedOptions().timeZone : timezone;
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat("en-US", { timeZone: zone, minute: "numeric", hour: "numeric", hourCycle: "h23", day: "numeric", month: "numeric", weekday: "short" }); } catch { throw new Error("无效的计划时区"); }
  if (kind === "once") {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(expression)) throw new Error("一次性计划时间必须是 RFC3339");
    const time = Date.parse(expression); if (!Number.isFinite(time) || time <= after) throw new Error("一次性计划时间无效或已过去"); return time;
  }
  if (kind !== "cron") throw new Error("计划类型必须是 once 或 cron");
  const pieces = expression.trim().split(/\s+/u), bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  if (pieces.length !== 5) throw new Error("cron 需要五个字段");
  const f = pieces.map((part, i) => field(part, bounds[i][0], bounds[i][1])), weeks = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let candidate = Math.floor(after / 60000) * 60000 + 60000;
  for (let i = 0; i < 2 * 366 * 24 * 60; i++, candidate += 60000) {
    const parts = Object.fromEntries(format.formatToParts(candidate).map(part => [part.type, part.value]));
    const day = f[2].values.has(Number(parts.day)), week = f[4].values.has(weeks.indexOf(parts.weekday)), match = f[2].wildcard ? week : f[4].wildcard ? day : day || week;
    if (match && f[0].values.has(Number(parts.minute)) && f[1].values.has(Number(parts.hour)) && f[3].values.has(Number(parts.month))) return candidate;
  }
  throw new Error("未来两年内没有符合条件的 cron 时间");
}
