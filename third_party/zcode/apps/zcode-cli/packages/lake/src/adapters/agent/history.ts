import { createHash } from "node:crypto";
import { object, text, type Params } from "../../domain/validation.js";

export function importedLakeHistory(input: Params): Params | undefined {
  const turns = Array.isArray(input.history) ? input.history.map(object) : [];
  if (!turns.length) return undefined;
  const markdown = turns
    .map((turn) => `## User\n${text(turn, "prompt")}\n\n## Assistant\n${text(turn, "answer")}`)
    .join("\n\n");
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  return {
    source: "sharedContext",
    title: "LAKE 历史会话",
    markdown,
    provenance: {
      shareId: `lake-${text(input, "native_session_id")}`,
      projectionSha256: sha(JSON.stringify(turns)),
      artifactSetSha256: sha("[]"),
      formatterVersion: 1,
      markdownSha256: sha(markdown),
      installedArtifacts: [],
    },
  };
}
