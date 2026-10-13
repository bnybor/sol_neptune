import {
  MAX_QUERY_BYTES,
  MAX_STRUCTURED_RESULT_BYTES,
  type ErrorCode,
  type SearchInput,
} from "../shared/contracts.js";
import {
  assertLosslessNumbers,
  element,
  elementId,
  elementKind,
  fields,
  fingerprint,
  graphsonMap,
  isTyped,
  list,
  queryResults,
  required,
  record,
  typed,
  valueIdentity,
  type ElementValue,
} from "../shared/graphson.js";
export type SearchBackend = {
  query(query: string): Promise<unknown>;
  streamHead(): Promise<Record<string, string>>;
};
export const SEARCH_LIMITS = {
  nodes: 2048,
  hops: 8192,
  results: 10000,
  queries: 64,
  referenceCandidates: 8192,
  batch: 32,
} as const;
type SearchLimits = {
  [K in keyof typeof SEARCH_LIMITS]: number;
};
type Kind = "vertex" | "edge" | "reference" | "fold" | "value";
type MetaNode = {
  key: string;
  id: string;
  kind: Kind;
  value: unknown;
  depth: number;
  queryPositions: number[];
  blacklisted: boolean;
  expanded: boolean;
  target?: unknown;
};
type Hop = {
  id: string;
  out: string;
  in: string;
  cause: string;
};
type Reference = {
  owner: MetaNode;
  literal: string;
  path: string;
  start: number;
  end: number;
};
export class SearchFailure extends Error {
  public constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SearchFailure";
  }
}
// Never insert an ID into Groovy as a double-quoted/interpolated expression.
export function gremlinString(value: string): string {
  return `'${Array.from(value)
    .map((character) => {
      if (character === "\\") return "\\\\";
      if (character === "'") return "\\'";
      if (character === "\n") return "\\n";
      if (character === "\r") return "\\r";
      if (character === "\t") return "\\t";
      return character.charCodeAt(0) < 32
        ? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
        : character;
    })
    .join("")}'`;
}
export function hydrationQuery(kind: "vertex" | "edge", ids: string[]): string {
  return `g.${kind === "vertex" ? "V" : "E"}(${ids.map(gremlinString).join(",")}).project('value','properties').by(identity()).by(properties().fold())`;
}
export function neighborhoodQuery(
  kind: "vertex" | "edge",
  ids: string[],
  maximum: number,
): string {
  const start = `g.${kind === "vertex" ? "V" : "E"}(${ids.map(gremlinString).join(",")})`;
  if (kind === "edge") {
    return `${start}.project('owner','neighbors').by(identity()).by(bothV().fold())`;
  }
  // Only an explicit one-subject/one-target g0 correspondence is crossed.
  // Two ports are enough to detect ambiguity, without a Cartesian product.
  return `${start}.project('owner','neighbors','folds').by(identity()).by(bothE().limit(${String(maximum + 1)}).fold()).by(inE('subject','target').outV().has('label','shaped_like').dedup().limit(${String(maximum + 1)}).project('claim','properties','subjects','targets').by(identity()).by(properties().fold()).by(outE('subject').limit(2).project('port','element').by(identity()).by(inV()).fold()).by(outE('target').limit(2).project('port','element').by(identity()).by(inV()).fold()).fold())`;
}
function hydrated(value: unknown, properties: unknown): ElementValue {
  const item = element(value);
  if (!item) throw new Error("Expected a typed Neptune element.");
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const property of list(properties)) {
    if (
      elementKind(item) === "vertex" &&
      isTyped(property, "g:VertexProperty")
    ) {
      const body = record(property["@value"]);
      if (!body || typeof body.label !== "string")
        throw new Error("Malformed vertex property.");
      const current = result[body.label];
      const previous = Array.isArray(current) ? (current as unknown[]) : [];
      result[body.label] = [...previous, property];
    } else if (
      elementKind(item) === "edge" &&
      isTyped(property, "g:Property")
    ) {
      const body = record(property["@value"]);
      if (!body || typeof body.key !== "string")
        throw new Error("Malformed edge property.");
      result[body.key] = property;
    } else {
      throw new Error("Expected typed element properties.");
    }
  }
  const body = { ...item["@value"] };
  delete body.properties;
  if (Object.keys(result).length > 0) body.properties = result;
  return { ...item, "@value": body };
}
function propertyBody(value: ElementValue): unknown {
  return value["@value"].properties ?? {};
}
function references(owner: MetaNode): Reference[] {
  const result: Reference[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      // IDs follow g0's ID grammar; candidates are always resolved against the
      // actual vertex AND edge namespaces before a reference hop is emitted.
      for (const match of value.matchAll(/[A-Za-z0-9][A-Za-z0-9._:/-]*/gu)) {
        const literals = new Set([match[0], match[0].replace(/[.:/]+$/u, "")]);
        for (const literal of literals)
          if (literal.length > 0 && literal.length <= 256) {
            result.push({
              owner,
              literal,
              path,
              start: match.index,
              end: match.index + literal.length,
            });
          }
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}/${String(i)}`));
    } else if (
      isTyped(value, "g:VertexProperty") ||
      isTyped(value, "g:Property")
    ) {
      const body = record(value["@value"]);
      if (body) walk(body.value, `${path}/@value/value`);
    } else if (isTyped(value)) {
      walk(value["@value"], `${path}/@value`);
    } else {
      const body = record(value);
      if (body)
        for (const [key, child] of Object.entries(body)) {
          walk(
            child,
            `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          );
        }
    }
  };
  const item = element(owner.value);
  if (item) walk(propertyBody(item), "/properties");
  return result;
}
function metaVertex(node: MetaNode, requestedDepth: number): unknown {
  const values: Record<string, unknown> = {
    kind: node.kind,
    value: node.value,
    min_depth: typed("g:Int32", node.depth),
    blacklisted: node.blacklisted,
    expanded: node.expanded,
    stop_reason: node.blacklisted
      ? "blacklist"
      : node.expanded
        ? "expanded"
        : node.depth >= requestedDepth
          ? "depth_limit"
          : "terminal_value",
  };
  if (node.queryPositions.length > 0) {
    values.query_positions = typed(
      "g:List",
      node.queryPositions.map((position) => typed("g:Int32", position)),
    );
  }
  return typed("g:Vertex", {
    id: node.id,
    label: node.kind,
    properties: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        [
          typed("g:VertexProperty", {
            id: `${node.id}:${key}`,
            label: key,
            value,
          }),
        ],
      ]),
    ),
  });
}
export async function searchGremlin(
  input: SearchInput,
  backend: SearchBackend,
  options: {
    limits?: Partial<SearchLimits>;
    now?: () => number;
    deadlineMs?: number;
  } = {},
): Promise<Record<string, unknown>> {
  const limits = { ...SEARCH_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const deadline = now() + (options.deadlineMs ?? 11000);
  const nodes = new Map<string, MetaNode>();
  const hops = new Map<string, Hop>();
  const blacklist = new Set<string>();
  const descriptorBlacklist = new Set<string>();
  const unresolvedFolds = new Map<string, string>();
  const hydratedKeys = new Set<string>();
  const resolvedReferences = new Map<string, unknown[]>();
  let queries = 0;
  const limitFailure = (message: string): never => {
    throw new SearchFailure(
      "SEARCH_LIMIT_EXCEEDED",
      `${message} Narrow the seed query, increase the blacklist, or reduce depth; no partial graph is returned.`,
    );
  };
  const checkTime = (): void => {
    if (now() >= deadline)
      throw new SearchFailure(
        "QUERY_TIMEOUT",
        "The search exceeded its execution budget; no partial graph is returned.",
      );
  };
  const execute = async (query: string): Promise<unknown[]> => {
    checkTime();
    if (++queries > limits.queries)
      limitFailure("The search exceeded its query budget.");
    if (Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES)
      limitFailure("A generated search query exceeds the input limit.");
    const result = await backend.query(query);
    checkTime();
    try {
      assertLosslessNumbers(result);
      return queryResults(result, limits.results);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Too many query results."
      ) {
        return limitFailure("The query produced too many result positions.");
      }
      throw new SearchFailure(
        "RESULT_UNSUPPORTED",
        "The typed Neptune result cannot be represented losslessly.",
      );
    }
  };
  const addNode = (
    value: unknown,
    depth: number,
    kind?: Kind,
    key?: string,
  ): MetaNode => {
    const identity = key ?? valueIdentity(value);
    const prior = nodes.get(identity);
    if (prior) {
      prior.depth = Math.min(prior.depth, depth);
      return prior;
    }
    if (nodes.size >= limits.nodes)
      limitFailure("The search exceeded its meta-node limit.");
    const actualKind =
      kind ??
      (element(value) ? elementKind(required(element(value))) : "value");
    const id = `search:${actualKind}:${fingerprint(identity)}`;
    const node: MetaNode = {
      key: identity,
      id,
      kind: actualKind,
      value,
      depth,
      queryPositions: [],
      blacklisted: blacklist.has(identity) || descriptorBlacklist.has(id),
      expanded: false,
    };
    nodes.set(identity, node);
    return node;
  };
  const addHop = (from: MetaNode, to: MetaNode, cause: string): void => {
    const id = `search:hop:${fingerprint([from.id, to.id, cause])}`;
    if (hops.has(id)) return;
    if (hops.size >= limits.hops)
      limitFailure("The search exceeded its hop limit.");
    hops.set(id, { id, out: from.id, in: to.id, cause });
  };
  const chunks = <T>(items: T[], size = limits.batch): T[][] => {
    const result: T[][] = [];
    for (let i = 0; i < items.length; i += size)
      result.push(items.slice(i, i + size));
    return result;
  };
  const hydrateNodes = async (items: MetaNode[]): Promise<void> => {
    for (const kind of ["vertex", "edge"] as const) {
      for (const batch of chunks(
        items.filter(
          (node) => node.kind === kind && !hydratedKeys.has(node.key),
        ),
      )) {
        const rows = await execute(
          hydrationQuery(
            kind,
            batch.map((node) => elementId(required(element(node.value)))),
          ),
        );
        for (const row of rows) {
          const projection = fields(row);
          const value = hydrated(projection.value, projection.properties);
          const key = valueIdentity(value);
          const node = nodes.get(key);
          if (node) {
            node.value = value;
            hydratedKeys.add(key);
          }
        }
        if (batch.some((node) => !hydratedKeys.has(node.key))) {
          throw new SearchFailure(
            "GRAPH_CHANGED",
            "A discovered element disappeared during the search.",
          );
        }
      }
    }
  };
  // Depth zero is exactly one query transaction when no blacklist is supplied.
  // Positive-depth searches fence every read, including raw writes, with the
  // writer's complete stream head rather than only semantic revision counters.
  const initialHead =
    input.depth > 0 || input.blacklist_query !== undefined
      ? await backend.streamHead()
      : undefined;
  if (input.blacklist_query !== undefined) {
    for (const value of await execute(input.blacklist_query)) {
      blacklist.add(valueIdentity(value));
      if (typeof value === "string" && value.startsWith("search:"))
        descriptorBlacklist.add(value);
    }
  }
  const seeds = await execute(input.query);
  seeds.forEach((value, i) => addNode(value, 0).queryPositions.push(i));
  for (let depth = 0; depth < input.depth; depth += 1) {
    const frontier = [...nodes.values()].filter(
      (node) => node.depth === depth && !node.blacklisted && !node.expanded,
    );
    if (frontier.length === 0) break;
    await hydrateNodes(frontier);
    const realElements = frontier.filter(
      (node) => node.kind === "vertex" || node.kind === "edge",
    );
    for (const kind of ["vertex", "edge"] as const) {
      for (const batch of chunks(
        realElements.filter((node) => node.kind === kind),
      )) {
        const rows = await execute(
          neighborhoodQuery(
            kind,
            batch.map((node) => elementId(required(element(node.value)))),
            limits.nodes,
          ),
        );
        for (const row of rows) {
          const projection = fields(row);
          const owner = nodes.get(valueIdentity(projection.owner));
          if (!owner) throw new Error("Unexpected neighborhood owner.");
          const neighbors = list(projection.neighbors);
          if (neighbors.length > limits.nodes)
            limitFailure(
              "An element's physical neighborhood exceeds the search limit.",
            );
          for (const value of neighbors) {
            const neighbor = addNode(value, depth + 1);
            addHop(
              owner,
              neighbor,
              kind === "vertex" ? "incident_edge" : "endpoint",
            );
          }
          if (projection.folds !== undefined) {
            const folds = list(projection.folds);
            if (folds.length > limits.nodes)
              limitFailure("An element has too many fold correspondences.");
            for (const fold of folds) {
              const mapping = fields(fold);
              const claim = hydrated(mapping.claim, mapping.properties);
              const subjects = list(mapping.subjects).map(fields);
              const targets = list(mapping.targets).map(fields);
              if (subjects.length !== 1 || targets.length !== 1) {
                unresolvedFolds.set(
                  elementId(claim),
                  "The fold has no unique subject/target mapping; prose and Cartesian products are not inferred.",
                );
                continue;
              }
              const left = required(subjects[0]);
              const right = required(targets[0]);
              const ownerKey = owner.key;
              const leftKey = valueIdentity(left.element);
              const rightKey = valueIdentity(right.element);
              if (ownerKey !== leftKey && ownerKey !== rightKey)
                throw new Error("Unexpected fold correspondence.");
              const target =
                ownerKey === leftKey ? right.element : left.element;
              const descriptorValue = graphsonMap({
                kind: "fold_correspondence",
                claim,
                subject: left.element,
                target: right.element,
                subject_port: left.port,
                target_port: right.port,
              });
              const descriptorKey = `fold:${fingerprint([elementId(claim), leftKey, rightKey])}`;
              // A fold is a particular correspondence, not all mappings in a
              // claim. Each direction has its own descriptor/continuation.
              const directional = addNode(
                descriptorValue,
                depth + 1,
                "fold",
                `${descriptorKey}:${ownerKey}`,
              );
              directional.target = target;
              directional.blacklisted ||= [claim, left.port, right.port].some(
                (value) => blacklist.has(valueIdentity(value)),
              );
              addHop(owner, directional, "fold_correspondence");
            }
          }
        }
      }
    }
    const mentions = realElements.flatMap(references);
    const candidates = [
      ...new Set(mentions.map((mention) => mention.literal)),
    ].filter((id) => !resolvedReferences.has(id));
    if (
      resolvedReferences.size + candidates.length >
      limits.referenceCandidates
    )
      limitFailure("The search exceeded its body-reference candidate limit.");
    for (const candidate of candidates) resolvedReferences.set(candidate, []);
    for (const batch of chunks(candidates, 256)) {
      const args = batch.map(gremlinString).join(",");
      const values = await execute(
        `g.inject(0).union(__.V(${args}),__.E(${args})).limit(${String(limits.nodes + 1)})`,
      );
      if (values.length > limits.nodes)
        limitFailure("Too many body references resolve to graph elements.");
      for (const value of values) {
        const item = element(value);
        if (!item) throw new Error("Expected a resolved reference element.");
        resolvedReferences.get(elementId(item))?.push(value);
      }
    }
    for (const mention of mentions) {
      for (const target of resolvedReferences.get(mention.literal) ?? []) {
        const descriptorValue = graphsonMap({
          kind: "body_reference",
          owner: mention.owner.key,
          property_path: mention.path,
          start_utf16: typed("g:Int32", mention.start),
          end_utf16: typed("g:Int32", mention.end),
          literal: mention.literal,
          target_kind: elementKind(required(element(target))),
          target_id: elementId(required(element(target))),
        });
        const descriptor = addNode(
          descriptorValue,
          depth + 1,
          "reference",
          `reference:${fingerprint([mention.owner.key, mention.path, mention.start, valueIdentity(target)])}`,
        );
        descriptor.target = target;
        addHop(mention.owner, descriptor, "body_reference");
      }
    }
    for (const node of frontier) {
      if (node.kind === "reference" || node.kind === "fold") {
        if (node.target === undefined)
          throw new Error("Missing descriptor target.");
        addHop(
          node,
          addNode(node.target, depth + 1),
          node.kind === "reference"
            ? "referenced_element"
            : "corresponding_element",
        );
        node.expanded = true;
      } else if (node.kind === "vertex" || node.kind === "edge") {
        node.expanded = true;
      }
    }
  }
  if (input.depth > 0) await hydrateNodes([...nodes.values()]);
  if (initialHead !== undefined) {
    checkTime();
    const finalHead = await backend.streamHead();
    checkTime();
    if (fingerprint(initialHead) !== fingerprint(finalHead)) {
      throw new SearchFailure(
        "GRAPH_CHANGED",
        "The Neptune stream head changed during search; no mixed-boundary graph is returned. Repeat this read if needed.",
      );
    }
  }
  const vertices = [...nodes.values()].map((node) =>
    metaVertex(node, input.depth),
  );
  const edges = [...hops.values()].map((hop) =>
    typed("g:Edge", {
      id: hop.id,
      label: hop.cause,
      outV: hop.out,
      inV: hop.in,
      outVLabel: nodesByIdLabel(nodes, hop.out),
      inVLabel: nodesByIdLabel(nodes, hop.in),
    }),
  );
  const result = {
    graphson_version: "3.0",
    graph: graphsonMap({
      vertices: typed("g:List", vertices),
      edges: typed("g:List", edges),
    }),
    search: {
      requested_depth: input.depth,
      complete: unresolvedFolds.size === 0,
      query_result_count: seeds.length,
      node_count: nodes.size,
      hop_count: hops.size,
      query_count: queries,
      consistency:
        initialHead === undefined
          ? "single_query"
          : "unchanged_neptune_stream_head",
      ...(initialHead === undefined ? {} : { stream_head: initialHead }),
      unresolved_folds: [...unresolvedFolds].map(([claim_id, reason]) => ({
        claim_id,
        reason,
      })),
    },
  };
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") >
    MAX_STRUCTURED_RESULT_BYTES - 512
  ) {
    throw new SearchFailure(
      "RESULT_TOO_LARGE",
      "The complete search graph exceeds the response limit. Narrow the query, blacklist hubs, or reduce depth; no partial graph is returned.",
    );
  }
  checkTime();
  return result;
}
function nodesByIdLabel(nodes: Map<string, MetaNode>, id: string): string {
  for (const node of nodes.values()) if (node.id === id) return node.kind;
  throw new Error("A hop endpoint is missing.");
}
