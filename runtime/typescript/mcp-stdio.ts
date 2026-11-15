import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { LakeGateway } from "./gateway";
import type { GatewayInstructionStatus } from "../../web-agent/shared/contracts";

export type SpecialistMcpOptions = { home: string; data?: string; role?: string; tokenId?: string; /** Test seam: an already-linked transport instead of stdio. */ transport?: unknown };
export type ChannelMcpOptions = {home: string; data?: string; connectionId: string; transport?: unknown};
export type SpecialistTool = { name: string; description: string; inputSchema: z.ZodTypeAny; handler: (args: any, extra?: unknown) => Promise<unknown> };

const pending = (state: GatewayInstructionStatus["state"]) => ["routing", "routed", "running"].includes(state);
const roleShape = { role: z.string().optional().describe("专员的准确 RoleID，来自 list_specialists；单专员服务无需此参数") };
class BackendTimeoutError extends Error {
  constructor() { super("Lake 后端响应超时，请稍后重试"); }
}

/** Read the loopback endpoint of the running Lake backend for this Home. */
export function backendEndpoint(home: string, dataDir?: string): { origin: string } {
  const path = join(dataDir ?? join(home, "web-agent"), "runtime.json");
  if (!existsSync(path)) throw new Error("Lake 后端未运行；请先启动 Lake 或 Lake Dev，再使用此 MCP 服务");
  let runtime: { origin?: string };
  try { runtime = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Lake 运行记录无效，请核对 Lake 后端状态"); }
  let endpoint: URL;
  try { endpoint = new URL(String(runtime.origin ?? "")); } catch { throw new Error("Lake 运行记录缺少有效地址"); }
  if (endpoint.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) || endpoint.pathname !== "/")
    throw new Error("Lake 运行地址不是本机回环地址，已拒绝连接");
  return { origin: endpoint.origin };
}

/** The tool surface offered to an external developer agent. Instructions reuse
 * the exact channel path of a human message, so Pilot routing, Lake Security
 * and the approval flow stay unchanged; no tool call can grant permission. */
function backendCall(options: {home:string; data?:string}, token: string) {
  return async (path: string, init?: RequestInit, timeoutMs = 120000): Promise<any> => {
    const { origin } = backendEndpoint(options.home, options.data);
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
    let response: Response;
    let body: any;
    try {
      response = await fetch(origin + path, {
        ...init,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
        signal,
      });
      body = await response.json().catch(error => { if (signal.aborted) throw error; return {}; });
    } catch (error) {
      if (signal.aborted) throw new BackendTimeoutError();
      throw new Error(`无法连接 Lake 后端（${origin}）：请确认 Lake 正在运行`);
    }
    if (!response.ok) throw new Error(String((body as any).error ?? `Lake 网关返回 HTTP ${response.status}`));
    return body;
  };
}
async function waitStatus(call: ReturnType<typeof backendCall>, path: string, timeoutSeconds = 120) {
  const deadline = Date.now() + Math.min(600, Math.max(1, Math.floor(timeoutSeconds))) * 1000;
  // The last value must come from the backend, including when the final body stalls.
  let status = await call(path, undefined, deadline - Date.now()) as GatewayInstructionStatus;
  while (pending(status.state) && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try { status = await call(`${path}?waitSeconds=${Math.min(30, Math.ceil(remaining / 1000))}`, undefined, remaining); }
    catch (error) { if (error instanceof BackendTimeoutError) return status; throw error; }
  }
  return status;
}

