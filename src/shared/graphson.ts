import { createHash } from "node:crypto";

export type GraphsonValue = unknown;
export type TypedValue = { "@type": string; "@value": unknown };
export type ElementValue = TypedValue & { "@value": Record<string, unknown> };

export function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new Error("Required typed data is missing.");
  return value;
}

export function typed(type: string, value: unknown): TypedValue {
  return { "@type": type, "@value": value };
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isTyped(value: unknown, type?: string): value is TypedValue {
  const item = record(value);
  return (
    typeof item?.["@type"] === "string" &&
    Object.hasOwn(item, "@value") &&
    (type === undefined || item["@type"] === type)
  );
}

export function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isTyped(value, "g:List") || isTyped(value, "g:Set")) {
    if (Array.isArray(value["@value"])) return value["@value"];
  }
  throw new Error("Expected a GraphSON collection.");
}

// Decode only the projection's string keys. Its values remain typed GraphSON.
export function fields(value: unknown): Record<string, unknown> {
  if (!isTyped(value, "g:Map")) {
    const item = record(value);
    if (item && !isTyped(item)) return item;
    throw new Error("Expected a GraphSON map.");
  }
  const rawPairs = value["@value"];
  if (!Array.isArray(rawPairs) || rawPairs.length % 2 !== 0) {
    throw new Error("Malformed GraphSON map.");
  }
  const pairs = rawPairs as unknown[];
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (let i = 0; i < pairs.length; i += 2) {
    const key = pairs[i];
    if (typeof key !== "string") throw new Error("Expected string map keys.");
    result[key] = pairs[i + 1];
  }
  return result;
}

export function graphsonMap(value: Record<string, unknown>): TypedValue {
  return typed("g:Map", Object.entries(value).flat());
}

export function element(value: unknown): ElementValue | undefined {
  if (!isTyped(value, "g:Vertex") && !isTyped(value, "g:Edge")) {
    return undefined;
  }
  const body = record(value["@value"]);
  if (!body || typeof body.id !== "string") {
    throw new Error("Neptune elements must have string IDs.");
  }
  return value as ElementValue;
}

export function elementKind(value: ElementValue): "vertex" | "edge" {
  return value["@type"] === "g:Vertex" ? "vertex" : "edge";
}

export function elementId(value: ElementValue): string {
  return value["@value"].id as string;
}

function canonicalValue(value: unknown): unknown {
  if (isTyped(value, "g:Map")) {
    const pairs = list(value["@value"]);
    const entries: unknown[][] = [];
    for (let i = 0; i < pairs.length; i += 2) {
      entries.push([canonicalValue(pairs[i]), canonicalValue(pairs[i + 1])]);
    }
    entries.sort((a, b) =>
      JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])),
    );
    return typed("g:Map", entries.flat());
  }
  if (isTyped(value, "g:Set")) {
    const items = list(value["@value"]).map(canonicalValue);
    items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return typed("g:Set", items);
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  const item = record(value);
  if (item) {
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, canonicalValue(item[key])]),
    );
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

export function valueIdentity(value: unknown): string {
  const item = element(value);
  return item
    ? `${elementKind(item)}:${elementId(item)}`
    : `value:${fingerprint(value)}`;
}

export function assertLosslessNumbers(value: unknown): void {
  if (isTyped(value, "g:Double") || isTyped(value, "g:Float")) {
    const number = value["@value"];
    if (typeof number === "number" && !Number.isFinite(number)) {
      throw new Error(
        "Special floating values must retain their GraphSON encoding.",
      );
    }
    return;
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new Error(
        "The SDK cannot represent this numeric result losslessly.",
      );
    }
  } else if (Array.isArray(value)) {
    for (const item of value) assertLosslessNumbers(item);
  } else {
    const item = record(value);
    if (item)
      for (const child of Object.values(item)) assertLosslessNumbers(child);
  }
}

export function queryResults(result: unknown, maximum: number): unknown[] {
  const body = record(result);
  const data = body && Object.hasOwn(body, "data") ? body.data : result;
  if (isTyped(data, "g:BulkSet")) {
    const pairs = list(data["@value"]);
    if (pairs.length % 2 !== 0) throw new Error("Malformed GraphSON BulkSet.");
    const values: unknown[] = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const bulk = pairs[i + 1];
      const count = isTyped(bulk) ? bulk["@value"] : bulk;
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0
      ) {
        throw new Error("Malformed GraphSON bulk count.");
      }
      if (values.length + count > maximum)
        throw new Error("Too many query results.");
      for (let j = 0; j < count; j += 1) values.push(pairs[i]);
    }
    return values;
  }
  const values = list(data);
  if (values.length > maximum) throw new Error("Too many query results.");
  return values;
}
