import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import type { Catalog, SessionSnapshot, TerminalSession, WorkSession, Project } from "../../shared/contracts.js";
const sleep = (ms: number) => new Promise<void>(yes => setTimeout(yes, ms));
async function freePort() { const s = createServer(); await new Promise<void>(yes => s.listen(0, "127.0.0.1", yes)); const p = (s.address() as { port: number }).port; await new Promise<void>(yes => s.close(() => yes())); return p; }
async function until<T>(fn: () => Promise<T | null>, timeout = 10000): Promise<T> { const end = Date.now() + timeout; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); } throw Error("Go AI fixture timed out"); }
async function fixture(model: Server) {
  const port = await freePort(); const dir = mkdtempSync(join(tmpdir(), "lake-go-ai-")); const token = "local-fixture-access-token";
  const env = { ...process.env, LAKE_HOME: dir, LAKE_WEB_DATA_DIR: dir, LAKE_WEB_PORT: String(port), LAKE_WEB_TOKEN: token, LAKE_WEB_AI_RUNTIME: "go", LAKE_WEB_DEV_ORIGIN: "", LAKE_WEB_MODEL_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1/chat/completions`, LAKE_WEB_MODEL_NAME: "fixture", LAKE_WEB_MODEL_KEY: "", LAKE_AI_BACKEND: resolve(import.meta.dirname, "../../dist/lake-ai") };
  let child: ChildProcess; let logs = "";
  const start = () => { child = spawn(process.execPath, ["--import", resolve(import.meta.dirname, "../../node_modules/tsx/dist/loader.mjs"), resolve(import.meta.dirname, "../src/index.ts")], { env, stdio: ["ignore", "pipe", "pipe"] }); logs = ""; child.stdout?.on("data", b => { logs += String(b); }); child.stderr?.on("data", () => {}); };
  start(); await until(async () => logs.includes("listening at") ? true : null);
  const request = async <T>(path: string, data?: object, method = data ? "POST" : "GET", status = 200): Promise<T> => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(data ? { "Content-Type": "application/json" } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }); if (r.status !== status) throw Error(`${path}: HTTP ${r.status}: ${await r.text()}`); return r.json() as Promise<T>; };
  const stop = async () => { const ended = new Promise<void>(yes => child.once("exit", () => yes())); child.kill("SIGTERM"); await ended; };
  return { dir, request, image: (path: string, authorized = true) => fetch(`http://127.0.0.1:${port}${path}`, { headers: authorized ? { Authorization: `Bearer ${token}` } : {} }), restart: async () => { await stop(); start(); await until(async () => logs.includes("listening at") ? true : null); }, cleanup: async () => { await stop(); rmSync(dir, { recursive: true, force: true }); } };
}
void test("Go backend is the default AI path: stream, tools, frozen approval, profiles and restart", async () => {
  let path = ""; let hostId = ""; let scenario = "";
  const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSqoAAAAASUVORK5CYII=";
  const model = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const data = JSON.parse(raw) as { messages: Array<{ role: string; content: string | Array<{type: string; image_url?: {url: string}}> ; tool_call_id?: string }>; tools?: Array<{ function: { name: string } }> };
    const last = data.messages.at(-1)!;
    let content = "Go 回答"; let call: { id: string; name: string; args: object } | undefined;
    if (last.role === "user" && scenario === "image") { assert(Array.isArray(last.content)); assert(last.content.some(part => part.image_url?.url.includes(imageBase64))); content = "已收到图片"; }
    if (last.role === "user" && scenario === "write") call = { id: "write-file", name: "write", args: { path, content: "approved-content" } };
    if (last.role === "user" && scenario === "assets") call = { id: "assets", name: "list_assets", args: { pattern: "" } };
    if (last.role === "user" && scenario === "terminal") { assert(data.tools?.some(t => t.function.name === "terminal_execute_command")); call = { id: "terminal", name: "terminal_execute_command", args: { command: "uname -s", intent: "读取系统类型" } }; }
    if (last.role === "user" && scenario === "cancel") { response.writeHead(200, { "Content-Type": "text/event-stream" }); response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`); request.on("close", () => {}); return; }
    if (last.role === "tool") { assert(typeof last.content === "string"); if (last.tool_call_id === "assets") { assert(last.content.includes("Local machine")); assert.match(last.content, /a_[0-9a-f]{16}/); content = "已发现会话资源"; } else if (last.tool_call_id === "terminal") { assert(last.content.includes("Darwin") || last.content.includes("Linux")); content = "已读取系统类型"; } else content = "文件已按审批更新"; }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "核对目标" } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: call ? { tool_calls: [{ index: 0, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content }, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(yes => model.listen(0, "127.0.0.1", yes)); const app = await fixture(model);
  try {
    const bootstrap = await app.request<{ aiRuntime: string }>("/api/bootstrap"); assert.equal(bootstrap.aiRuntime, "go");
    const project = await app.request<Project>("/api/projects", { name: "Go AI" }, "POST", 201);
    const catalog = await app.request<Catalog>("/api/catalog"); hostId = catalog.resources[0]!.id;
    const db = await app.request<{ id: string }>(`/api/projects/${project.id}/resources`, { name: "SQLite", kind: "database", settings: { driver: "sqlite", path: join(app.dir, "fixture.sqlite") } }, "POST", 201);
    const session = await app.request<WorkSession>(`/api/projects/${project.id}/sessions`, { title: "Go case", resourceIds: [hostId, db.id] }, "POST", 201);
    const root = `/api/sessions/${session.id}`; const read = () => app.request<SessionSnapshot>(root + "/snapshot");
    scenario = "assets"; await app.request(root + "/messages", { text: "查看 @资源", resourceIds: [hostId] }, "POST", 202);
    const assets = await until(async () => { const v = await read(); return v.ai?.status === "completed" ? v : null; });
    assert(assets.ai!.cards.some(c => c.type === "thinking" && c.content === "核对目标")); assert(assets.ai!.cards.some(c => c.type === "operation" && c.title === "list_assets"));
    await app.request("/api/settings/model", { url: `http://127.0.0.1:${(model.address() as {port:number}).port}/v1/chat/completions`, name: "fixture", supportsImageInput: true }, "PUT");
    scenario = "image"; await app.request(root + "/messages", { text: "查看图片", images: [{ id: "image-test", mimeType: "image/png", base64: imageBase64 }] }, "POST", 202);
    const imaged = await until(async () => { const v = await read(); return v.ai?.status === "completed" && v.ai.cards.some(c => c.content === "已收到图片") ? v : null; });
    const storedImage = imaged.messages.find(m => m.text === "查看图片")!.images![0]!;
    assert.equal(storedImage.width, 1); assert.equal(storedImage.base64, ""); assert(storedImage.url);
    assert.equal((await app.image(storedImage.url!, false)).status, 401);
    const imageResponse = await app.image(storedImage.url!); assert.equal(imageResponse.status, 200); assert.equal(Buffer.from(await imageResponse.arrayBuffer()).toString("base64"), imageBase64);
    const imageHistory = await app.request<Array<{images?: Array<{base64:string}>}>>(root + "/ai/history"); assert(imageHistory.some(m => m.images?.[0]?.base64 === imageBase64));
    path = join(app.dir, "edited.txt"); scenario = "write"; await app.request(root + "/messages", { text: "修改文件" }, "POST", 202);
    const pending = await until(async () => { const v = await read(); return v.ai?.pending ? v : null; }); assert(!existsSync(path));
    assert(pending.ai!.pending!.call.arguments.includes(path));
    await app.request(root + "/ai/decision", { id: pending.ai!.pending!.id, accept: true });
    await until(async () => { const v = await read(); return v.ai?.status === "completed" ? v : null; });
    assert.equal(readFileSync(path, "utf8"), "approved-content");
    await app.request(root + "/ai/decision", { id: pending.ai!.pending!.id, accept: true }, "POST", 409);
    await app.request(root + "/ai/undoFile", {}); assert(!existsSync(path));
    const terminal = await app.request<TerminalSession>(root + "/terminals", { resourceId: hostId }, "POST", 201);
    await app.request(`${root}/terminals/${terminal.id}/control`, { holder: "agent" });
    await app.request(root + "/ai/configure", { profile: "terminal2", terminal_id: terminal.id, asset_ref: hostId });
    scenario = "terminal"; await app.request(root + "/messages", { text: "查看终端系统类型" }, "POST", 202);
    const terminalResult = await until(async () => { const v = await read(); return v.ai?.status === "completed" && v.ai.cards.some(c => c.content?.includes("已读取系统类型")) ? v : null; });
    assert.equal(terminalResult.ai!.profile, "terminal2");
    await app.request(root + "/ai/configure", { profile: "core" }); scenario = "cancel";
    await app.request(root + "/messages", { text: "暂停测试" }, "POST", 202);
    await until(async () => { const v = await read(); return v.ai?.status === "running" ? v : null; });
    await app.request(root + "/ai/abort", {}); await until(async () => { const v = await read(); return v.ai?.status === "cancelled" ? v : null; });
    scenario = "write"; await app.request(root + "/messages", { text: "重启审批测试" }, "POST", 202);
    const old = await until(async () => { const v = await read(); return v.ai?.pending ? v : null; });
    await app.restart(); const restored = await read(); assert(!restored.ai!.pending); assert(["cancelled", "interrupted"].includes(restored.ai!.status)); assert(!existsSync(path));
    await app.request(root + "/ai/decision", { id: old.ai!.pending!.id, accept: true }, "POST", 409);
  } finally { await app.cleanup(); model.closeAllConnections(); await new Promise<void>(yes => model.close(() => yes())); }
});