export function specialistTools(options: SpecialistMcpOptions): SpecialistTool[] {
  const gateway = new LakeGateway(options.home);
  const { token } = gateway.resolveToken(options.tokenId);
  gateway.requireLegacy(gateway.authenticate(token));
  const role = options.role?.trim(), call = backendCall(options, token);
  const resolveRole = async (requested: unknown): Promise<string> => {
    if (role) {
      if (requested !== undefined && requested !== role) throw new Error(`此 MCP 服务绑定专员 ${role}，不能指定其他专员`);
      return role;
    }
    if (typeof requested !== "string" || !requested.trim()) throw new Error("请提供 role（来自 list_specialists 的准确 roleId）");
    return requested.trim();
  };
  const send = async (args: { role?: string; text: string; client_request_id?: string }) => {
    const roleId = await resolveRole(args.role);
    return call(`/api/gateway/specialists/${encodeURIComponent(roleId)}/instructions`,
      { method: "POST", body: JSON.stringify({ text: args.text, ...(args.client_request_id && { clientRequestId: args.client_request_id }) }) });
  };
  const wait = async (args: { instruction_id: string; timeout_seconds?: number }) => {
    return waitStatus(call, `/api/gateway/instructions/${encodeURIComponent(args.instruction_id)}`, args.timeout_seconds);
  };
  const tools: SpecialistTool[] = [];
  if (!role) tools.push({
    name: "list_specialists",
    description: "列出此 Lake 中可接收外部指令的专员（角色）及其 RoleID、职责与所属项目。",
    inputSchema: z.object({}),
    handler: async () => call("/api/gateway/specialists"),
  });
  tools.push({
    name: "send_instruction",
    description: "给一位专员发送指令，等同研发人员在 Lake 专员频道亲手输入：Pilot 会路由并创建/续接业务任务，资源权限与计划/审批确认仍在 Lake 界面完成。重复的 client_request_id 幂等返回同一条指令。",
    inputSchema: z.object({ text: z.string().min(1).max(16000).describe("指令原文"), client_request_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional().describe("幂等键：同一指令重试时复用相同值"), ...roleShape }),
    handler: send,
  });
  tools.push({
    name: "wait_instruction",
    description: "等待一条指令出现结果（专员报告、等待审批/输入、失败、停止）或超时返回当前状态。等待审批时请提醒研发人员在 Lake 界面确认。",
    inputSchema: z.object({ instruction_id: z.string().min(1).describe("send_instruction 返回的 instructionId"), timeout_seconds: z.number().int().min(1).max(600).optional().describe("最长等待秒数，默认 120"), ...roleShape }),
    handler: wait,
  });
  tools.push({
    name: "get_instruction_status",
    description: "立即读取一条指令的当前状态：路由、任务、专员回应与等待中的审批。",
    inputSchema: z.object({ instruction_id: z.string().min(1).describe("send_instruction 返回的 instructionId"), ...roleShape }),
    handler: (args: { instruction_id: string }) => call(`/api/gateway/instructions/${encodeURIComponent(args.instruction_id)}`),
  });
  return tools;
}

/** A connection is bound to one project by the host. Clients supply only
 * their own thread/message keys, never a project, role, task or permission. */
export function channelTools(options: ChannelMcpOptions): SpecialistTool[] {
  const gateway = new LakeGateway(options.home), {token} = gateway.resolveToken(options.connectionId);
  gateway.requireConnection(gateway.authenticate(token));
  const call = backendCall(options, token);
  const messageId = z.string().min(1).max(128).describe('send_message 返回的 instructionId');
  return [
    {name: 'send_message', description: '向此连接绑定的 Lake 项目发送消息。Pilot 自动回复、追问或分派任务；同一外部对话复用 thread_id，新消息使用新的 client_message_id，重试复用原值。答复追问时用 reply_to 引用原消息。任务审批仍在 Lake 中完成。',
      inputSchema: z.object({text: z.string().min(1).max(16384).refine(value => Buffer.byteLength(value, 'utf8') <= 16384, '消息须不超过 16384 UTF-8 字节'), thread_id: z.string().min(1).max(128),
        client_message_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/), thread_title: z.string().min(1).max(120).optional(), reply_to: messageId.optional()}).strict(),
      handler: (args: {text:string;thread_id:string;client_message_id:string;thread_title?:string;reply_to?:string}) => call('/api/gateway/messages', {method: 'POST',
        body: JSON.stringify({text: args.text, threadId: args.thread_id, clientMessageId: args.client_message_id,
          ...(args.thread_title !== undefined && {threadTitle: args.thread_title}), ...(args.reply_to !== undefined && {replyTo: args.reply_to})})})},
    {name: 'get_message_status', description: '读取本连接消息的处理状态、关联任务、各专员报告与 Pilot 回复；报告已提交不代表独立核验业务成功。',
      inputSchema: z.object({message_id: messageId}).strict(), handler: (args: {message_id:string}) => call(`/api/gateway/messages/${encodeURIComponent(args.message_id)}`)},
    {name: 'wait_message', description: '等待本连接消息的任务报告、回复、需要输入或审批等状态，超时返回最近一次实际状态；任务尚在处理时可再次等待。',
      inputSchema: z.object({message_id: messageId, timeout_seconds: z.number().int().min(1).max(600).optional()}).strict(),
      handler: (args: {message_id:string;timeout_seconds?:number}) => waitStatus(call, `/api/gateway/messages/${encodeURIComponent(args.message_id)}`, args.timeout_seconds)},
    {name: 'test_connection', description: '验证当前 MCP 客户端到 Lake 后端的连接身份与项目配置；不发送业务消息、不创建任务。',
      inputSchema: z.object({}).strict(), handler: () => call('/api/gateway/connection')},
  ];
}

/** Run the stdio MCP server for one specialist (role bound) or all of them. */
export async function runSpecialistMcp(options: SpecialistMcpOptions) {
  await runMcp('lake-specialists', specialistTools(options), options.transport);
}
export async function runChannelMcp(options: ChannelMcpOptions) {
  await runMcp('lake-channels', channelTools(options), options.transport);
}
async function runMcp(name: string, tools: SpecialistTool[], transport?: unknown) {
  const server = new McpServer({ name, version: "1.0.0" });
  for (const tool of tools)
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (args, extra) => {
      try {
        const value = await tool.handler(args, extra);
        return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true as const };
      }
    });
  await server.connect((transport as any) ?? new StdioServerTransport());
}
