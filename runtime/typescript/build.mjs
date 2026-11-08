import {
  readFile,
  readdir,
  mkdir,
  copyFile,
  writeFile,
  cp,
  mkdtemp,
  rm,
  rename,
  chmod,
  realpath,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = join(root, "third_party/agent-sdk");
const require = createRequire(join(source, "package.json"));
const { build } = require("esbuild");
const manifests = new Map();
for (const base of ["packages", "apps/zcode-cli/packages"]) {
  for (const name of await readdir(join(source, base))) {
    const directory = join(source, base, name);
    try {
      const manifest = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      );
      manifests.set(manifest.name, { directory, manifest });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
const destination = join(root, "bin/lake-runtime");
await mkdir(join(root, "bin"), { recursive: true });
const output = await mkdtemp(join(root, "bin/.lake-runtime-build-"));
const bundled = await build({
  absWorkingDir: root,
  metafile: true,
  entryPoints: [join(root, "runtime/typescript/server.ts")],
  outfile: join(output, "server.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  define:{__LAKE_VERSION__:JSON.stringify((await readFile(join(root,'VERSION'),'utf8')).trim())},
  sourcemap: false,
  legalComments: "eof",
  logLevel: "warning",
  external: [
    "koffi",
    "playwright-core",
    "ripgrep",
    "cpu-features",
    "pg-native",
    "./crypto/build/Release/sshcrypto.node",
  ],
  nodePaths: [
    join(source, "node_modules"),
    join(root, "web-agent/node_modules"),
  ],
  plugins: [
    {
      name: "pinned-agent-sdk-source",
      setup(builder) {
        builder.onResolve({ filter: /^ai$/ }, () => ({
          path: require.resolve('ai', {paths: [join(source, 'apps/zcode-cli/packages/adapters')]}),
        }));
        builder.onResolve({ filter: /^ssh2$/ }, (args) => ({
          path: require.resolve(args.path),
        }));
        builder.onResolve(
          { filter: /^@modelcontextprotocol\/client(?:\/stdio)?$/ },
          (args) => ({ path: require.resolve(args.path) }),
        );
        builder.onResolve({ filter: /^@zcode\// }, async (args) => {
          const segments = args.path.split("/");
          const name = segments.slice(0, 2).join("/");
          const entry = manifests.get(name);
          if (!entry) return;
          const subpath =
            segments.length === 2 ? "." : "./" + segments.slice(2).join("/");
          let target = entry.manifest.exports?.[subpath];
          if (target && typeof target === "object")
            target = target.import ?? target.default;
          target ??= subpath === "." ? entry.manifest.main : undefined;
          if (!target)
            throw new Error(`Missing public upstream export ${args.path}`);
          target = target.replace(/^\.\/dist\//, "./src/");
          const resolved = await builder.resolve(
            join(entry.directory, target),
            {
              kind: args.kind,
              resolveDir: entry.directory,
            },
          );
          return { path: resolved.path, errors: resolved.errors };
        });
      },
    },
  ],
});
await copyFile(
  join(root, "runtime/typescript/upstream.json"),
  join(output, "upstream.json"),
);
await mkdir(join(output, "licenses"), { recursive: true });
for (const file of ["LICENSE", "NOTICE.md", "THIRD-PARTY-NOTICES.md"]) {
  await copyFile(join(source, file), join(output, "licenses", file));
}
await copyFile(
  join(source, "node_modules/@modelcontextprotocol/client/LICENSE"),
  join(output, "licenses/MCP-client-LICENSE"),
);
await copyFile(
  join(source, "node_modules/ssh2/LICENSE"),
  join(output, "licenses/ssh2-LICENSE"),
);
// Preserve production notices for the bundled MySQL and image dependencies.
const bundledInputs = Object.keys(bundled.metafile.inputs).map((path) =>
  resolve(root, path),
);
const dependencyNotices = [],
  dependencySeen = new Set();
let noticePrefix = "mysql";
async function copyDependencyNotices(entry) {
  let directory = dirname(entry),
    manifest;
  while (!manifest?.name) {
    try {
      manifest = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!manifest?.name) {
      const parent = dirname(directory);
      if (parent === directory)
        throw new Error("Missing runtime dependency manifest");
      directory = parent;
    }
  }
  const actual = await realpath(directory);
  if (!bundledInputs.some((path) => path.startsWith(actual + "/"))) return;
  const key = manifest.name + "@" + manifest.version;
  if (dependencySeen.has(noticePrefix + key)) return;
  dependencySeen.add(noticePrefix + key);
  let copied = false;
  for (const file of await readdir(directory))
    if (/^(?:licen[cs]e|notice|copyright)(?:[._-].*)?$/i.test(file)) {
      await copyFile(
        join(directory, file),
        join(
          output,
          "licenses",
          noticePrefix + "-" + key.replaceAll("/", "_") + "-" + file,
        ),
      );
      if (/^licen[cs]e(?:[._-].*)?$/i.test(file)) copied = true;
    }
  if (!copied && manifest.name === "omggif") {
    const header = (
      await readFile(join(directory, manifest.main), "utf8")
    ).split('"use strict"')[0];
    if (
      !header.includes("Permission is hereby granted") ||
      !header.includes("THE SOFTWARE IS PROVIDED")
    )
      throw new Error("Missing pinned omggif source license");
    await writeFile(
      join(output, "licenses", noticePrefix + "-" + key + "-SOURCE-NOTICE.txt"),
      header,
    );
    copied = true;
  }
  if (!copied && key === "parse-bmfont-ascii@1.0.6") {
    await copyFile(
      join(root, "runtime/typescript/licenses/parse-bmfont-ascii-1.0.6-LICENSE.md"),
      join(output, "licenses/image-parse-bmfont-ascii@1.0.6-LICENSE.md"),
    );
    copied = true;
  }
  if(!copied&&['pg-types@2.2.0','pgpass@1.0.5'].includes(key)){
    const readme=await readFile(join(directory,'README.md'),'utf8'),start=readme.search(/^## [Ll]icense\s*$/m),license=readme.slice(start);
    if(start<0||!license.includes('Permission is hereby granted, free of charge')||!license.includes('THE SOFTWARE IS PROVIDED "AS IS"'))throw new Error('Missing pinned PostgreSQL dependency license');
    await writeFile(join(output,'licenses',noticePrefix+'-'+key+'-README-LICENSE.md'),license);copied=true;
  }
  if(!copied&&key==='@redis/client@6.3.1'){
    await copyFile(join(root,'runtime/typescript/licenses/redis-client-6.3.1-LICENSE.md'),join(output,'licenses/service-redis-client-6.3.1-LICENSE.md'));copied=true;
  }
  if (!copied) throw new Error("Missing license for runtime dependency " + key);
  dependencyNotices.push({
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
  });
  const dependencyRequire = createRequire(join(directory, "package.json"));
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    let entry;
    try {
      entry = dependencyRequire.resolve(name);
    } catch (error) {
      if (
        !["MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"].includes(
          error.code,
        )
      )
        throw error;
      for (const base of dependencyRequire.resolve.paths(name) ?? []) {
        const candidate = join(base, name, "package.json");
        try {
          await readFile(candidate);
          entry = candidate;
          break;
        } catch (missing) {
          if (missing.code !== "ENOENT") throw missing;
        }
      }
      if (!entry) throw error;
    }
    await copyDependencyNotices(entry);
  }
}
await copyDependencyNotices(
  createRequire(join(root, "web-agent/package.json")).resolve("mysql2"),
);
await writeFile(
  join(output, "licenses/mysql-dependencies.json"),
  JSON.stringify(dependencyNotices, null, 2),
);
dependencyNotices.length = 0;
noticePrefix = 'services';
for(const name of ['pg','@redis/client'])await copyDependencyNotices(createRequire(join(root,'web-agent/package.json')).resolve(name));
await writeFile(join(output,'licenses/service-dependencies.json'),JSON.stringify(dependencyNotices,null,2));
dependencyNotices.length = 0;
noticePrefix = "image";
await copyDependencyNotices(require.resolve("jimp"));
await writeFile(
  join(output, "licenses/image-dependencies.json"),
  JSON.stringify(dependencyNotices, null, 2),
);
// Native PTY stays outside the SEA bundle so Node can dlopen the pinned addon.
const ptySource = dirname(require.resolve("node-pty/package.json"));
const ptyOutput = join(output, "native/node-pty");
await mkdir(ptyOutput, { recursive: true });
for (const file of ["lib", "prebuilds", "package.json"])
  await cp(join(ptySource, file), join(ptyOutput, file), { recursive: true });
await chmod(
  join(ptyOutput, `prebuilds/${process.platform}-${process.arch}/spawn-helper`),
  0o755,
);
await copyFile(
  join(ptySource, "LICENSE"),
  join(output, "licenses/node-pty-LICENSE"),
);
await cp(join(root, "internal/web/hooks"), join(output, "hooks"), {
  recursive: true,
});
await writeFile(
  join(output, "licenses/Lake-modifications.md"),
  "Lake embeds ZCode 3.17.2 AgentRuntime and Node adapters in a TypeScript HTTP host. " +
    "The upstream UI and optional contributor presentation are not included. " +
    "Upstream source files, copyright, LICENSE, NOTICE and third-party attribution are preserved.\n",
);
await cp(join(root, "web-agent/web/dist"), join(output, "web"), {
  recursive: true,
});
await copyFile(
  join(dirname(dirname(process.execPath)), "LICENSE"),
  join(output, "licenses/Node-LICENSE"),
);
await rm(destination, { recursive: true, force: true });
await rename(output, destination);
await writeFile(
  join(root, "bin/lake-sea.json"),
  JSON.stringify({
    main: join(destination, "server.cjs"),
    output: join(root, "bin/lake-sea.blob"),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }),
);
console.log("Built Lake TypeScript runtime from pinned v3.17.2 source");
