import {
  COMPACT_GRAMMAR,
  compactSearchResult,
  compactTokenCount,
  decodeCompactGraphson,
  encodeCompactGraphson,
} from "../src/shared/compact-graphson.js";
import { graphsonMap, typed } from "../src/shared/graphson.js";

function roundTrip(value: unknown): unknown {
  return decodeCompactGraphson(
    JSON.parse(JSON.stringify(encodeCompactGraphson(value))),
  );
}
describe("compact typed graph codec", () => {
  it("preserves deeply nested legal compound values without an additional nesting cap", () => {
    let value: unknown = "deep";
    for (let i = 0; i < 160; i++) value = typed("g:List", [value]);
    expect(roundTrip(value)).toEqual(value);
  });
  it("chooses key and value references independently and factors only synthetic identity fields", () => {
    const short = encodeCompactGraphson(
      Array.from({ length: 20 }, () => ({ source_actor: "source_actor" })),
    );
    expect(short.dictionary).toContain("source_actor");
    const keyIndex = short.dictionary.indexOf("source_actor");
    expect(short.graph).toEqual(
      Array.from({ length: 20 }, () => ["o", keyIndex, "source_actor"]),
    );
    const base =
      "search:value:8e5293b5ae33ce8093a617ec4409865017a2e7665dd49efc71e461020bc4314c";
    const prose = `This exact ${base}:value reference stays in ordinary prose.`;
    const graph = {
      id: base,
      properties: Object.fromEntries(
        [
          "kind",
          "value",
          "min_depth",
          "blacklisted",
          "expanded",
          "stop_reason",
          "query_positions",
        ].map((key) => [
          key,
          { id: `${base}:${key}`, label: key, value: false },
        ]),
      ),
      canonical: prose,
    };
    const compact = encodeCompactGraphson(graph);
    expect(compact.dictionary).toContain(base);
    expect(JSON.stringify(compact.graph)).toContain(prose);
    expect(roundTrip(graph)).toEqual(graph);
    expect(compactTokenCount(JSON.stringify(compact))).toBeLessThan(
      compactTokenCount(JSON.stringify(graph)),
    );
  });
  it("retains exact types, arbitrary map keys, order, empty and missing values", () => {
    const value = graphsonMap({
      all: typed("g:List", [
        null,
        false,
        true,
        "",
        {},
        [],
        typed("g:Int32", 1),
        typed("g:Int64", 1),
        typed("gx:BigInteger", "9007199254740993"),
        typed("gx:BigDecimal", "1234567890.12345678901234567890"),
        typed("g:Float", "NaN"),
        typed("g:Double", "Infinity"),
        typed("g:Double", -0),
        typed("g:Date", 1791920000000),
        typed("vendor:future", { arbitrary: ["r", 0] }),
        "Unicode: 🐌 é 日本語; <|endoftext|>",
      ]),
      keys: typed("g:Map", [
        typed("g:Int32", 2),
        "integer key",
        typed("g:Int64", 2),
        "long key",
        null,
        false,
      ]),
      set: typed("g:Set", ["B", "A"]),
      path: typed("g:Path", {
        labels: typed("g:List", [typed("g:Set", ["here"])]),
        objects: typed("g:List", [1]),
      }),
      extra: { "@type": "g:Int32", "@value": 2, extra: "preserved" },
    });
    expect(roundTrip(value)).toEqual(value);
    const source = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"literal","0":false,"r":["r",0],"a":[],"t":{"@value":null}}',
    ) as unknown;
    expect(roundTrip(source)).toEqual(source);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("retains element identity, cardinality, positions, topology and every metadata field", () => {
    const graph = graphsonMap({
      vertices: typed("g:List", [
        typed("g:Vertex", {
          id: "same",
          label: "vertex",
          properties: {
            values: [
              typed("g:VertexProperty", {
                id: "p1",
                label: "values",
                value: 1,
              }),
              typed("g:VertexProperty", {
                id: "p2",
                label: "values",
                value: 2,
                properties: { scope: "private" },
              }),
            ],
            query_positions: [
              typed("g:VertexProperty", {
                id: "q",
                label: "query_positions",
                value: typed("g:List", [
                  typed("g:Int32", 0),
                  typed("g:Int32", 2),
                ]),
              }),
            ],
          },
        }),
      ]),
      edges: typed("g:List", [
        typed("g:Edge", {
          id: "same",
          label: "endpoint",
          outV: "same",
          inV: "other",
          properties: { x: typed("g:Property", { key: "x", value: false }) },
        }),
      ]),
    });
    const result = {
      graphson_version: "3.0",
      graph,
      search: {
        complete: false,
        unresolved_folds: [{ claim_id: "fold", reason: "ambiguous" }],
        stream_head: { commitNum: "9007199254740993", opNum: "1" },
      },
      extra_metadata: { future: true },
    };
    const compact = compactSearchResult(result);
    expect(decodeCompactGraphson(JSON.parse(JSON.stringify(compact)))).toEqual(
      graph,
    );
    expect(compact.search).toEqual(result.search);
    expect(compact.extra_metadata).toEqual(result.extra_metadata);
  });
  it("shares literal definitions across independent key and value references and pays for the dictionary", () => {
    const name = "a_repeated_property_name_with_a_long_qualifier";
    const value =
      "A long repeated literal that is worthwhile to intern as a value independently.";
    const source = Array.from({ length: 20 }, (_, i) => ({
      [name]: `unique ${String(i)}`,
      [`unique_key_${String(i)}`]: name,
      other: value,
      short: false,
    }));
    const compact = encodeCompactGraphson(source);
    expect(compact.dictionary).toContain(name);
    expect(compact.dictionary).toContain(value);
    expect(compact.dictionary.every((entry) => typeof entry === "string")).toBe(
      true,
    );
    expect(roundTrip(source)).toEqual(source);
    expect(encodeCompactGraphson(source)).toEqual(compact);
    expect(compactTokenCount(JSON.stringify(compact))).toBeLessThan(
      compactTokenCount(JSON.stringify(source)),
    );
    expect(
      encodeCompactGraphson(["x", "x", false, false, null, null]).dictionary,
    ).toEqual([]);
    expect(roundTrip(["r", 0])).toEqual(["r", 0]);
  });
  it.each([
    ["r", -1],
    ["r", 0.5],
    ["r", 100],
    ["r", 0, "extra"],
    ["t", 1, 2],
    ["o", "odd"],
    ["o", "duplicate", 1, "duplicate", 2],
    ["o", 0, true],
    ["n", "NaN"],
    {},
  ])("rejects malformed compact data %j", (...items) => {
    const graph =
      items.length === 1 &&
      !Array.isArray(items[0]) &&
      typeof items[0] === "object"
        ? items[0]
        : items;
    expect(() =>
      decodeCompactGraphson({
        format: "compact",
        compact_version: 1,
        encoding: COMPACT_GRAMMAR,
        dictionary: [],
        graph,
      }),
    ).toThrow();
  });
  it("rejects unsupported encoder input and dictionary chains", () => {
    for (const source of [undefined, NaN, Infinity, new Date(), [undefined]])
      expect(() => encodeCompactGraphson(source)).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeCompactGraphson(cyclic)).toThrow();
    expect(() =>
      decodeCompactGraphson({
        format: "compact",
        compact_version: 1,
        encoding: COMPACT_GRAMMAR,
        dictionary: [["r", 0]],
        graph: ["r", 0],
      }),
    ).toThrow();
    expect(() =>
      decodeCompactGraphson({
        ...encodeCompactGraphson(null),
        compact_version: 2,
      }),
    ).toThrow();
  });
});
