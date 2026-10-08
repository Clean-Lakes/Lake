import type { StorePort } from "../domain/ports.js";
import type { Exchange } from "./history.js";
export async function recoverPendingExchanges(
  store: StorePort,
): Promise<Exchange[]> {
  return (await store.list<Exchange>("model_exchanges")).filter(
    (e) => e.status === "pending",
  );
}
