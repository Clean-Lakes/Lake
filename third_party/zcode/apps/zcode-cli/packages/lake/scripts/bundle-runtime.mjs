import { build } from "esbuild";
import { resolveBuildAliases, createZodDedupePlugin, readZodBuildVersion } from "../../cli/scripts/build.mjs";
// Use the upstream source aliases and Zod identity guard for the native graph.
const expectedV4Version=await readZodBuildVersion();
for (const entry of ["dist/contract.js", "dist/adapters/agent/agent.js", "dist/adapters/config/settings.js"]) await build({ entryPoints: [entry], outfile: entry, allowOverwrite: true, bundle: true, platform: "node", format: "esm", target: "node24", metafile:true, alias:resolveBuildAliases(), plugins:[createZodDedupePlugin({expectedV4Version})], external: ["@modelcontextprotocol/core", "@modelcontextprotocol/core/*", "@modelcontextprotocol/client", "@modelcontextprotocol/client/*", "typescript", "ssh2", "node-pty", "koffi", "playwright-core", "@zcode/tui", "mysql2/promise", "pg"], banner: { js: 'import { createRequire as createLakeRequire } from "node:module"; const require = createLakeRequire(import.meta.url);' } });

await build({entryPoints:['src/adapters/native-data/entry.ts'],outfile:'dist/lake-data.cjs',bundle:true,metafile:true,platform:'node',format:'cjs',target:'node24',alias:resolveBuildAliases(),plugins:[createZodDedupePlugin({expectedV4Version})]});
for (const entry of ['dist/adapters/native-data/service.js','dist/adapters/native-data/mcp.js']) await build({ entryPoints:[entry],outfile:entry,allowOverwrite:true,bundle:true,metafile:true,platform:'node',format:'esm',target:'node24',alias:resolveBuildAliases(),plugins:[createZodDedupePlugin({expectedV4Version})] });
