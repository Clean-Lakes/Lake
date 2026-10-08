import pg from "pg";
import type { Resource, ToolResult } from "../domain/entities.js";
import { toolResult } from "../domain/entities.js";
import type { CredentialPort } from "../domain/ports.js";
import { requireCondition, LakeError } from "../domain/errors.js";
import { postgresQueries } from "./postgres-queries.js";
export class PostgresAdapter {
  constructor(private readonly credentials: CredentialPort) {}
  async queryRead(
    resource: Resource,
    operation: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const sql = postgresQueries[operation];
    requireCondition(sql && resource.credentialRef, "scope_denied");
    const endpoint = new URL(resource.endpoint);
    requireCondition(
      ["postgres:", "postgresql:"].includes(endpoint.protocol) &&
        !endpoint.username &&
        !endpoint.password,
      "scope_denied",
    );
    const secret = await this.credentials.resolve(resource.credentialRef);
    let config: {
      user: string;
      password: string;
      ca?: string;
    };
    try {
      config = JSON.parse(Buffer.from(secret).toString());
      requireCondition(
        typeof config.user === "string" && typeof config.password === "string",
        "invalid_input",
      );
    } finally {
      secret.fill(0);
    }
    const client = new pg.Client({
      host: endpoint.hostname,
      port: Number(endpoint.port || 5432),
      database: endpoint.pathname.slice(1),
      user: config.user,
      password: config.password,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      ssl:
        resource.settings.tls === false
          ? false
          : {
              rejectUnauthorized: true,
              ...(config.ca ? { ca: config.ca } : {}),
            },
    });
    requireCondition(
      resource.settings.tls !== false ||
        (resource.environmentId && resource.settings.allowPlaintext === true),
      "scope_denied",
      "Explicit plaintext approval is required",
    );
    const abort = () => {
      void client.end();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      requireCondition(!signal.aborted, "cancelled");
      await client.connect();
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout=5000");
      const result = await client.query(sql);
      await client.query("ROLLBACK");
      return toolResult(
        { rows: result.rows, observedAt: new Date().toISOString() },
        { retryPolicy: "safe_read" },
      );
    } catch (e) {
      if (e instanceof LakeError) throw e;
      throw new LakeError(
        signal.aborted ? "cancelled" : "capability_unavailable",
        "Database probe unavailable",
      );
    } finally {
      signal.removeEventListener("abort", abort);
      await client.end().catch(() => {});
      config.password = "";
    }
  }
}
