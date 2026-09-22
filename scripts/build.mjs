import { build } from "esbuild";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node24",
  sourcemap: true,
  sourcesContent: false,
};

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/mcp/handler.ts"],
    outfile: "dist/mcp/handler.cjs",
  }),
  build({
    ...common,
    entryPoints: ["src/executor/handler.ts"],
    outfile: "dist/executor/handler.cjs",
  }),
]);

const bundledHandlers = await Promise.all(
  ["dist/mcp/handler.cjs", "dist/executor/handler.cjs"].map(
    (path) => import(pathToFileURL(resolve(path)).href),
  ),
);

for (const bundledHandler of bundledHandlers) {
  if (typeof bundledHandler.handler !== "function") {
    throw new Error("A bundled Lambda artifact does not export handler");
  }
}
