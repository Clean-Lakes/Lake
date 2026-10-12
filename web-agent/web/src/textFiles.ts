export const textFileLimit = 1 << 20;

export function decodeTextFile(bytes: Uint8Array): string {
  if (!bytes.length || bytes.length > textFileLimit) throw new Error("请选择不超过 1 MB 的文本文件。");
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder("utf-16le", {fatal:true}).decode(bytes);
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder("utf-16be", {fatal:true}).decode(bytes);
  else {
    try { text = new TextDecoder("utf-8", {fatal:true}).decode(bytes); }
    catch { try { text = new TextDecoder("gb18030", {fatal:true}).decode(bytes); } catch { throw new Error("文件编码无法识别，请保存为 UTF-8 文本后重试。"); } }
  }
  if (/\x00|[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(text) || new TextEncoder().encode(text).length > textFileLimit) throw new Error("请选择有效文本文件，不支持二进制文件；转码后最多 1 MB。");
  return text;
}
export async function readTextFile(file: File): Promise<string> {
  if (file.size > textFileLimit) throw new Error(`${file.name} 超过 1 MB。`);
  return decodeTextFile(new Uint8Array(await file.arrayBuffer()));
}
