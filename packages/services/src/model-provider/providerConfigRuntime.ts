import { join } from "node:path";
import {
  NodeProviderConfigRuntime,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  type PersonalProviderConfigRecoveryEvent,
  type NodeProviderConfigRuntimeOptions,
} from "@zcode/provider-node";
import type { ModelProviderConfig } from "./legacyModelProviderSerialized.js";
import { getAppConfigDir } from "../paths.js";
import { importLegacyPersonalProviderConfig } from "./legacyPersonalProviderConfigImporter.js";
import {
  migrateZCodeProviderConfig,
  type ZCodeProviderConfigMigrationResult,
} from "./migrateZCodeProviderConfig.js";

export interface ProviderConfigRuntimeOptions {
  readonly zcodeBuiltinFilePath: string;
  readonly zcodeBuiltinActiveFilePath?: string;
  readonly zcodeBuiltinRemote?: NodeProviderConfigRuntimeOptions["zcodeBuiltinRemote"];
  readonly zcodeBuiltinEnvironment?: NodeProviderConfigRuntimeOptions["zcodeBuiltinEnvironment"];
  readonly onZCodeBuiltinRefreshError?: (error: unknown) => void;
  readonly onPersonalConfigRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPersonalConfigPollingError?: (error: unknown) => void;
  readonly personalFilePath?: string;
  readonly priorProductPersonalFilePath?: string;
  readonly migrationMarkerPath?: string;
  readonly onPriorProductMigrationResult?: (result: ZCodeProviderConfigMigrationResult) => void;
  readonly personalPollingIntervalMs?: number | false;
  readonly readLegacyProviders?: () => Promise<readonly ModelProviderConfig[]>;
  readonly watch?: boolean;
}

/**
 * Services 装配层：提供 App 配置目录和已发布旧配置的一次性迁移入口。
 * 配置迁移保留 ZCode 用户的供应商数据，文件运行时由 @zcode/provider-node 唯一实现。
 */
export class ProviderConfigRuntime {
  readonly configService: NodeProviderConfigRuntime["configService"];
  readonly #runtime: NodeProviderConfigRuntime;
  readonly #priorProductMigration?: () => Promise<ZCodeProviderConfigMigrationResult>;
  readonly #onPriorProductMigrationResult?: (result: ZCodeProviderConfigMigrationResult) => void;
  #startPromise: Promise<void> | null = null;

  constructor(options: ProviderConfigRuntimeOptions) {
    const personalFilePath =
      options.personalFilePath ?? join(getAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME);
    const priorProductPersonalFilePath = options.priorProductPersonalFilePath;
    if (priorProductPersonalFilePath) {
      this.#priorProductMigration = () =>
        migrateZCodeProviderConfig({
          lakeFilePath: personalFilePath,
          zcodeFilePath: priorProductPersonalFilePath,
          migrationMarkerPath: options.migrationMarkerPath,
        });
    }
    this.#onPriorProductMigrationResult = options.onPriorProductMigrationResult;
    const runtimeOptions: NodeProviderConfigRuntimeOptions = {
      zcodeBuiltinFilePath: options.zcodeBuiltinFilePath,
      zcodeBuiltinActiveFilePath: options.zcodeBuiltinActiveFilePath,
      zcodeBuiltinRemote: options.zcodeBuiltinRemote,
      zcodeBuiltinEnvironment: options.zcodeBuiltinEnvironment,
      onZCodeBuiltinRefreshError: options.onZCodeBuiltinRefreshError,
      onPersonalConfigRecovery: options.onPersonalConfigRecovery,
      onPersonalConfigPollingError: options.onPersonalConfigPollingError,
      personalFilePath,
      personalPollingIntervalMs: options.personalPollingIntervalMs,
      watch: options.watch,
      ...(options.readLegacyProviders
        ? {
            importLegacy: async () =>
              importLegacyPersonalProviderConfig({
                legacyProviders: await options.readLegacyProviders!(),
              }),
          }
        : {}),
    };
    this.#runtime = new NodeProviderConfigRuntime(runtimeOptions);
    this.configService = this.#runtime.configService;
  }

  start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    const startPromise = (async () => {
      if (this.#priorProductMigration) {
        const result = await this.#priorProductMigration();
        this.#onPriorProductMigrationResult?.(result);
      }
      await this.#runtime.start();
    })();
    this.#startPromise = startPromise;
    void startPromise.catch(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
    return startPromise;
  }

  get personalRepository(): NodeProviderConfigRuntime["personalRepository"] {
    return this.#runtime.personalRepository;
  }

  resolveZCodeBuiltinActiveFilePath(): Promise<string> {
    return this.#runtime.resolveZCodeBuiltinActiveFilePath();
  }

  refreshZCodeBuiltin(options?: { readonly force?: boolean }) {
    return this.#runtime.refreshZCodeBuiltin(options);
  }

  onDidCheckZCodeBuiltin(listener: () => Promise<void>): () => void {
    return this.#runtime.onDidCheckZCodeBuiltin(listener);
  }

  dispose(): void {
    this.#runtime.dispose();
  }
}

export function createProviderConfigRuntime(
  options: ProviderConfigRuntimeOptions,
): ProviderConfigRuntime {
  return new ProviderConfigRuntime(options);
}
