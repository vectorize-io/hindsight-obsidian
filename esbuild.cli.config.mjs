import esbuild from "esbuild";
import { builtinModules as builtins } from "node:module";

await esbuild.build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["node:*", ...builtins],
  outfile: "dist/hindsight-obsidian-sync.mjs",
  sourcemap: false,
  treeShaking: true,
});
