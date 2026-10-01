import { build } from "esbuild";
await build({ entryPoints: ["src/lake-host.ts"], outfile: "dist/lake-host.js", platform: "node", format: "esm", bundle: true, target: "node24", external: ["node-pty"], banner: { js: 'import { createRequire as createHostRequire } from "node:module"; const require = createHostRequire(import.meta.url);' } });
