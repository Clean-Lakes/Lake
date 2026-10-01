import type { LakeCLIContext } from "../../domain/cli.js";
import { readInput } from "./arguments.js";

/** Read an interactive credential without echo; pipes remain suitable for automation. */
export async function readSecret(context: LakeCLIContext, prompt: string): Promise<Buffer> {
  if (context.stdin !== process.stdin || !process.stdin.isTTY) return readInput(context, 65536);
  const input = process.stdin,
    wasRaw = input.isRaw;
  context.stderr.write(prompt + ": ");
  input.setRawMode(true);
  input.resume();
  const bytes: number[] = [];
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const finish = (error?: Error) => {
        input.removeListener("data", data);
        input.removeListener("end", end);
        context.stderr.write("\n");
        if (error) reject(error);
        else resolve(Buffer.from(bytes));
      };
      const end = () => finish(new Error("凭据输入已结束"));
      const data = (chunk: Buffer) => {
        for (const byte of chunk) {
          if (byte === 3) {
            finish(new Error("输入已取消"));
            return;
          }
          if (byte === 13 || byte === 10) {
            finish();
            return;
          }
          if (byte === 127 || byte === 8) bytes.pop();
          else if (byte >= 32) bytes.push(byte);
          if (bytes.length > 65536) {
            finish(new Error("凭据过长"));
            return;
          }
        }
      };
      input.on("data", data);
      input.once("end", end);
    });
  } finally {
    bytes.fill(0);
    input.setRawMode(wasRaw);
    input.pause();
  }
}
