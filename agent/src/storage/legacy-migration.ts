import { spawn } from "node:child_process";
import { z } from "zod";
import { join } from "node:path";
import { CredentialStore } from "./credentials.js";
import { Redactor } from "./redaction.js";
import { requireCondition } from "../domain/errors.js";
const Manifest = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(
      z
        .object({
          kind: z.enum(["model", "ssh"]),
          legacyId: z.string().min(1),
          newCredentialId: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/),
        })
        .strict(),
    ),
  })
  .strict();
export async function migrateFromSignedPipe(
  home: string,
  input: unknown,
): Promise<void> {
  requireCondition(
    process.platform === "darwin" &&
      process.env.LAKE_EXPLICIT_SECRET_MIGRATION === "1" &&
      process.env.LAKE_SIGNED_LAUNCHER,
    "scope_denied",
    "Legacy migration requires the signed launcher",
  );
  await migrateCredentialEntries(home, input, async (entry) => {
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        process.env.LAKE_SIGNED_LAUNCHER!,
        [
          "__legacy_keychain",
          entry.kind === "model" ? "load-model" : "load-ssh",
          entry.legacyId,
        ],
        {
          stdio: ["ignore", "ignore", "ignore", "pipe"],
          env: { ...process.env, LAKE_EXPLICIT_SECRET_MIGRATION: "1" },
        },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      const stream = child.stdio[3];
      requireCondition(stream, "scope_denied");
      stream.on("data", (b: Buffer) => {
        size += b.length;
        if (size > 262144) {
          child.kill();
          reject(new Error("Migration failed"));
        } else chunks.push(b);
      });
      child.on("error", () => reject(new Error("Migration failed")));
      child.on("close", (code) =>
        code === 0
          ? resolve(Buffer.concat(chunks))
          : reject(new Error("Migration failed")),
      );
    });
  });
}
// The trusted pipe port allows synthetic migration tests without touching Keychain.
export async function migrateCredentialEntries(
  home: string,
  input: unknown,
  readLegacy: (entry: {
    kind: "model" | "ssh";
    legacyId: string;
  }) => Promise<Buffer>,
): Promise<void> {
  const manifest = Manifest.parse(input),
    store = new CredentialStore(join(home, "secrets"), new Redactor());
  for (const entry of manifest.entries) {
    const secret = await readLegacy(entry);
    const ref =
      (entry.kind === "model" ? "models" : "ssh") + "/" + entry.newCredentialId;
    try {
      let old: Uint8Array | undefined;
      try {
        old = await store.resolve(ref);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (old) {
        requireCondition(
          Buffer.from(old).equals(secret),
          "conflict",
          "Credential mapping already has a different value",
        );
        old.fill(0);
      } else await store.import(ref, secret);
    } finally {
      secret.fill(0);
    }
  }
}
