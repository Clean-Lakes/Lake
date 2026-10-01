import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { LakeEvent, LakeRuntime, LakeRuntimeOptions } from "../domain/protocol.js";
import { LakeApplication } from "../app/runtime.js";
import { LakeDatabase, newID } from "./storage/database.js";
import { LakeData } from "./storage/data.js";
import { FileVault } from "./vault.js";
import { LakeSettings } from "./config/settings.js";
import { OperationsTransport } from "./execution/transport.js";
import { LakeZCodeAgent } from "./agent/agent.js";
import { NativeRemoteHost } from "./native/remote.js";
import { NativeDesktopHost } from "./native/host.js";

export async function createLakeRuntime(options: LakeRuntimeOptions = {}): Promise<LakeRuntime> {
  const root = resolve(options.root ?? process.env.LAKE_HOME ?? join(homedir(), ".lake"));
  const database = await LakeDatabase.open(root), data = new LakeData(database), vault = new FileVault(root);
  const listeners = new Set<(event: LakeEvent) => void>();
  const emit = (event: LakeEvent) => { for (const listener of listeners) listener(event); };
  const remote = new NativeRemoteHost(data,vault,emit);
  const application = new LakeApplication({ data, settings: new LakeSettings(root, vault), execution: new OperationsTransport(vault), agent: new LakeZCodeAgent(root, vault, options,(id,signal)=>remote.agent(id,signal)), native: new NativeDesktopHost(data, emit,remote,root), options: { ...options, root }, id: newID, digest: input => createHash("sha256").update(input).digest("hex"),
    emit,
  });
  return {
    dispatch: command => application.dispatch(command),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    close: async () => { await application.close(); await remote.close(); listeners.clear(); },
  };
}
