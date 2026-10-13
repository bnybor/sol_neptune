import {
  required,
  fields,
  list,
  typed,
  graphsonMap,
  element,
  elementId,
  elementKind,
  record,
  valueIdentity,
  fingerprint,
  assertLosslessNumbers,
} from "../src/shared/graphson.js";
import { searchInputSchema } from "../src/shared/contracts.js";
import {
  searchGremlin,
  hydrationQuery,
  neighborhoodQuery,
  gremlinString,
  type SearchBackend,
} from "../src/executor/search.js";
import { validateGremlinForTool } from "../src/mcp/gremlin-safety.js";
type Properties = Record<string, unknown[]>;
type Vertex = {
  id: string;
  properties: Properties;
};
type Edge = {
  id: string;
  out: string;
  in: string;
  label: string;
  properties: Record<string, unknown>;
};
function vertex(id: string): unknown {
  return typed("g:Vertex", { id, label: "Object" });
}
function edge(value: Edge): unknown {
  return typed("g:Edge", {
    id: value.id,
    label: value.label,
    outV: value.out,
    inV: value.in,
    outVLabel: "Object",
    inVLabel: "Object",
  });
}
// This fixture owns a small physical graph and returns typed provider values.
// Expected paths below are stated independently of the search algorithm.
class Fixture implements SearchBackend {
  vertices = new Map<string, Vertex>();
  edges = new Map<string, Edge>();
  seeds = new Map<string, unknown[]>();
  queries: string[] = [];
  heads = [
    { commitNum: "10", opNum: "5" },
    { commitNum: "10", opNum: "5" },
  ];
  streamHead = vi.fn(() =>
    Promise.resolve(this.heads.shift() ?? { commitNum: "10", opNum: "5" }),
  );
  addVertex(id: string, properties: Properties = {}): this {
    this.vertices.set(id, { id, properties });
    return this;
  }
  addEdge(
    id: string,
    out: string,
    incoming: string,
    label = "related",
    properties: Record<string, unknown> = {},
  ): this {
    this.edges.set(id, { id, out, in: incoming, label, properties });
    return this;
  }
  props(value: unknown): unknown[] {
    const item = required(element(value));
    if (elementKind(item) === "vertex") {
      return Object.entries(
        required(this.vertices.get(elementId(item))).properties,
      ).flatMap(([key, values]) =>
        values.map((value, i) =>
          typed("g:VertexProperty", {
            id: `${elementId(item)}:${key}:${String(i)}`,
            label: key,
            value,
          }),
        ),
      );
    }
    return Object.entries(
      required(this.edges.get(elementId(item))).properties,
    ).map(([key, value]) => typed("g:Property", { key, value }));
  }
  query(query: string): Promise<unknown> {
    this.queries.push(query);
    let result: unknown[];
    if (this.seeds.has(query)) result = required(this.seeds.get(query));
    else {
      const start = /^g\.([VE])\((.*?)\)/u.exec(query);
      const ids = start
        ? [...required(start[2]).matchAll(/'([^']*)'/gu)].map((match) =>
            required(match[1]),
          )
        : [];
      const values =
        start?.[1] === "V"
          ? ids.filter((id) => this.vertices.has(id)).map(vertex)
          : ids
              .filter((id) => this.edges.has(id))
              .map((id) => edge(required(this.edges.get(id))));
      if (query.includes(".project('value','properties')")) {
        result = values.map((value) =>
          graphsonMap({
            value,
            properties: typed("g:List", this.props(value)),
          }),
        );
      } else if (query.includes(".project('owner','neighbors'")) {
        result = values.map((owner) => {
          const item = required(element(owner));
          const id = elementId(item);
          const output: Record<string, unknown> = { owner };
          if (elementKind(item) === "edge") {
            const link = required(this.edges.get(id));
            output.neighbors = typed("g:List", [
              vertex(link.out),
              vertex(link.in),
            ]);
          } else {
            output.neighbors = typed(
              "g:List",
              [...this.edges.values()]
                .filter((link) => link.out === id || link.in === id)
                .map(edge),
            );
            const claims = [...this.vertices.values()].filter(
              (v) =>
                v.properties.label?.includes("shaped_like") &&
                [...this.edges.values()].some(
                  (link) =>
                    link.out === v.id &&
                    link.in === id &&
                    ["subject", "target"].includes(link.label),
                ),
            );
            output.folds = typed(
              "g:List",
              claims.map((claim) =>
                graphsonMap({
                  claim: vertex(claim.id),
                  properties: typed("g:List", this.props(vertex(claim.id))),
                  subjects: typed(
                    "g:List",
                    [...this.edges.values()]
                      .filter(
                        (link) =>
                          link.out === claim.id && link.label === "subject",
                      )
                      .slice(0, 2)
                      .map((link) =>
                        graphsonMap({
                          port: edge(link),
                          element: vertex(link.in),
                        }),
                      ),
                  ),
                  targets: typed(
                    "g:List",
                    [...this.edges.values()]
                      .filter(
                        (link) =>
                          link.out === claim.id && link.label === "target",
                      )
                      .slice(0, 2)
                      .map((link) =>
                        graphsonMap({
                          port: edge(link),
                          element: vertex(link.in),
                        }),
                      ),
                  ),
                }),
              ),
            );
          }
          return graphsonMap(output);
        });
      } else if (query.startsWith("g.inject(0).union(")) {
        const names = [
          ...new Set(
            [...query.matchAll(/'([^']*)'/gu)].map((match) =>
              required(match[1]),
            ),
          ),
        ];
        result = [
          ...names.filter((id) => this.vertices.has(id)).map(vertex),
          ...names
            .filter((id) => this.edges.has(id))
            .map((id) => edge(required(this.edges.get(id)))),
        ];
      } else if (start) result = values;
      else throw new Error(`Unrecognized fixture query: ${query}`);
    }
    return Promise.resolve({ data: typed("g:List", result) });
  }
}
function graph(result: Record<string, unknown>): {
  nodes: Record<string, unknown>[];
  hops: Record<string, unknown>[];
} {
  const body = fields(result.graph);
  return {
    nodes: list(body.vertices).map((v) =>
      required(record(required(record(v))["@value"])),
    ),
    hops: list(body.edges).map((v) =>
      required(record(required(record(v))["@value"])),
    ),
  };
}
function property(node: Record<string, unknown>, key: string): unknown {
  const props = required(record(node.properties));
  const entry = (props[key] as unknown[] | undefined)?.[0];
  return entry === undefined
    ? undefined
    : required(record(required(record(entry))["@value"])).value;
}
function elementNodes(
  result: Record<string, unknown>,
): Record<string, unknown>[] {
  return graph(result).nodes.filter(
    (n) => element(property(n, "value")) !== undefined,
  );
}
function ids(result: Record<string, unknown>): string[] {
  return elementNodes(result)
    .map(
      (n) =>
        `${elementKind(required(element(property(n, "value"))))}:${elementId(required(element(property(n, "value"))))}`,
    )
    .sort();
}
const run = (
  fixture: Fixture,
  query = "g.V('A')",
  depth = 3,
  blacklist_query?: string,
) =>
  searchGremlin(
    {
      query,
      depth,
      ...(blacklist_query === undefined ? {} : { blacklist_query }),
    },
    fixture,
  );
