import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { object, text, type Params } from "../../domain/validation.js";
import { atomicFile } from "../config/files.js";

export function modelSelection(config: Params): Params {
  const reasoning = text(config, "model_reasoning_effort", "default");
  return {
    providerId: "lake",
    modelId: text(config, "model"),
    options: { reasoningLevel: reasoning === "none" ? "disabled" : reasoning },
  };
}
export async function prepareAgentConfig(
  directory: string,
  cliPath: string,
  config: Params,
  url: string,
  token: string,
): Promise<void> {
  const builtin = object(
    JSON.parse(await readFile(join(dirname(cliPath), "builtin.json"), "utf8")),
  );
  const provider = object(object(config.model_providers)[text(config, "model_provider")]),
    wire = text(provider, "wire_api", "anthropic");
  const api = {
    anthropic: "anthropic-messages",
    openai_chat: "openai-chat-completions",
    openai_responses: "openai-responses",
  }[wire];
  if (!api) throw new Error("当前模型协议不受支持");
  object(builtin.config).providerConfigRules = {
    templateRules: [],
    providerRules: [
      {
        providerId: "lake",
        providerName: "Lake TypeScript model gateway",
        config: {
          group: "zai-family",
          access: { type: "api-key", apiKey: token },
          api: { type: api, baseUrl: url + "/model" },
          builtinModelIds: [text(config, "model")],
        },
      },
    ],
  };
  let reasoningMap =
    'reasoningLevel == "default" || reasoningLevel == "disabled" ? {} : {"reasoning_effort": reasoningLevel}';
  let limitMap = '{"max_completion_tokens": maxOutputTokens}';
  if (wire === "anthropic") {
    reasoningMap =
      'reasoningLevel == "default" ? {} : {"thinking": {"type": reasoningLevel == "disabled" ? "disabled" : "enabled"}}';
    limitMap = '{"max_tokens": maxOutputTokens}';
  }
  if (wire === "openai_responses") {
    reasoningMap =
      'reasoningLevel == "default" || reasoningLevel == "disabled" ? {} : {"reasoning": {"effort": reasoningLevel}}';
    limitMap = '{"max_output_tokens": maxOutputTokens}';
  }
  const rule = {
    providerId: "lake",
    modelId: text(config, "model"),
    config: {
      enabled: true,
      properties: {
        inputFormat: { supportsImage: true },
        contextWindow: config.context_window ?? 32000,
      },
      optionSpecs: {
        reasoningLevel: {
          values: [
            "default",
            "disabled",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra",
          ],
          map: reasoningMap,
        },
        maxOutputTokens: { max: config.max_output_tokens ?? 4096, map: limitMap },
      },
    },
  };
  await atomicFile(join(directory, "builtin.json"), JSON.stringify(builtin));
  await atomicFile(
    join(directory, "personal.json"),
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [rule], manualProviderModelRules: [] },
        defaultModelSelection: modelSelection(config),
      },
    }),
  );
}
