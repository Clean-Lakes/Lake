import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelProvider, ProviderModel } from "../../web-agent/shared/contracts";
import { LakeStore, now } from "./store";

// A one-time same-Home configuration import, not a permission migration.
// Read only the same Home's public provider catalog. Keys retain their private
// file references and are resolved by LakeStore only when the model is used.
export async function importLegacyModelSettings(store: LakeStore) {
  if (store.get("settings", "devProviderImport")) return;
  if (store.list("providers").length) {
    store.put("settings", "devProviderImport", { status: "existing-ts-settings", at: now() });
    return;
  }
  const file = join(store.data, "providers.json");
  let raw: Record<string, any>;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        (process.platform !== "win32" && info.uid !== process.getuid?.()) || info.size > 4 * 1024 * 1024)
      throw new Error("当前实例模型供应商配置权限或大小无效");
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      store.put("settings", "devProviderImport", { status: "no-legacy-catalog", at: now() });
      return;
    }
    throw new Error("无法导入当前 当前实例模型配置，请检查配置文件；旧文件未修改");
  }
  if (!raw || raw.version !== 1 || !Array.isArray(raw.providers) || raw.providers.length > 128)
    throw new Error("当前实例模型供应商配置格式无效；旧文件未修改");
  const providers = raw.providers.map((value: any) => {
    if (!value || typeof value.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(value.id) ||
        typeof value.name !== "string" || typeof value.baseURL !== "string" || !Array.isArray(value.models))
      throw new Error("当前实例模型供应商配置格式无效；旧文件未修改");
    const url = new URL(value.baseURL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash ||
        [...url.searchParams.keys()].some((name) => /key|token|secret/i.test(name)))
      throw new Error("当前实例模型地址必须使用单独的凭据字段");
    const ref = typeof value.credentialRef === "string" ? value.credentialRef : "";
    if (ref && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(ref))
      throw new Error("当前实例模型凭据引用无效");
    // Whitelist public fields; do not spread legacy JSON containing arbitrary
    // headers, credential references, keys or task/security metadata.
    const models: ProviderModel[] = value.models.map((model: any) => {
      if (typeof model?.id !== "string" || typeof model.name !== "string")
        throw new Error("当前实例模型目录格式无效");
      return {
        id: model.id, name: model.name,
        displayName: typeof model.displayName === "string" ? model.displayName : undefined,
        enabled: model.enabled === true,
        contextWindow: Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : undefined,
        supportsImageInput: model.supportsImageInput === true,
        supportsImageOutput: model.supportsImageOutput === true,
        supportsNativeWebSearch: model.supportsNativeWebSearch === true,
        supportsVideoInput: model.supportsVideoInput === true,
        supportsAudioInput: model.supportsAudioInput === true,
        supportsPdfInput: model.supportsPdfInput === true,
        ...( ['auto', 'on', 'off'].includes(model.imageInputMode) ? {imageInputMode: model.imageInputMode} : {}),
        ...(typeof model.imageInputDetected === 'boolean' ? {imageInputDetected: model.imageInputDetected} : {}),
        ...(model.reasoningCapability && Array.isArray(model.reasoningCapability.levels) && model.reasoningCapability.levels.length <= 16 &&
          model.reasoningCapability.levels.every((value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(value)) &&
          (model.reasoningCapability.default === undefined || model.reasoningCapability.levels.includes(model.reasoningCapability.default)) ?
          {reasoningCapability: {levels: [...model.reasoningCapability.levels], default: model.reasoningCapability.default,
            source: typeof model.reasoningCapability.source === 'string' ? model.reasoningCapability.source.slice(0, 80) : undefined}} : {}),
      };
    });
    const provider: ModelProvider = {
      id: value.id, name: value.name, baseURL: value.baseURL,
      protocol: typeof value.protocol === "string" ? value.protocol : "openai",
      enabled: value.enabled === true, keyConfigured: !!ref, models,
    };
    return { provider, ref };
  });
  if (new Set(providers.map(({ provider }) => provider.id)).size !== providers.length)
    throw new Error("当前实例模型供应商 ID 重复");
  store.transaction(() => {
    for (const { provider, ref } of providers) {
      store.put("providers", provider.id, provider);
      if (ref) store.put("providerCredentialRefs", provider.id, ref);
    }
    const selected = providers.find(({ provider }) => provider.id === raw.activeProviderId && provider.enabled)?.provider;
    if (selected?.models.some((model) => model.id === raw.activeModelId && model.enabled)) {
      const native = {providerId: selected.id, modelId: raw.activeModelId};
      store.put('settings', 'nativeModelSelection', native);
      // The old reader preferred connected Magpie unless the user explicitly
      // chose native. Preserve that source choice and its original fallback.
      store.put('settings', 'modelSelection', raw.activeSource === 'native' ? native : {providerId: 'magpie', modelId: ''});
    } else if (raw.activeSource === 'magpie') store.put('settings', 'modelSelection', {providerId: 'magpie', modelId: ''});
    store.put("settings", "devProviderImport", { status: "imported", providers: providers.length, at: now() });
  });
}
