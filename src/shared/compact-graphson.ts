import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { isTyped, record, required } from "./graphson.js";

export const COMPACT_VERSION = 1;
export const COMPACT_GRAMMAR =
  'graph: scalars and untagged arrays are literal. Tags: ["t",type,value] = GraphSON @type/@value; ["o",key,value,...] = object; ["r",i] = dictionary[i] (an optional third string appends a literal suffix); ["a",...items] = escaped literal array; ["n","-0"] = negative zero. Object keys are strings or dictionary indexes. Decode children, never dictionary definitions (literal strings). search is literal.';

const TAGS = new Set(["t", "o", "r", "a", "n"]);

export type CompactGraphson = {
  format: "compact";
  compact_version: typeof COMPACT_VERSION;
  encoding: string;
  dictionary: string[];
  graph: unknown;
};

// Special-token-looking source text is ordinary data, not tokenizer control.
export function compactTokenCount(text: string): number {
  return countTokens(text, { disallowedSpecial: new Set() });
}

function literal(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object")
    throw new Error("Compact data must be a finite JSON-shaped typed tree.");
  if (ancestors.has(value))
    throw new Error("Cyclic compact data is unsupported.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(value, i))
          throw new Error("Sparse arrays are unsupported.");
        literal(value[i], ancestors);
      }
      return;
    }
    const body = record(value);
    if (
      body &&
      (Object.getPrototypeOf(body) === Object.prototype ||
        Object.getPrototypeOf(body) === null)
    ) {
      for (const child of Object.values(body)) literal(child, ancestors);
      return;
    }
    throw new Error("Compact data must be a finite JSON-shaped typed tree.");
  } finally {
    ancestors.delete(value);
  }
}

// The same dictionary serves keys and values. Type tags are preserved by t,
// including unknown/extended GraphSON types; no plain-JSON type coercion occurs.
export function encodeCompactGraphson(graph: unknown): CompactGraphson {
  literal(graph);
  const counts = new Map<string, { keys: number; values: number }>();
  const prefixes = new Map<string, string[]>();
  const idPrefix = (
    text: string,
    field?: string,
  ): { prefix: string; suffix: string } | undefined => {
    if (!field || !["id", "outV", "inV"].includes(field)) return undefined;
    const match =
      /^(search:(?:vertex|edge|reference|fold|value|hop):[a-f0-9]{64})(:[a-z_]+)?$/u.exec(
        text,
      );
    return match
      ? { prefix: required(match[1]), suffix: match[2] ?? "" }
      : undefined;
  };
  const visit = (text: string, key: boolean): string => {
    const count = counts.get(text) ?? { keys: 0, values: 0 };
    if (key) count.keys++;
    else count.values++;
    counts.set(text, count);
    return text;
  };
  const walk = (value: unknown, field?: string): unknown => {
    if (typeof value === "string") {
      const id = idPrefix(value, field);
      if (id)
        prefixes.set(id.prefix, [
          ...(prefixes.get(id.prefix) ?? []),
          id.suffix,
        ]);
      return visit(value, false);
    }
    if (Object.is(value, -0)) return ["n", "-0"];
    if (Array.isArray(value)) {
      const children = value.map((child) => walk(child));
      return typeof value[0] === "string" && TAGS.has(value[0])
        ? ["a", ...children]
        : children;
    }
    const body = record(value);
    if (!body) return value;
    if (isTyped(value) && Object.keys(body).length === 2) {
      return ["t", visit(value["@type"], false), walk(value["@value"])];
    }
    return [
      "o",
      ...Object.entries(body).flatMap(([key, child]) => [
        visit(key, true),
        walk(child, key),
      ]),
    ];
  };
  const baseline = walk(graph);
  const dictionary: string[] = [];
  const indices = new Map<
    string,
    { index: number; key: boolean; value: boolean; prefix?: boolean }
  >();
  // Only synthetic search identity fields use suffix references. Source prose
  // is never split into fragments. Every reference still performs one lookup
  // of a literal definition, with an explicitly present literal suffix.
  for (const [prefix, suffixes] of prefixes) {
    if (suffixes.length < 2) continue;
    const index = dictionary.length;
    const definition = compactTokenCount(JSON.stringify(prefix));
    const saving =
      suffixes.reduce(
        (sum, suffix) =>
          sum +
          compactTokenCount(JSON.stringify(prefix + suffix)) -
          compactTokenCount(
            JSON.stringify(suffix ? ["r", index, suffix] : ["r", index]),
          ) -
          1,
        0,
      ) -
      definition -
      2;
    if (saving > 0) {
      indices.set(prefix, { index, key: false, value: true, prefix: true });
      dictionary.push(prefix);
    }
  }
  for (const [text, count] of counts) {
    if (indices.has(text)) continue;
    if (count.keys + count.values < 2) continue;
    const index = dictionary.length;
    const definition = compactTokenCount(JSON.stringify(text));
    const keyCost = compactTokenCount(String(index));
    const valueCost = compactTokenCount(JSON.stringify(["r", index]));
    // Include the literal definition, separator and conservative boundary costs.
    const keySaving = Math.max(0, definition - keyCost - 1);
    const valueSaving = Math.max(0, definition - valueCost - 1);
    const saving =
      count.keys * keySaving + count.values * valueSaving - definition - 2;
    if (saving > 0) {
      indices.set(text, { index, key: keySaving > 0, value: valueSaving > 0 });
      dictionary.push(text);
    }
  }
  const pack = (value: unknown, field?: string): unknown => {
    if (typeof value === "string") {
      const id = idPrefix(value, field);
      const prefix = id && indices.get(id.prefix);
      if (id && prefix?.prefix)
        return id.suffix ? ["r", prefix.index, id.suffix] : ["r", prefix.index];
      const entry = indices.get(value);
      return entry?.value ? ["r", entry.index] : value;
    }
    if (!Array.isArray(value)) return value;
    const items = value as unknown[];
    const [tag, ...children] = items;
    if (typeof tag !== "string" || !TAGS.has(tag))
      return value.map((child) => pack(child));
    if (tag === "n") return value;
    if (tag === "o")
      return [
        tag,
        ...children.map((child, i) => {
          if (i % 2 === 0) {
            if (typeof child !== "string")
              throw new Error("Invalid compact object key.");
            const entry = indices.get(child);
            return entry?.key ? entry.index : child;
          }
          const field = children[i - 1];
          return pack(child, typeof field === "string" ? field : undefined);
        }),
      ];
    return [tag, ...children.map((child) => pack(child))];
  };
  const encoded = pack(baseline);
  const make = (dict: string[], data: unknown): CompactGraphson => ({
    format: "compact",
    compact_version: COMPACT_VERSION,
    encoding: COMPACT_GRAMMAR,
    dictionary: dict,
    graph: data,
  });
  const candidate = make(dictionary, encoded);
  const withoutDictionary = make([], baseline);
  // Check the entire wire object, including grammar and dictionary overhead.
  // Token savings are for this identified encoding, not every model/provider.
  return dictionary.length > 0 &&
    compactTokenCount(JSON.stringify(candidate)) <
      compactTokenCount(JSON.stringify(withoutDictionary))
    ? candidate
    : withoutDictionary;
}

