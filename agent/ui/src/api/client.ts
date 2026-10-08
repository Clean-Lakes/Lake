let token = "";
export async function initializeAuth(): Promise<void> {
  const fragment = new URLSearchParams(window.location.hash.slice(1)),
    ticket = fragment.get("bootstrap");
  window.history.replaceState(null, "", window.location.pathname);
  const response = await fetch(
    "/api/v1/bootstrap/" + (ticket ? "exchange" : "session"),
    ticket
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticket }),
        }
      : { credentials: "same-origin" },
  );
  if (!response.ok) throw new Error("请通过 lake open 打开工作台。");
  const data = await response.json();
  token = data.token;
}
export function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer " + token };
}
export async function api<T = any>(
  method: string,
  path: string,
  data?: unknown,
  expectedRevision = 0,
): Promise<T> {
  const response = await fetch("/api/v1/" + path, {
    method,
    headers: {
      ...authHeaders(),
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST"
      ? {
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            expectedRevision,
            data,
          }),
        }
      : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? "请求失败");
  return value;
}
