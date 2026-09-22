import { build } from "esbuild";

const common = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  sourcesContent: false,
};

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/mcp/handler.ts"],
    outfile: "dist/mcp/handler.mjs",
  }),
  build({
    ...common,
    entryPoints: ["src/executor/handler.ts"],
    outfile: "dist/executor/handler.mjs",
  }),
]);