// A verifier/library helper, never an extra user extraction tool.
export function decodeCompactGraphson(input: unknown): unknown {
  const envelope = record(input);
  if (
    envelope?.format !== "compact" ||
    envelope.compact_version !== COMPACT_VERSION ||
    envelope.encoding !== COMPACT_GRAMMAR ||
    !Array.isArray(envelope.dictionary) ||
    !envelope.dictionary.every((entry) => typeof entry === "string") ||
    !Object.hasOwn(envelope, "graph")
  )
    throw new Error("Invalid compact envelope.");
  const dictionary = envelope.dictionary;
  literal(dictionary);
  literal(envelope.graph);
  const lookup = (index: unknown): string => {
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= dictionary.length
    )
      throw new Error("Invalid compact reference.");
    return required(dictionary[index]);
  };
  const decode = (value: unknown): unknown => {
    if (!Array.isArray(value)) {
      literal(value);
      if (record(value)) throw new Error("Untagged compact object.");
      return value;
    }
    const items = value as unknown[];
    const [tag, ...children] = items;
    if (typeof tag !== "string" || !TAGS.has(tag))
      return value.map((child) => decode(child));
    if (tag === "r" && children.length === 1) return lookup(children[0]);
    if (tag === "r" && children.length === 2 && typeof children[1] === "string")
      return lookup(children[0]) + children[1];
    if (tag === "n" && children.length === 1 && children[0] === "-0") return -0;
    if (tag === "a") return children.map((child) => decode(child));
    if (tag === "t" && children.length === 2) {
      const type = decode(children[0]);
      if (typeof type !== "string") throw new Error("Invalid compact type.");
      return { "@type": type, "@value": decode(children[1]) };
    }
    if (tag === "o" && children.length % 2 === 0) {
      const result: Record<string, unknown> = {};
      for (let i = 0; i < children.length; i += 2) {
        const key =
          typeof children[i] === "number" ? lookup(children[i]) : children[i];
        if (typeof key !== "string" || Object.hasOwn(result, key))
          throw new Error("Invalid or duplicate compact key.");
        Object.defineProperty(result, key, {
          value: decode(children[i + 1]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
    throw new Error("Invalid compact tag or arity.");
  };
  return decode(envelope.graph);
}

export function compactSearchResult(
  result: Record<string, unknown>,
): Record<string, unknown> {
  const { graph, ...metadata } = result;
  // Definitions precede encoded data; all search/consistency metadata stays literal.
  const compact = encodeCompactGraphson(graph);
  return {
    format: compact.format,
    compact_version: compact.compact_version,
    ...metadata,
    encoding: compact.encoding,
    dictionary: compact.dictionary,
    graph: compact.graph,
  };
}
