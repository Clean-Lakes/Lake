import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeProviderConfigFile, encodeProviderConfigFile } from "@zcode/provider-node";
import type { ProviderConfigLayerUpdate } from "@zcode/provider";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";

export type ZCodeProviderConfigMigrationResult =
  | "already-complete"
  | "imported"
  | "kept-lake"
  | "no-source"
  | "invalid-source"
  | "invalid-lake";

export interface ZCodeProviderConfigMigrationOptions {
  readonly lakeFilePath: string;
  readonly zcodeFilePath: string;
  readonly migrationMarkerPath?: string;
  readonly lakeLegacyConfigFilePath?: string;
}

/** 只迁移模型个人配置；会话、设置及项目绝不经过此入口。 */
export async function migrateZCodeProviderConfig(
  options: ZCodeProviderConfigMigrationOptions,
): Promise<ZCodeProviderConfigMigrationResult> {
  const markerPath = options.migrationMarkerPath ?? `${options.lakeFilePath}.zcode-imported`;
  return withFileLock(options.lakeFilePath, async () => {
    if ((await readIfExists(markerPath)) !== null) return "already-complete";

    const lakeText = await readIfExists(options.lakeFilePath);
    if (lakeText !== null) {
      let lake: ProviderConfigLayerUpdate;
      try {
        lake = decodeProviderConfigFile(JSON.parse(lakeText) as unknown);
      } catch {
        // 目标文件损坏时不能把它当成“空配置”覆盖；后续交给 Repository 的恢复路径。
        return "invalid-lake";
      }
      if (hasPersonalConfig(lake)) {
        await markComplete(markerPath);
        return "kept-lake";
      }
    }

    // Lake 自己的旧 config.json 已存在时由既有迁移器处理，不能抢先导入另一个产品的数据。
    const lakeLegacyPath =
      options.lakeLegacyConfigFilePath ?? join(dirname(options.lakeFilePath), "config.json");
    if ((await readIfExists(lakeLegacyPath)) !== null) {
      await markComplete(markerPath);
      return "kept-lake";
    }

    const zcodeText = await readIfExists(options.zcodeFilePath);
    if (zcodeText === null) {
      await markComplete(markerPath);
      return "no-source";
    }
    let zcode: ProviderConfigLayerUpdate;
    try {
      zcode = decodeProviderConfigFile(JSON.parse(zcodeText) as unknown);
    } catch {
      // 来源无效不建立完成标记，用户修复源文件后可以安全重试；不记录密钥或原文。
      return "invalid-source";
    }
    if (!hasPersonalConfig(zcode)) {
      await markComplete(markerPath);
      return "no-source";
    }

    // 先写配置、后写完成标记。若进程在两者之间退出，下次会看到非空 Lake 配置，
    // 仅补标记而不重放 ZCode 内容，因此不会覆盖后来已提交的 Lake 编辑。
    await atomicWritePrivateTextFile(
      options.lakeFilePath,
      JSON.stringify(encodeProviderConfigFile(zcode), null, 2),
    );
    await markComplete(markerPath);
    return "imported";
  });
}

function hasPersonalConfig(config: ProviderConfigLayerUpdate): boolean {
  return (
    config.providers.rules().length > 0 ||
    config.models.rules().length > 0 ||
    (config.providerOrder?.length ?? 0) > 0 ||
    config.defaultModelSelection !== undefined
  );
}

async function markComplete(markerPath: string): Promise<void> {
  await atomicWritePrivateTextFile(markerPath, "lake-provider-config-import-v1\n");
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
