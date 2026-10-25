import esbuild from "esbuild";
import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "dist/extension.js");

await esbuild.build({
  entryPoints: [path.join(here, "src/extension.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile,
  external: ["vscode"],
  sourcemap: true,
  banner: {
    js: "const __aidlcImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  define: {
    "import.meta.url": "__aidlcImportMetaUrl",
  },
  alias: {
    aidlc: path.resolve(here, "../../packages/aidlc/src/index.ts"),
  },
});

await cp(path.resolve(here, "../../packages/aidlc/templates"), path.join(here, "dist/templates"), {
  recursive: true,
});
