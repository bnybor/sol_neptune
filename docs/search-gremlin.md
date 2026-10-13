# g0 MCP search contract — 2.2.0

This implements the October 13, 2026 discussion (Neptune S1003101–S1003125), amended in Codex to cap depth at 7. The endpoint remains the existing g0 MCP endpoint. The change includes automatic neighborhood search, a 256 KiB query limit across functions, and an independent server-clock tool. Implementation in this checkout does not imply production deployment.

## Input

```json
{
  "query": "g.V('S1003101')",
  "blacklist_query": "g.V('N1001','N1002')",
  "depth": 3
}
```

`query` is required. `blacklist_query` is optional; omission means no blacklist. Both must pass the same conservative read-only classifier as the original read tool. `depth` is an integer from **0 through 7**, default **3**. Unknown parameters, mutation steps in either query, and unsupported syntax are rejected before execution. The private executor repeats validation independently.

Every caller-supplied query is limited separately to **262,144 UTF-8 bytes**, including both search queries and raw read/write/delete. Generated semantic-commit and internal search queries use the same limit. JSON Schema advertises a character upper bound; runtime UTF-8 byte validation is authoritative. Per-property and item-count limits in semantic inputs retain their separate meanings.

## Result and typed identity

The usual successful execution envelope contains `result.graphson_version="3.0"`, `result.graph`, and `result.search`. `graph` is a GraphSON `g:Map` containing `vertices` and `edges` as typed lists of `g:Vertex` meta-nodes and `g:Edge` hops. It is **one graph**, with no separate raw-results field. The outer execution envelope retains request ID, elapsed time, byte count and existing retry metadata.

Meta-vertex properties:

| Property          | Meaning                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `kind`            | `vertex`, `edge`, `reference`, `fold` or `value`                             |
| `value`           | Original typed query value, hydrated typed g0 element, or typed descriptor   |
| `min_depth`       | Smallest distance from any initial query result                              |
| `query_positions` | All zero-based positions for initial results; absent on expansion-only nodes |
| `blacklisted`     | This node is an expansion terminal                                           |
| `expanded`        | Its permitted outgoing connections were inspected                            |
| `stop_reason`     | `blacklist`, `depth_limit`, `terminal_value` or `expanded`                   |

Vertex and edge identity includes **element kind and ID**. The same ID can belong to a vertex and an edge. Other values use a hash of their canonical typed representation. Different numeric types stay distinct; map key order and set order do not create false identities. Lists and paths retain order. Query order and repetition are reconstructed by sorting all initial nodes' `query_positions`; `[A,B,A]` yields A positions `[0,2]` and B position `[1]`. BulkSet result multiplicities are expanded into positions, within the result-count budget.

Depth zero returns the original query values without hydration or expansion. At positive depths, vertices/edges are hydrated with their typed properties and vertex-property IDs. Scalars, maps, lists, sets, paths and other compound query results are terminals; a projected map with `id` and `label` is never mistaken for a vertex. Elements embedded inside compound results are not implicitly promoted to seeds.

The AWS JavaScript SDK parses JSON numbers before the search layer sees them. If an integer is already outside JavaScript's exact integer range, the search returns `RESULT_UNSUPPORTED` rather than pretending its rounded value is exact. Typed floating values and string-encoded extended GraphSON numbers are retained. This contract does not change the original raw read serializer.

## Hops

| Connection | First hop                             | Second hop                          |
| ---------- | ------------------------------------- | ----------------------------------- |
| Physical   | Vertex → incident g0 edge             | Edge → endpoint vertex              |
| Reference  | Vertex or edge → reference descriptor | Descriptor → referenced element     |
| Fold       | Endpoint → particular fold descriptor | Descriptor → corresponding endpoint |

Each directed meta-edge represents one **search** hop; its direction is independent of the underlying g0 edge direction, which remains in the typed edge payload. Nodes are deduplicated, while distinct incident edges, reference occurrences, fold correspondences and incoming explored routes survive. Cycles do not repeatedly expand a node.

Body references are literal candidate IDs in stored property values, including legacy serialized text. Candidates follow g0's ID grammar (letters/digits plus `.`, `_`, `:`, `/` and `-`, up to 256 characters). Sentence-ending punctuation is also considered without its trailing `.`, `:` or `/`. Each candidate is resolved in **both** actual Neptune element namespaces; missing IDs produce no hop. Descriptors retain owner identity, property path, UTF-16 start/end offsets, literal spelling, target kind and target ID. Matching text does not adjudicate a semantic claim or grant disclosure permission.

