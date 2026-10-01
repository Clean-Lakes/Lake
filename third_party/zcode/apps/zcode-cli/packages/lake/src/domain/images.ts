import type { JsonValue } from "./json.js";
import { object, redact, text, type Params } from "./validation.js";

export function checkedImages(raw: JsonValue): Params[] {
  if (!Array.isArray(raw) || raw.length > 4) throw new Error("每轮最多上传 4 张图片");
  return raw.map(value => {
    const image = object(value), encoded = text(image, "data");
    if (!encoded || encoded.length > 2_796_204 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new Error("图片内容无效或超过 2 MB");
    const bytes = atob(encoded); if (bytes.length > 2_097_152) throw new Error("图片超过 2 MB");
    const mime = bytes.startsWith("\x89PNG\r\n\x1a\n") ? "image/png" : bytes.startsWith("\xff\xd8\xff") ? "image/jpeg" : /^GIF8[79]a/u.test(bytes) ? "image/gif" : bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP" ? "image/webp" : "";
    if (!mime || mime !== image.mime_type || text(image, "name").length > 200) throw new Error("图片格式与内容不匹配"); return { name: redact(text(image, "name"), 200), mime_type: mime, data: encoded };
  });
}
