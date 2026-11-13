import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDirectory } from '../store';

/** Validate every private path component, including existing parents. */
export async function privatePath(root: string, ...parts: string[]) {
  await privateDirectory(root);
  let directory = root;
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[\\/\0]/.test(part)) throw new Error('Invalid private path component');
    directory = join(directory, part);
    await privateDirectory(directory);
  }
  return directory;
}

export async function privateFile(directory: string, name: string, contents: string) {
  const temporary = join(directory, '.' + randomUUID());
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    try { await handle.writeFile(contents); } finally { await handle.close(); }
    await rename(temporary, join(directory, name));
  } finally { await rm(temporary, {force: true}); }
}
