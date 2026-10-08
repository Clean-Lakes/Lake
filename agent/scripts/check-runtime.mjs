export function assertRuntime() {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 14 || (minor === 14 && patch < 0))
    throw new Error(
      "Lake requires Node >=24.14.0 <25; select the agent runtime first",
    );
}
assertRuntime();
