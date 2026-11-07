import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {createHash} from 'node:crypto';
import type {ModelProvider, ProviderModel} from '../../web-agent/shared/contracts';
import {HttpError, privateDirectory, type LakeStore} from './store';
import {providerConnection} from './provider-connection';

type Choice = {defaultModel: string; model: string};
type Connection = {provider: ModelProvider; defaultModel: string; key: string; version: string};
const efforts = new Set(['none','minimal','low','medium','high','xhigh','max','ultra']);
const owned = (info: {uid: number}) => process.platform === 'win32' || info.uid === process.getuid?.();
const identity = (value: unknown): value is string => typeof value === 'string' && !!value && value.trim() === value && Buffer.byteLength(value) <= 200 && !/[\r\n\x00]/.test(value);
const capacity = (value: unknown) => value === undefined || Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2000000;

/** An external, private model source. The plugin owns magpie-agent.json; only
 * non-secret selection preferences belong to Lake's store. */
export class LakeMagpie {
  private connection?: Connection;
  private reading?: Promise<void>;
  private versions = new WeakMap<ModelProvider, string>();
  private constructor(private store: LakeStore, private registerSecret: (key: string) => void) {}
  static async connect(store: LakeStore, registerSecret: (key: string) => void) {
    const source = new LakeMagpie(store, registerSecret);
    const directory = join(store.home, 'secrets');
    await privateDirectory(directory);
    // Magpie preserves an existing file mode, but creates a missing file 0644.
    // Prepare the same Home's private placeholder before the plugin connects.
    const file = join(directory, 'magpie-agent.json');
    try {
      const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await handle.writeFile('{}\n'); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('无法准备 Magpie 私有配置');
      // Repair permissions only at startup, never follow an existing symlink.
      try {
        const named = await lstat(file);
        if (!named.isFile() || named.isSymbolicLink() || !owned(named)) throw new Error();
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try { const info = await handle.stat(); if (info.isFile() && owned(info) && info.ino === named.ino && info.dev === named.dev) await handle.chmod(0o600); }
        finally { await handle.close(); }
      } catch { /* Unsafe optional configuration stays unavailable. */ }
    }
    if (!store.get('settings', 'magpieSelectionImported')) {
      const saved = await source.readPrivate(join(store.data, 'magpie-selection.json'), 1024);
      if (saved) {
        try {
          const value = JSON.parse(saved);
          if (identity(value.defaultModel) && identity(value.model) && !store.get('settings', 'magpieModelSelection'))
            store.put('settings', 'magpieModelSelection', {defaultModel: value.defaultModel, model: value.model});
        } catch { /* A malformed legacy selection cannot select a model. */ }
      }
      store.put('settings', 'magpieSelectionImported', true);
    }
    await source.refresh();
    return source;
  }
  private async readPrivate(file: string, limit: number): Promise<string | undefined> {
    try {
      const directory = await lstat(dirname(file));
      if (!directory.isDirectory() || directory.isSymbolicLink() || !owned(directory) || (directory.mode & 0o077)) return;
      const namedBefore = await lstat(file);
      if (!namedBefore.isFile() || namedBefore.isSymbolicLink() || !owned(namedBefore) || (namedBefore.mode & 0o077)) return;
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat();
        if (!before.isFile() || !owned(before) || (before.mode & 0o077) || before.size > limit || before.ino !== namedBefore.ino || before.dev !== namedBefore.dev) return;
        const buffer = Buffer.alloc(limit + 1); let length = 0;
        while (length < buffer.length) { const part = await handle.read(buffer, length, buffer.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
        const bytes = buffer.subarray(0, length);
        const after = await handle.stat(), named = await lstat(file);
        if (!named.isFile() || named.isSymbolicLink() || !owned(named) || (named.mode & 0o077) || bytes.length > limit ||
            before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
            after.ino !== named.ino || after.dev !== named.dev || after.size !== named.size || after.mtimeMs !== named.mtimeMs || after.ctimeMs !== named.ctimeMs) return;
        return bytes.toString('utf8');
      } finally { await handle.close(); }
    } catch { return; }
  }
  private parse(raw: string): Connection | undefined {
    try {
      const cfg = JSON.parse(raw);
      if (!cfg || !identity(cfg.model) || typeof cfg.baseURL !== 'string' || typeof cfg.key !== 'string' || !cfg.key || Buffer.byteLength(cfg.key) > 4096 || /[\r\n\x00]/.test(cfg.key) ||
          !capacity(cfg.contextWindow) || !capacity(cfg.maxOutput) || cfg.catalog !== undefined && !Array.isArray(cfg.catalog)) return;
      const {baseURL} = providerConnection('openai', cfg.baseURL);
      const models: ProviderModel[] = [], seen = new Set<string>();
      for (const item of [...(cfg.catalog ?? []).slice(0, 1024), {id: cfg.model, name: cfg.model, contextWindow: cfg.contextWindow, maxOutput: cfg.maxOutput, supportsImageInput: cfg.supportsImageInput, reasoningEfforts: cfg.reasoningEfforts}]) {
        if (!item || !identity(item.id) || seen.has(item.id) || !capacity(item.contextWindow) || !capacity(item.maxOutput)) continue;
        seen.add(item.id);
        const levels = Array.isArray(item.reasoningEfforts) && item.reasoningEfforts.length <= 8 ? [...new Set<string>(item.reasoningEfforts.filter((value: unknown) => typeof value === 'string' && efforts.has(value)))] : [];
        models.push({id: item.id, name: item.id, displayName: typeof item.name === 'string' && item.name && Buffer.byteLength(item.name) <= 120 && !/[\r\n\x00]/.test(item.name) ? item.name : item.id,
          enabled: true, supportsImageInput: item.supportsImageInput === true, supportsImageOutput: false,
          ...(item.contextWindow > 0 ? {contextWindow: item.contextWindow} : {}), ...(item.maxOutput > 0 ? {maxOutputTokens: item.maxOutput} : {}),
          reasoningCapability: {levels, source: 'provider'}});
      }
      if (!models.some(model => model.id === cfg.model)) return;
      const provider: ModelProvider = {id: 'magpie', name: 'Magpie', protocol: 'openai', baseURL, enabled: true, keyConfigured: true, models};
      const version = createHash('sha256').update(JSON.stringify([provider, cfg.model, cfg.key])).digest('hex');
      return {provider, defaultModel: cfg.model, key: cfg.key, version};
    } catch { return; }
  }
  async refresh() {
    if (this.reading) return this.reading;
    this.reading = (async () => {
      const raw = await this.readPrivate(join(this.store.home, 'secrets/magpie-agent.json'), 2 * 1024 * 1024);
      const next = raw ? this.parse(raw) : undefined;
      if (next) this.registerSecret(next.key);
      if (next?.version === this.connection?.version) return;
      this.connection = next;
      if (next) this.versions.set(next.provider, next.version);
    })();
    try { await this.reading; } finally { this.reading = undefined; }
  }
  provider() { return this.connection?.provider; }
  selectedId() {
    const current = this.connection; if (!current) return;
    const selected = this.store.get<Choice>('settings', 'magpieModelSelection');
    return selected?.defaultModel === current.defaultModel && current.provider.models.some(model => model.id === selected.model) ? selected.model : current.defaultModel;
  }
  select(model: string) {
    const current = this.connection;
    if (!current?.provider.models.some(value => value.id === model)) throw new HttpError(400, 'Magpie 模型已不可用，请刷新模型列表');
    this.store.put('settings', 'magpieModelSelection', {defaultModel: current.defaultModel, model});
  }
  version(provider: ModelProvider) { return this.versions.get(provider) ?? ''; }
  async credential(provider: ModelProvider) {
    const expected = this.versions.get(provider);
    await this.refresh();
    if (!expected || !this.connection || expected !== this.connection.version) throw new HttpError(409, 'Magpie 连接已变化，请重试当前请求');
    return this.connection.key;
  }
}