describe("GraphSON neighborhood search", () => {
  it("preserves typed scalars, maps, paths, null, order and repeats at depth zero", async () => {
    const fixture = new Fixture().addVertex("A");
    const int = typed("g:Int32", 1);
    const long = typed("g:Int64", 1);
    const map = graphsonMap({ id: "A", value: typed("g:List", [long, false]) });
    const path = typed("g:Path", {
      labels: typed("g:List", []),
      objects: typed("g:List", [vertex("A")]),
    });
    const results = [
      vertex("A"),
      int,
      vertex("A"),
      long,
      map,
      path,
      null,
      null,
    ];
    fixture.seeds.set("g.inject('ordered')", results);
    const result = await run(fixture, "g.inject('ordered')", 0);
    const nodes = graph(result).nodes;
    const reconstructed: unknown[] = [];
    for (const node of nodes)
      for (const pos of list(property(node, "query_positions"))) {
        reconstructed[required(record(pos))["@value"] as number] = property(
          node,
          "value",
        );
      }
    expect(reconstructed).toEqual(results);
    expect(nodes).toHaveLength(6);
    expect(graph(result).hops).toEqual([]);
    expect(fixture.queries).toEqual(["g.inject('ordered')"]);
    expect(fixture.streamHead).not.toHaveBeenCalled();
  });
  it("preserves alternate routes and uses two physical hops", async () => {
    const fixture = new Fixture()
      .addVertex("A")
      .addVertex("B")
      .addVertex("C")
      .addEdge("ab1", "A", "B")
      .addEdge("ab2", "A", "B")
      .addEdge("bc", "B", "C");
    const one = await run(fixture, "g.V('A')", 1);
    expect(ids(one)).toEqual(["edge:ab1", "edge:ab2", "vertex:A"]);
    const two = await run(fixture, "g.V('A')", 2);
    expect(ids(two)).toEqual(["edge:ab1", "edge:ab2", "vertex:A", "vertex:B"]);
    const b = required(
      elementNodes(two).find(
        (node) => elementId(required(element(property(node, "value")))) === "B",
      ),
    );
    expect(graph(two).hops.filter((hop) => hop.inV === b.id)).toHaveLength(2);
    expect(property(b, "query_positions")).toBeUndefined();
    const three = await run(fixture);
    expect(ids(three)).toContain("edge:bc");
    expect(ids(three)).not.toContain("vertex:C");
  });
  it("keeps a blacklisted edge but never follows it", async () => {
    const fixture = new Fixture()
      .addVertex("A")
      .addVertex("B")
      .addEdge("ab", "A", "B");
    const result = await run(fixture, "g.V('A')", 7, "g.E('ab')");
    expect(ids(result)).toEqual(["edge:ab", "vertex:A"]);
    const blocked = required(
      elementNodes(result).find(
        (node) =>
          elementKind(required(element(property(node, "value")))) === "edge",
      ),
    );
    expect(property(blocked, "stop_reason")).toBe("blacklist");
    expect(graph(result).hops.some((hop) => hop.outV === blocked.id)).toBe(
      false,
    );
  });
  it("keeps blacklisted seeds and does not inject unrelated blacklist matches", async () => {
    const fixture = new Fixture()
      .addVertex("A")
      .addVertex("B")
      .addVertex("unused")
      .addEdge("ab", "A", "B");
    const result = await run(fixture, "g.V('A')", 3, "g.V('A','unused')");
    expect(ids(result)).toEqual(["vertex:A"]);
    expect(graph(result).hops).toEqual([]);
    expect(
      fixture.queries.some((query) => query.includes(".project('owner'")),
    ).toBe(false);
  });
  it("resolves references in vertex and edge bodies through explicit descriptors", async () => {
    const fixture = new Fixture()
      .addVertex("A", { canonical: ["See B. Missing does not exist."] })
      .addVertex("B")
      .addVertex("C")
      .addEdge("ab", "A", "B", "related", { note: "C" });
    const result = await run(fixture, "g.V('A')", 2);
    const nodes = graph(result).nodes;
    const refs = nodes.filter((node) => property(node, "kind") === "reference");
    expect(refs).toHaveLength(2);
    expect(
      refs.some((node) => fields(property(node, "value")).literal === "B"),
    ).toBe(true);
    expect(ids(result)).not.toContain("vertex:C");
    expect(ids(await run(fixture, "g.E('ab')", 2))).toContain("vertex:C");
    for (const reference of refs) {
      const detail = fields(property(reference, "value"));
      expect(detail.property_path).toMatch(/^\/properties\//u);
      expect(required(record(detail.start_utf16))["@value"]).toEqual(
        expect.any(Number),
      );
    }
  });
  it("can stop a derived reference descriptor selected by its returned ID", async () => {
    const fixture = new Fixture()
      .addVertex("A", { canonical: ["B"] })
      .addVertex("B");
    const first = await run(fixture, "g.V('A')", 2);
    const descriptor = required(
      graph(first).nodes.find((node) => property(node, "kind") === "reference"),
    );
    fixture.seeds.set("g.inject('descriptor')", [descriptor.id]);
    const second = await run(fixture, "g.V('A')", 2, "g.inject('descriptor')");
    expect(ids(second)).toEqual(["vertex:A"]);
    const stopped = required(
      graph(second).nodes.find((node) => node.id === descriptor.id),
    );
    expect(property(stopped, "stop_reason")).toBe("blacklist");
  });
  it("distinguishes vertex and edge IDs and does not expand projected maps", async () => {
    const fixture = new Fixture()
      .addVertex("same")
      .addVertex("other")
      .addEdge("same", "same", "other");
    fixture.seeds.set("g.inject('collision')", [
      vertex("same"),
      edge(required(fixture.edges.get("same"))),
      graphsonMap({ id: "same", label: "Object" }),
    ]);
    const result = await run(fixture, "g.inject('collision')", 0);
    expect(graph(result).nodes).toHaveLength(3);
    expect(ids(result)).toEqual(["edge:same", "vertex:same"]);
    expect(new Set(graph(result).nodes.map((node) => node.id)).size).toBe(3);
  });
  it("crosses only the corresponding fold endpoint and preserves the claim and ports", async () => {
    const fixture = new Fixture()
      .addVertex("A")
      .addVertex("B")
      .addVertex("C")
      .addVertex("F", {
        label: ["shaped_like"],
        canonical: ["Matched structure with a decisive mismatch."],
        decision_state: ["tentative"],
      })
      .addEdge("subject", "F", "A", "subject")
      .addEdge("target", "F", "B", "target")
      .addEdge("bc", "B", "C");
    const result = await run(fixture, "g.V('A')", 2);
    expect(ids(result)).toContain("vertex:B");
    expect(ids(result)).not.toContain("vertex:C");
    const folds = graph(result).nodes.filter(
      (node) => property(node, "kind") === "fold",
    );
    expect(folds).toHaveLength(1);
    const mapping = fields(property(required(folds[0]), "value"));
    expect(elementId(required(element(mapping.claim)))).toBe("F");
    expect(
      required(record(required(element(mapping.claim))["@value"].properties))
        .decision_state,
    ).toBeDefined();
    expect(elementId(required(element(mapping.subject_port)))).toBe("subject");
    expect(elementId(required(element(mapping.target_port)))).toBe("target");
    const stopped = await run(fixture, "g.V('A')", 2, "g.V('F')");
    expect(ids(stopped)).not.toContain("vertex:B");
  });
  it("reports ambiguous fold mappings rather than inventing correspondences", async () => {
    const fixture = new Fixture()
      .addVertex("A")
      .addVertex("B")
      .addVertex("C")
      .addVertex("F", { label: ["shaped_like"] })
      .addEdge("s1", "F", "A", "subject")
      .addEdge("s2", "F", "C", "subject")
      .addEdge("t", "F", "B", "target");
    const result = await run(fixture, "g.V('A')", 2);
    expect(ids(result)).not.toContain("vertex:B");
    expect(
      graph(result).nodes.some((node) => property(node, "kind") === "fold"),
    ).toBe(false);
    expect(result.search).toMatchObject({
      complete: false,
      unresolved_folds: [
        { claim_id: "F", reason: expect.any(String) as unknown },
      ],
    });
  });
  it("rejects a changed stream boundary and resource-limited searches without a partial graph", async () => {
    const fixture = new Fixture()
      .addVertex("A")
      .addVertex("B")
      .addEdge("ab", "A", "B");
    fixture.heads = [
      { commitNum: "10", opNum: "5" },
      { commitNum: "11", opNum: "1" },
    ];
    await expect(run(fixture, "g.V('A')", 2)).rejects.toMatchObject({
      code: "GRAPH_CHANGED",
    });
    await expect(
      searchGremlin({ query: "g.V('A')", depth: 3 }, fixture, {
        limits: { nodes: 2 },
      }),
    ).rejects.toMatchObject({ code: "SEARCH_LIMIT_EXCEEDED" });
  });
  it("expands BulkSet query results into exact initial positions", async () => {
    const backend: SearchBackend = {
      query: vi.fn().mockResolvedValue({
        data: typed("g:BulkSet", [
          "repeat",
          typed("g:Int64", 3),
          false,
          typed("g:Int64", 1),
        ]),
      }),
      streamHead: vi.fn(),
    };
    const result = await searchGremlin(
      { query: "g.inject('repeat')", depth: 0 },
      backend,
    );
    expect(graph(result).nodes).toHaveLength(2);
    const repeated = required(
      graph(result).nodes.find((node) => property(node, "value") === "repeat"),
    );
    expect(list(property(repeated, "query_positions"))).toEqual([
      typed("g:Int32", 0),
      typed("g:Int32", 1),
      typed("g:Int32", 2),
    ]);
    expect(result.search).toMatchObject({ query_result_count: 4 });
  });
  it("accepts depth 0 and 7, defaults to 3, and rejects other depths", () => {
    expect(searchInputSchema.parse({ query: "g.V()" }).depth).toBe(3);
    for (const depth of [0, 7])
      expect(
        searchInputSchema.safeParse({ query: "g.V()", depth }).success,
      ).toBe(true);
    for (const depth of [-1, 8, 2.5, "3", null])
      expect(
        searchInputSchema.safeParse({ query: "g.V()", depth }).success,
      ).toBe(false);
  });
  it("retains typed numeric distinctions and refuses an unsafe SDK integer", async () => {
    expect(valueIdentity(typed("g:Int32", 1))).not.toBe(
      valueIdentity(typed("g:Int64", 1)),
    );
    expect(fingerprint(graphsonMap({ a: 1, b: 2 }))).toBe(
      fingerprint(graphsonMap({ b: 2, a: 1 })),
    );
    expect(() => assertLosslessNumbers(typed("g:Double", 1e20))).not.toThrow();
    const backend: SearchBackend = {
      query: vi.fn().mockResolvedValue({
        data: typed("g:List", [typed("g:Int64", 9007199254740992)]),
      }),
      streamHead: vi.fn(),
    };
    await expect(
      searchGremlin({ query: "g.V().count()", depth: 0 }, backend),
    ).rejects.toMatchObject({ code: "RESULT_UNSUPPORTED" });
  });
  it("classifies every generated traversal as read-only and quotes hostile IDs", () => {
    const hostile = "x');g.V().drop();('y${danger}\\z";
    expect(gremlinString(hostile)).toContain("\\'");
    for (const kind of ["vertex", "edge"] as const) {
      for (const query of [
        hydrationQuery(kind, [hostile]),
        neighborhoodQuery(kind, [hostile], 10),
      ]) {
        expect(validateGremlinForTool(query, "read")).toEqual({
          ok: true,
          classification: "read",
        });
      }
    }
  });
});
