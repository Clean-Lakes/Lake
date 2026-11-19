export class TaskDeadlineReached extends Error {
  constructor(message = "原任务期限已到") { super(message); }
}

/** A host deadline is an absolute time. Node timers cannot hold longer than 2^31−1 ms. */
export function watchTaskDeadline(readDeadline: () => string, controller: AbortController) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    if (controller.signal.aborted) return;
    const remaining = Date.parse(readDeadline()) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) controller.abort(new TaskDeadlineReached());
    else timer = setTimeout(check, Math.min(remaining, 2 ** 31 - 1));
  };
  check();
  return () => clearTimeout(timer);
}
