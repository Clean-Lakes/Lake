export interface LakeCLIContext {
  argv: string[];
  stdin: AsyncIterable<Uint8Array>;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}
