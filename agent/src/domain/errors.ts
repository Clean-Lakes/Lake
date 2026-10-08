export const errorCodes = [
  "invalid_input",
  "not_found",
  "conflict",
  "unauthorized",
  "scope_denied",
  "approval_required",
  "approval_expired",
  "identity_mismatch",
  "precondition_failed",
  "capability_unavailable",
  "prerequisite_missing",
  "timeout",
  "cancelled",
  "unknown_effect",
  "budget_exhausted",
  "context_exhausted",
  "no_progress",
  "model_protocol_error",
  "output_limit",
  "storage_error",
  "daemon_already_running",
] as const;
export type ErrorCode = (typeof errorCodes)[number];
export class LakeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string = code,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "LakeError";
  }
}
export interface PublicError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: { fields: string[] };
}
export function publicError(error: unknown): PublicError {
  if (error instanceof ZodError) {
    const known = new Set([
      "id",
      "revision",
      "lakeId",
      "environmentId",
      "resourceId",
      "resourceIds",
      "resources",
      "services",
      "lakes",
      "environments",
      "name",
      "endpoint",
      "identity",
      "kind",
      "settings",
      "credentialRef",
      "model",
      "providers",
      "providerId",
      "defaultProvider",
      "supportsTools",
      "supportsStreaming",
      "contextWindowTokens",
      "maxOutputTokens",
      "budget",
      "maxCalls",
      "maxTokens",
      "objective",
      "intent",
      "constraints",
      "acceptanceCriteria",
      "type",
      "required",
      "parameters",
      "requestId",
      "expectedRevision",
      "data",
      "effects",
      "path",
      "artifactId",
      "expectedHash",
      "terminalId",
      "epoch",
      "confirmed",
      "status",
      "profile",
      "workOrder",
      "state",
      "deadline",
    ]);
    const fields = [
      ...new Set(
        error.issues
          .slice(0, 16)
          .map((issue) =>
            issue.path
              .map((p) =>
                typeof p === "number"
                  ? String(p)
                  : known.has(String(p))
                    ? String(p)
                    : "*",
              )
              .join("."),
          ),
      ),
    ];
    return {
      code: "invalid_input",
      message: "Input fields failed validation",
      retryable: false,
      details: { fields },
    };
  }
  return error instanceof LakeError
    ? { code: error.code, message: error.message, retryable: error.retryable }
    : { code: "invalid_input", message: "Operation failed", retryable: false };
}
export function requireCondition(
  value: unknown,
  code: ErrorCode,
  message?: string,
): asserts value {
  if (!value) throw new LakeError(code, message);
}
import { ZodError } from "zod";
