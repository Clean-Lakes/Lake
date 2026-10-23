/**
 * 测试夹具：每个用例一个独立临时目录，互不干扰。
 * @module dsh-plugin-ops-data/test/helpers
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../lib/db.js';
import { OpsStore } from '../lib/store.js';

/**
 * 在独立临时目录中打开一个仓库。
 * @param {{name?: string, maxRows?: number}} [options]
 */
export function createStore(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-data-test-'));
  const path = join(dir, options.name ?? 'ops.db');
  const db = openDatabase(path);
  const store = new OpsStore(db, { maxRows: options.maxRows ?? 50, path });
  return {
    store,
    db,
    dir,
    path,
    cleanup() {
      try {
        db.close();
      } catch {
        // 已关闭时忽略。
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
