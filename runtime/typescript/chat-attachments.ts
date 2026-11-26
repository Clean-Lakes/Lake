import {createHash, randomBytes} from 'node:crypto';
import {constants, closeSync, fstatSync, lstatSync, openSync, readFileSync} from 'node:fs';
import {open, rename, rm} from 'node:fs/promises';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {attachmentCountLimit, attachmentLimit, attachmentThumbnailLimit} from '../../web-agent/shared/chat-attachments';
import type {TextFileAttachment} from '../../web-agent/shared/contracts';
import {HttpError, LakeStore, privateDirectory} from './store';

type Attachment = TextFileAttachment & {kind: 'file'; sizeBytes: number; sha256: string; mimeType: string};
type AttachmentRecord = Attachment & {project: string; session: string};
const sourcePattern = /^file-[a-f0-9]{32}$/;
const mimePattern = /^[\w.+-]+\/[\w.+-]+$/;
const noFollow = constants.O_NOFOLLOW ?? 0;

function validName(name: unknown): name is string {
  return typeof name === 'string' && !!name.trim() && Buffer.byteLength(name) <= 1000 && !/[\\/\x00-\x1f\x7f]/.test(name);
}

function rasterType(sample: Buffer) {
  if (sample.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) return 'image/jpeg';
  const signature = sample.toString('ascii', 0, 6);
  if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  if (sample.toString('ascii', 0, 4) === 'RIFF' && sample.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}

function privateOwner(info: {mode: number; uid: number}) {
  return process.platform === 'win32' || (info.mode & 0o077) === 0 && info.uid === process.getuid?.();
}

function attachmentRoot(store: LakeStore) { return join(store.data, 'attachments'); }

// Match the existing Lake blob and receipt format so previously saved binary
// attachments can be downloaded from their original session.
function readRecord(store: LakeStore, sessionId: string, sourceId: string) {
  if (!sourcePattern.test(sourceId)) throw new HttpError(400, '附件标识无效');
  const session = store.session(sessionId);
  store.project(session.projectId);
  const root = attachmentRoot(store);
  let record: AttachmentRecord;
  try {
    const directory = lstatSync(root);
    if (!directory.isDirectory() || !privateOwner(directory)) throw Error();
    const receipt = openSync(join(root, `${sourceId}.json`), constants.O_RDONLY | noFollow);
    try {
      const info = fstatSync(receipt);
      if (!info.isFile() || !privateOwner(info) || info.size > 4096) throw Error();
      record = JSON.parse(readFileSync(receipt, 'utf8')) as AttachmentRecord;
    } finally { closeSync(receipt); }
  } catch {
    throw new HttpError(404, '附件不存在，请重新选择文件');
  }
  if (!record || record.sourceId !== sourceId || !validName(record.name) ||
      !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0 || record.sizeBytes > attachmentLimit ||
      typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256) || typeof record.mimeType !== 'string')
    throw new HttpError(404, '附件记录无效，请重新选择文件');
  if (record.session !== sessionId || record.project !== session.projectId)
    throw new HttpError(403, '只能访问当前项目和会话的附件');
  const filename = join(root, `${sourceId}.blob`);
  const info = lstatSync(filename, {throwIfNoEntry: false});
  if (!info?.isFile() || !privateOwner(info) || info.size !== record.sizeBytes)
    throw new HttpError(409, '附件原件已变化，请重新上传');
  const file: Attachment = {sourceId, name: record.name, kind: 'file', sizeBytes: record.sizeBytes,
    sha256: record.sha256, mimeType: record.mimeType, ...(record.preview === 'image' && {preview: 'image'})};
  return {file, filename};
}

export function messageAttachments(store: LakeStore, sessionId: string, input: unknown): TextFileAttachment[] | undefined {
  if (input === undefined || Array.isArray(input) && input.length === 0) return;
  if (!Array.isArray(input) || input.length > attachmentCountLimit)
    throw new HttpError(400, `每条消息最多附加 ${attachmentCountLimit} 个文件`);
  const ids = input.map(item => item?.sourceId);
  if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length)
    throw new HttpError(400, '附件标识无效或重复');
  return ids.map(id => readRecord(store, sessionId, id).file);
}

export function attachmentMetadata(files: readonly TextFileAttachment[] | undefined, redact: (value: string) => string) {
  return files?.map(({name, mimeType, sizeBytes}) => ({name: redact(name).slice(0, 256), mimeType, sizeBytes}));
}

