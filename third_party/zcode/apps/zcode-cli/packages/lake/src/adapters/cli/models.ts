import type { LakeCLIContext } from "../../domain/cli.js";
import type { LakeRuntime } from "../../domain/protocol.js";
import type { JsonValue } from "../../domain/json.js";
import { object, text } from "../../domain/validation.js";
import { FileVault } from "../vault.js";
import { readModelConfig, validIdentifier } from "../config/files.js";
import { flag, readInput, type Arguments } from "./arguments.js";

export async function modelCommand(context: LakeCLIContext, runtime: LakeRuntime, args: Arguments, root: string): Promise<JsonValue> {
  const action = args.positionals[1], config = await readModelConfig(root), providers = object(config.model_providers);
  const dispatch = (params: Record<string, JsonValue>) => runtime.dispatch({ method: "settings", params });
  switch (action) {
    case "ls": {
      const settings = object(await dispatch({ action: "get" }));
      return { current: settings.current_model ?? "", models: (settings.models as Record<string, JsonValue>[]).map(({ name, provider }) => ({ name, provider })) };
    }
    case "use": case "delete": return dispatch({ action: action === "use" ? "model_use" : "model_delete", model: args.positionals[2] ?? "" });
    case "configure": case "add": {
      const provider = validIdentifier(flag(args, "provider", action === "configure" ? "mimo" : "")), previous = object(providers[provider]), model = flag(args, "model");
      await dispatch({ action: "model_save", model, provider, base_url: flag(args, "base-url", text(previous, "base_url")), wire_api: flag(args, "wire-api", text(previous, "wire_api", "anthropic")) });
      if (action === "configure") await dispatch({ action: "model_use", model }); return null;
    }
    case "login": {
      const provider = validIdentifier(flag(args, "provider", "mimo")), input = await readInput(context);
      try {
        const value = input.toString("utf8").trim();
        if (!value || value.length > 65536 || /\s/u.test(value)) throw new Error("API Key 不能为空、过长或含空白");
        const key = Buffer.from(value); try { await new FileVault(root).put("model", provider, key); } finally { key.fill(0); }
        return null;
      } finally { input.fill(0); }
    }
    case "logout": await new FileVault(root).delete("model", validIdentifier(flag(args, "provider", "mimo"))); return null;
    default: throw new Error("用法：lake model configure|add|ls|use|login|logout");
  }
}
