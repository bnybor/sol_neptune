import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { countTokens as cl100k } from "gpt-tokenizer/encoding/cl100k_base";

// Private captured inputs stay outside the repository. Capture them against one
// verified isolated mirror snapshot; every missing query must use that same one.
const directory = resolve(process.argv[2] ?? "");
if (!process.argv[2])
  throw new Error("Pass a private benchmark working directory.");
await mkdir(directory, { recursive: true });
if (!process.argv.includes("--reuse-bundles")) {
  const { build } = await import("esbuild");
  await build({
    entryPoints: ["src/executor/search.ts", "src/shared/compact-graphson.ts"],
    outdir: directory,
    entryNames: "[name]",
    format: "esm",
    platform: "node",
    target: "node24",
    bundle: true,
    external: ["gpt-tokenizer/*", "zod"],
    outExtension: { ".js": ".mjs" },
  });
}
const { searchGremlin } = await import(
  pathToFileURL(resolve(directory, "search.mjs"))
);
const { compactSearchResult, decodeCompactGraphson, compactTokenCount } =
  await import(pathToFileURL(resolve(directory, "compact-graphson.mjs")));
const manifest = JSON.parse(
  await readFile(resolve(directory, "manifest.json"), "utf8"),
);
let captured = {};
try {
  captured = JSON.parse(
    await readFile(resolve(directory, "captured.json"), "utf8"),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const missing = new Set();
const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
let native;
let waiting;
if (process.argv.includes("--native-jar")) {
  native = spawn(
    "java",
    [
      "-Xmx1536m",
      "-cp",
      flag("--native-jar"),
      flag("--runner"),
      flag("--snapshot"),
      manifest.source_fingerprint,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  native.stderr.on("data", (data) => {
    stderr += data;
  });
  const lines = createInterface({ input: native.stdout });
  lines.on("line", (line) => {
    const pending = waiting;
    waiting = undefined;
    if (!pending) throw new Error("Unsolicited native query result");
    try {
      pending.resolve(JSON.parse(line));
    } catch (error) {
      pending.reject(error);
    }
  });
  native.on("error", (error) => waiting?.reject(error));
  native.on("exit", (code) => {
    if (code !== 0 || waiting)
      waiting?.reject(
        new Error(
          `Native snapshot runner failed (${code}): ${stderr.slice(0, 1000)}`,
        ),
      );
  });
}
const backend = {
  streamHead: async () => manifest.cursor,
  query: async (query) => {
    if (!Object.hasOwn(captured, query)) {
      if (native) {
        captured[query] = await new Promise((resolve, reject) => {
          waiting = { resolve, reject };
          native.stdin.write(JSON.stringify(query) + "\n");
        });
        await writeFile(
          resolve(directory, "captured.json"),
          JSON.stringify(captured),
          { mode: 0o600 },
        );
      } else {
        missing.add(query);
        throw new Error("MISSING_CAPTURE");
      }
    }
    return captured[query];
  },
};
const scopes = "g.V('N1001','N1002')";
const scenarios = [
  { name: "scalar-count", query: "g.V().count()", depth: 0 },
  { name: "repeat-scalars", query: "g.inject(1,1,false,null,'r')", depth: 0 },
  {
    name: "working-set-summary",
    query:
      "g.V().has('object_type','ACTIVE_DISCUSSION').has('state','active').has('visibility_scopes','robyn_authenticated').order().by('last_touched_at',desc).by('salience',desc).limit(12).valueMap(true,'topic_key','label','state','canonical_summary','open_question','last_touched_at','last_terminal','salience')",
    depth: 0,
  },
  { name: "source-text", query: "g.V('S1003154','S1003158')", depth: 0 },
  {
    name: "compound-terminal",
    query:
      "g.V('S1003154','S1003158').valueMap(true,'canonical','source_actor')",
    depth: 0,
  },
  {
    name: "expanded-source",
    query: "g.V('S1003154')",
    depth: 2,
    blacklist_query: scopes,
  },
  {
    name: "edge-neighborhood",
    query: "g.V('S1003154').bothE().limit(2)",
    depth: 2,
    blacklist_query: scopes,
  },
  {
    name: "fold-neighborhood",
    query: "g.V().has('label','shaped_like').limit(1).out('subject')",
    depth: 1,
    blacklist_query: scopes,
  },
];
const rows = [];
const envelope = (result) => ({
  ok: true,
  result,
  meta: {
    request_id: "compact-benchmark",
    elapsed_ms: 0,
    result_bytes: Buffer.byteLength(JSON.stringify(result)),
    retry_safe: false,
  },
});
for (const { name, ...input } of scenarios) {
  let result;
  try {
    result = await searchGremlin(input, backend, { deadlineMs: 60_000 });
  } catch (error) {
    if (error.message === "MISSING_CAPTURE") continue;
    throw error;
  }
  const start = performance.now();
  const compact = compactSearchResult(result);
  const elapsed = performance.now() - start;
  const transported = JSON.parse(JSON.stringify(compact));
  // Null-prototype hydration records have the same JSON meaning as ordinary
  // records. structuredClone normalizes that implementation detail while
  // retaining exact scalar types, negative zero, field presence and order.
  if (
    !isDeepStrictEqual(
      decodeCompactGraphson(transported),
      structuredClone(result.graph),
    )
  )
    throw new Error(`Typed round trip failed: ${name}`);
  if (!isDeepStrictEqual(compact.search, result.search))
    throw new Error(`Metadata mismatch: ${name}`);
  const graphson = JSON.stringify(envelope(result)),
    encoded = JSON.stringify(envelope(compact));
  const count = (text) => ({
    o200k_base: compactTokenCount(text),
    cl100k_base: cl100k(text, { disallowedSpecial: new Set() }),
  });
  rows.push({
    name,
    input,
    graphson_bytes: Buffer.byteLength(graphson),
    compact_bytes: Buffer.byteLength(encoded),
    graphson_tokens: count(graphson),
    compact_tokens: count(encoded),
    dictionary_entries: compact.dictionary.length,
    encode_ms: Number(elapsed.toFixed(3)),
    nodes: result.search.node_count,
    hops: result.search.hop_count,
    exact_typed_round_trip: true,
  });
  await writeFile(resolve(directory, `${name}.graphson.json`), graphson, {
    mode: 0o600,
  });
  await writeFile(resolve(directory, `${name}.compact.json`), encoded, {
    mode: 0o600,
  });
}
if (missing.size) {
  await writeFile(
    resolve(directory, "missing-queries.json"),
    JSON.stringify([...missing]),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      missing_queries: [...missing],
      complete_scenarios: rows.length,
    }),
  );
} else {
  const report = {
    captured_queries: Object.keys(captured).length,
    capture_sha256: createHash("sha256")
      .update(JSON.stringify(captured))
      .digest("hex"),
    tokenizer_package: "gpt-tokenizer@4.0.0",
    counted_representation:
      "minified complete execution envelope including grammar, dictionary, search and byte metadata",
    snapshot: manifest,
    rows,
  };
  await writeFile(
    resolve(directory, "benchmark.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
}
if (native) {
  native.stdin.end();
  await writeFile(
    resolve(directory, "captured.json"),
    JSON.stringify(captured),
    { mode: 0o600 },
  );
}
