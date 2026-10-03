import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiKeyAccessConfig, ProviderApiConfig, ProviderConfig, ProviderConfigMap, ModelConfig, ModelConfigRules, ModelPropertiesConfig, ModelInputFormatConfig, ModelOptionSpecsConfig, LimitOptionSpecConfig, EnumOptionSpecConfig } from '@zcode/provider';
import { NodePersonalProviderConfigRepository, PERSONAL_PROVIDER_CONFIG_FILE_NAME } from '@zcode/provider-node';
import { readModelConfig } from '../config/files.js';
import { FileVault } from '../vault.js';
import { object } from '../../domain/validation.js';

/** One-time import from LAKE-owned files only. Never read upstream ZCode settings or Keychain. */
export async function importLakeNativeModels(root: string): Promise<void> {
  const filePath = join(root, 'v2', PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  try { await access(filePath); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const legacy = await readModelConfig(root), catalog = object(legacy.model_catalog), specs = object(legacy.model_providers);
  if (!Object.keys(catalog).length) return;
  const vault = new FileVault(root);
  const repository = new NodePersonalProviderConfigRepository({ filePath, pollingIntervalMs: false });
  try {
    let providers = ProviderConfigMap.empty(), models = ModelConfigRules.empty();
    for (const [providerId, raw] of Object.entries(specs)) {
      const spec = object(raw), modelIds = Object.keys(catalog).filter(model => catalog[model] === providerId);
      if (!modelIds.length || !spec.base_url) continue;
      if (!(await vault.has('model', providerId))) continue;
      const key = await vault.load('model', providerId);
      try {
        const type = spec.wire_api === 'openai_chat' ? 'openai-chat-completions' : spec.wire_api === 'openai_responses' ? 'openai-responses' : 'anthropic-messages';
        providers = providers.setRule({ providerId, config: new ProviderConfig({ group: 'standard-personal', api: new ProviderApiConfig({ type, baseUrl: String(spec.base_url) }), access: new ApiKeyAccessConfig({ apiKey: key.toString() }), personalModelIds: modelIds, modelOrder: modelIds }) });
      } finally { key.fill(0); }
      for (const modelId of modelIds) models = models.setExact(providerId, modelId, new ModelConfig({
        properties: new ModelPropertiesConfig({ contextWindow: Number(legacy.context_window ?? 32000), supportsJsonSchemaOutput: false, supportsNativeWebSearch: false, supportsMidConversationSystem: false,
          inputFormat: new ModelInputFormatConfig({ supportsImage: false, supportsVideo: false, supportsPdf: false }) }),
        optionSpecs: new ModelOptionSpecsConfig({ maxOutputTokens: new LimitOptionSpecConfig({ max: Number(legacy.max_output_tokens ?? 4096) }), reasoningLevel: new EnumOptionSpecConfig({ values: ['default'], map: '{}' }) }),
      }), false);
    }
    if (!providers.toJSON().length) return;
    await repository.update(current => current.providers.toJSON().length ? current : ({ providers, models,
      ...(legacy.model && legacy.model_provider ? { defaultModelSelection: { providerId: String(legacy.model_provider), modelId: String(legacy.model) } } : {}) }));
  } finally { repository.dispose(); }
}
