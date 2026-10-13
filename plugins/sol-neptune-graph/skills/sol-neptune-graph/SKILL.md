---
name: sol-neptune-graph
description: Read or explicitly update Sol's private Amazon Neptune graph through search_gremlin, guarded typed semantic operations and separately constrained Gremlin tools. Use get_current_time for a fresh server timestamp. Never route these operations to Neon.
---

# Sol Neptune Graph

Use the `sol-neptune` MCP server's typed semantic operations for routine persistence and its separately constrained Gremlin tools for exceptional work on Sol's private Amazon Neptune graph.

## Preferred typed workflow

1. Call `get_graph_state` and retain its exact `authority_epoch` and revision values.
2. Resolve the semantic delta yourself. The server does not decide what a source, claim, concept, relationship, supersession, provenance, or decision state should mean.
3. Choose a unique stable `operation_id` and call `commit_semantic_delta` with the observed authority/revision boundary, explicit origin, and bounded major-version-0 delta.
4. Trust `complete` only because the server performed exact readback. If the result is `RECOVERY_NEEDED` or the acknowledgement was lost, call `reconcile_operation` with the same operation ID rather than constructing a replacement request.

Temporary `$...` references let one request create related records without predicting allocator output. Reusing an operation ID with a different canonical payload is a permanent conflict. Reconciliation reuses the receipt's original allocation map and never selects replacement IDs.

## Operating rules

- Treat Neptune as the only graph in scope for this plugin. Never send these queries or mutations to Neon.
- Prefer `get_graph_state`, `commit_semantic_delta`, and `reconcile_operation` for routine foreground semantic persistence.
- Keep semantic cognition at the caller: supply exact objects, properties, relationships, provenance, revision effects, and any explicit supersession. Do not ask the server to infer them.
- Typed semantic commits are major-version-0-only and non-destructive. They cannot remove properties, edges, or vertices and cannot carry arbitrary Gremlin.
- Prefer `search_gremlin` for reads: minimum depth 0, default 3, maximum 7. It returns one typed GraphSON meta-graph, with query positions on initial nodes and two hops per physical/reference/fold connection. Use a read-only `blacklist_query` to stop expansion at hubs. Check `search.complete` and `search.unresolved_folds`; ambiguous folds are not invented. Depth 0 preserves unexpanded typed query results. `read_gremlin` remains a deprecated compatibility read.
- Use `get_current_time` for a fresh UTC timestamp and epoch milliseconds from the same server-clock sample. It performs no graph I/O.
- Use `write_gremlin` only when the user explicitly requests additions or updates. It rejects pure reads and removals.
- Use `delete_gremlin` only when the user explicitly requests removal of vertices, edges, or properties.
- Bound every potentially large traversal with `limit()`, `range()`, `count()`, or another explicit result bound.
- Keep each query within the server's 262,144-byte UTF-8 input limit and results within its 1 MiB structured-result limit. Search resource limits fail without returning a partial graph; refine depth or blacklist rather than assuming a truncated result is complete. `GRAPH_CHANGED` means a moving stream boundary; the read may be repeated.
- Before a mutation, identify the intended vertices, edges, labels, and stable identifiers precisely enough to avoid broad changes.
- Use stable identifiers or idempotent upserts when practical.
- Do not move a rejected traversal to a less restrictive tool merely to bypass classification. Reformulate it within the documented conservative traversal subset or explain that the server rejected it.

## Unknown outcomes

Raw Gremlin execution is non-retry-safe. If a raw tool returns `UNKNOWN_MUTATION_OUTCOME`, do not repeat the mutation blindly. Use a bounded read keyed by a stable identifier to determine whether it completed, then decide whether any narrowly scoped cleanup or follow-up is necessary.

Typed commits are idempotent by operation ID, but an ambiguous or partial typed outcome should still be handled through `reconcile_operation`. Do not generate a new operation ID for the same logical operation.

## Sensitive data

- Never print, save, or request OAuth access tokens, AWS credentials, or provider secrets.
- Do not copy graph data into logs or unrelated external systems.
- Return only the graph result needed to answer the user's request.

## Useful bounded reads

- Vertex count: `g.V().count()`
- Sample one vertex: `g.V().limit(1).elementMap()`
- Sample one edge: `g.E().limit(1).elementMap()`

The MCP server enforces the tool boundary independently of these instructions. ChatGPT's permission layer and each tool's annotations provide the corresponding client-side signal.
