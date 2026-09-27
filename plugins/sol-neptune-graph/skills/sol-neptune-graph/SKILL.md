---
name: sol-neptune-graph
description: Query or explicitly update Sol's private Amazon Neptune graph through the OAuth-protected read_gremlin, write_gremlin, and delete_gremlin MCP tools. Use for bounded Gremlin reads, graph inspection, or user-requested mutations against Sol's Neptune graph. Never route these operations to Neon.
---

# Sol Neptune Graph

Use the `sol-neptune` MCP server's separately constrained Gremlin tools for work on Sol's private Amazon Neptune graph.

## Operating rules

- Treat Neptune as the only graph in scope for this plugin. Never send these queries or mutations to Neon.
- Use `read_gremlin` for reads. It is server-enforced read-only and rejects syntax or steps the classifier cannot verify.
- Use `write_gremlin` only when the user explicitly requests additions or updates. It rejects pure reads and removals.
- Use `delete_gremlin` only when the user explicitly requests removal of vertices, edges, or properties.
- Bound every potentially large traversal with `limit()`, `range()`, `count()`, or another explicit result bound.
- Keep queries within the server's 65,536-byte input limit and results within its 1 MiB structured-result limit.
- Before a mutation, identify the intended vertices, edges, labels, and stable identifiers precisely enough to avoid broad changes.
- Use stable identifiers or idempotent upserts when practical.
- Do not move a rejected traversal to a less restrictive tool merely to bypass classification. Reformulate it within the documented conservative traversal subset or explain that the server rejected it.

## Unknown outcomes

Every execution is non-retry-safe. If the server returns `UNKNOWN_MUTATION_OUTCOME`, do not repeat the mutation blindly. Use a bounded read keyed by a stable identifier to determine whether it completed, then decide whether any narrowly scoped cleanup or follow-up is necessary.

## Sensitive data

- Never print, save, or request OAuth access tokens, AWS credentials, or provider secrets.
- Do not copy graph data into logs or unrelated external systems.
- Return only the graph result needed to answer the user's request.

## Useful bounded reads

- Vertex count: `g.V().count()`
- Sample one vertex: `g.V().limit(1).elementMap()`
- Sample one edge: `g.E().limit(1).elementMap()`

The MCP server enforces the tool boundary independently of these instructions. ChatGPT's permission layer and each tool's annotations provide the corresponding client-side signal.