The live g0 fold representation is a claim with **semantic property** `label=shaped_like`, plus `subject` and `target` ports. Physical vertex labels are not used to classify folds. A unique subject and target supply one explicit endpoint correspondence. The intermediate descriptor contains the full typed claim and both port edges, preserving evidence, qualifiers, status, direction and mismatch text. Each direction gets its own continuation. This does not extract constituent mappings from prose or return the entire opposite subgraph. Zero/multiple subject/target ports are reported in `search.unresolved_folds`, with `search.complete=false`; no Cartesian mapping is invented. Ordinary physical traversal of those claim ports remains available at its actual hop depth.

## Blacklist

The blacklist query selects typed values/elements. Only blacklist matches encountered during search enter the graph. A blacklisted seed is retained. Blacklisting a physical edge retains the node-to-edge hop but prevents expansion through that edge; another permitted route can still reach the opposite vertex.

A derived reference/fold descriptor can be selected by its deterministic returned ID using `g.inject('search:reference:...')` or `g.inject('search:fold:...')`. Blacklisting a fold claim or one of its two mapping ports also stops its derived fold descriptor. Blacklisting an owner prevents its ordinary, reference and fold expansion alike. Blacklisting the destination retains it once reached and stops its subsequent expansion.

Blacklist entries are expansion controls, not graph deletions or row-level access rules. The same authenticated OAuth scope/immutable subject boundary governs access; caller disclosure duties remain applicable.

## Consistency and limits

Every search with positive depth or a supplied blacklist pins the writer's **Neptune Streams head** before the first query and compares it after the last read. If either event coordinate changes, it returns `GRAPH_CHANGED` without a graph. This covers raw graph mutations that do not advance semantic revision counters. A depth-zero search without a blacklist is one ordinary read transaction and needs no stream read. Streams must already be enabled; the executor role needs cluster-scoped `neptune-db:GetStreamRecords`. No weaker fallback is used when that boundary is unavailable.

Resource bounds are explicit:

- 2,048 meta-nodes and 8,192 hops.
- 10,000 query-result positions, including repeats.
- 64 Gremlin queries and 8,192 distinct reference candidates.
- 32-element hydration/neighborhood batches; reference lookup batches up to 256 IDs.
- An 11-second search budget inside the existing 15-second executor timeout.
- The existing 1 MiB structured-response limit, including the execution envelope.

Node/hop/query/reference limits return `SEARCH_LIMIT_EXCEEDED`. Timeout returns `QUERY_TIMEOUT`. Oversized results return `RESULT_TOO_LARGE`. Those errors contain **no partial graph**. Narrow the seed query, blacklist hubs, or reduce depth. There is no paging token or implicit truncation in this release. Successful results report requested depth, query-result/node/hop/query counts, consistency mode and boundary. `complete=true` means all permitted connections under this explicit correspondence contract were examined to the requested depth; ambiguity is reported separately as described above.

The private executor uses typed GraphSON 3 for search subqueries; existing raw and semantic operations retain their original serializer. SDK retry counts remain one, and no automatic retry or mutation is introduced by search.

## Clock

`get_current_time()` requires the same OAuth connection and accepts an empty object or omitted arguments. Each invocation samples the MCP server wall clock **once** and returns:

```json
{
  "server_time_utc": "2026-10-13T19:00:00.123Z",
  "unix_time_ms": 1791918000123
}
```

Both fields derive from that same sample. Calls are uncached and perform no graph read/write or executor invocation. This does not silently adopt the older proposals to stamp every response or semantic commit.

## Compatibility and deployment

`read_gremlin` remains callable and advertised as deprecated compatibility functionality. New callers should use `search_gremlin`, selecting depth zero when no expansion is wanted. Seven original tools plus search and clock make nine tools. The URL, authentication, graph authority, mutation classification, idempotency, allocator and receipt semantics are preserved.

Deploy both Lambda bundles and the executor's added stream-read permission through a reviewed CloudFormation/SAM change set. Refresh connected tool metadata afterwards. Code implementation and tests alone do not verify the deployed typed serializer or protected search call.

Primary format/API references: [Apache TinkerPop GraphSON 3](https://tinkerpop.apache.org/docs/current/dev/io/#graphson-3d0), [AWS ExecuteGremlinQuery](https://docs.aws.amazon.com/neptune/latest/data-api/API_ExecuteGremlinQuery.html), and [AWS GetPropertygraphStream](https://docs.aws.amazon.com/neptune/latest/data-api/API_GetPropertygraphStream.html).
