import type { LakeCLIContext } from "../../domain/cli.js";
import { object, type Params } from "../../domain/validation.js";

export interface Arguments { positionals: string[]; flags: Map<string, string[]> }
const BOOLEAN_FLAGS = new Set(["json", "all", "password-stdin", "allow", "deny", "enabled", "disabled", "retry-writes"]);
export function parseArguments(args: string[]): Arguments {
  const positionals: string[] = [], flags = new Map<string, string[]>();
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--") { positionals.push(...args.slice(index + 1)); break; }
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const [key, ...suffix] = value.slice(2).split("=");
    let content = suffix.join("=");
    if (!suffix.length) {
      if (BOOLEAN_FLAGS.has(key)) content = "true";
      else { content = args[++index]; if (!content || content.startsWith("--")) throw new Error(`--${key} 缺少值`); }
    }
    flags.set(key, [...(flags.get(key) ?? []), content]);
  }
  return { positionals, flags };
}
export const flag = (args: Arguments, key: string, fallback = ""): string => args.flags.get(key)?.at(-1) ?? fallback;
export async function readInput(context: LakeCLIContext, limit = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of context.stdin) {
    length += chunk.byteLength; if (length > limit) throw new Error("输入过长"); chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function readRequest(context: LakeCLIContext): Promise<Params> { return object(JSON.parse((await readInput(context)).toString("utf8"))); }