export async function saveChatAttachment(store: LakeStore, sessionId: string, request: IncomingMessage, guard: () => void) {
  const session = store.session(sessionId);
  store.project(session.projectId);
  if (session.workspaceRole === 'legacy') throw new HttpError(409, '历史会话为只读');
  if (request.headers['content-type'] !== 'application/octet-stream') throw new HttpError(415, '请上传原始文件');
  if (Number(request.headers['content-length']) > attachmentLimit) throw new HttpError(413, '每个附件最多 512 MiB');
  let name: string;
  try { name = decodeURIComponent(String(request.headers['x-lake-filename'] ?? '')); }
  catch { throw new HttpError(400, '文件名无效'); }
  if (!validName(name)) throw new HttpError(400, '文件名无效');
  const hint = String(request.headers['x-lake-file-type'] ?? '').toLowerCase();
  const root = attachmentRoot(store);
  await privateDirectory(root);
  const sourceId = 'file-' + randomBytes(16).toString('hex');
  const filename = join(root, `${sourceId}.blob`), temporary = join(root, `${sourceId}.part`);
  const hash = createHash('sha256');
  const sample = Buffer.alloc(12);
  let sizeBytes = 0, saved = false;
  const output = await open(filename, 'wx', 0o600);
  try {
    try {
      for await (const chunk of request.iterator({destroyOnReturn: false})) {
        if (sizeBytes + chunk.length > attachmentLimit) throw new HttpError(413, '每个附件最多 512 MiB');
        if (sizeBytes < sample.length) chunk.copy(sample, sizeBytes, 0, Math.min(chunk.length, sample.length - sizeBytes));
        sizeBytes += chunk.length;
        hash.update(chunk);
        await output.writeFile(chunk);
      }
      if (!request.complete) throw new HttpError(400, '附件上传未完成，请重新选择文件');
      await output.sync();
    } finally { await output.close(); }
    guard();
    if (store.session(sessionId).projectId !== session.projectId) throw new HttpError(409, '会话已变化，请重新选择文件');
    store.project(session.projectId);
    const image = rasterType(sample.subarray(0, Math.min(sizeBytes, sample.length)));
    const mimeType = image ?? (hint.length <= 128 && mimePattern.test(hint) ? hint : 'application/octet-stream');
    const file: Attachment = {sourceId, name, sizeBytes, sha256: hash.digest('hex'), mimeType, kind: 'file',
      ...(image && sizeBytes <= attachmentThumbnailLimit && {preview: 'image'})};
    const record: AttachmentRecord = {...file, project: session.projectId, session: sessionId};
    const receipt = await open(temporary, 'wx', 0o600);
    try { await receipt.writeFile(JSON.stringify(record)); await receipt.sync(); } finally { await receipt.close(); }
    await rename(temporary, join(root, `${sourceId}.json`));
    saved = true;
    return file;
  } finally {
    if (!saved) await Promise.all([rm(filename, {force: true}), rm(temporary, {force: true})]);
  }
}

export async function serveChatAttachment(store: LakeStore, sessionId: string, sourceId: string, preview: boolean,
    headOnly: boolean, response: ServerResponse) {
  const {file, filename} = readRecord(store, sessionId, sourceId);
  const handle = await open(filename, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !privateOwner(info) || info.size !== file.sizeBytes)
      throw new HttpError(409, '附件原件已变化，请重新上传');
    let type = 'application/octet-stream';
    if (preview) {
      if (file.preview !== 'image' || file.sizeBytes > attachmentThumbnailLimit) throw new HttpError(404, '没有可用的缩略图');
      const {buffer, bytesRead} = await handle.read(Buffer.alloc(12), 0, 12, 0);
      const image = rasterType(buffer.subarray(0, bytesRead));
      if (!image || image !== file.mimeType) throw new HttpError(404, '没有可用的缩略图');
      type = image;
    }
    const encodedName = encodeURIComponent(file.name).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
    response.writeHead(200, {'Content-Type': type, 'Content-Length': file.sizeBytes, 'Cache-Control': 'no-store',
      'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodedName}`});
    if (headOnly) response.end();
    else await pipeline(handle.createReadStream({start: 0, autoClose: false}), response);
  } finally { await handle.close(); }
}
