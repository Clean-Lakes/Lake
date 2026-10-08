import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const root = resolve(import.meta.dirname, ".."),
  repo = resolve(root, "..");
const hash = (content) => createHash("sha256").update(content).digest("hex");
export async function collectReleaseEvidence() {
  const suites = {};
  for (const name of ["unit", "integration", "acceptance"]) {
    const log = await readFile(
      join(root, "test-results", name + ".log"),
      "utf8",
    );
    const count = (kind) =>
      Number(log.match(new RegExp("(?:ℹ|#) " + kind + " (\\d+)"))?.[1] ?? -1);
    suites[name] = {
      tests: count("tests"),
      passed: count("pass"),
      failed: count("fail"),
      skipped: count("skipped"),
      sha256: hash(log),
    };
    if (
      suites[name].tests < 1 ||
      suites[name].failed !== 0 ||
      suites[name].skipped !== 0
    )
      throw new Error("Required suite is missing or failed: " + name);
  }
  const pointer = JSON.parse(
      await readFile(join(root, "dist/release.json"), "utf8"),
    ),
    manifest = JSON.parse(
      await readFile(join(repo, "bin", pointer.path, "manifest.json"), "utf8"),
    ),
    benchmark = JSON.parse(
      await readFile(join(root, "test-results/benchmark-linux.json"), "utf8"),
    );
  if (!benchmark.passed || !(benchmark.peakRssMiB>0) || benchmark.cgroupCpuMax!=='400000 100000' || benchmark.cgroupMemoryMax!=='8589934592') throw new Error("Benchmark gate failed or measurement is unavailable");
  const evidence = {
    schemaVersion: 1,
    version: "0.0.1",
    recordedAt: new Date().toISOString(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim(),
    branch: execFileSync("git", ["branch", "--show-current"], {
      cwd: repo,
      encoding: "utf8",
    }).trim(),
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    lockSha256: hash(await readFile(join(root, "pnpm-lock.yaml"))),
    suites,
    benchmark,
    release: {
      path: pointer.path,
      digest: manifest.digest,
      node: manifest.nodeVersion,
      platform: manifest.platform,
      arch: manifest.arch,
    },
    signingIdentity:
      process.platform === "darwin"
        ? "Lake Local Development Code Signing"
        : null,
    externalProviderSmoke: "not_run",
    productionEnvironment: "not_run",
  };
  await mkdir(join(root, "test-results"), { recursive: true });
  await writeFile(
    join(root, "test-results/release-evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      version: evidence.version,
      branch: evidence.branch,
      suites: evidence.suites,
      release: evidence.release,
      externalProviderSmoke: evidence.externalProviderSmoke,
    }),
  );
  return evidence;
}
await collectReleaseEvidence();
