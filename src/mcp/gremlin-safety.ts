export type GremlinToolMode = "read" | "write" | "delete";

export type GremlinClassification = GremlinToolMode;

export type GremlinValidationResult =
  | { ok: true; classification: GremlinClassification }
  | {
      ok: false;
      reason: "unsupported_syntax" | "tool_mismatch";
      classification?: GremlinClassification;
    };

type Token = {
  kind: "identifier" | "number" | "punctuation" | "string";
  value: string;
};

// This intentionally supports a conservative Gremlin-Groovy traversal subset.
// Unknown calls are denied so a new or dynamically-dispatched operation cannot
// silently cross a tool's safety boundary.
const READ_ONLY_CALLS = new Set([
  "E",
  "V",
  "aggregate",
  "all",
  "and",
  "any",
  "as",
  "asDate",
  "asString",
  "barrier",
  "between",
  "both",
  "bothE",
  "bothV",
  "branch",
  "by",
  "cap",
  "choose",
  "coin",
  "coalesce",
  "combine",
  "concat",
  "conjoin",
  "constant",
  "containing",
  "count",
  "cyclicPath",
  "dateAdd",
  "dateDiff",
  "dedup",
  "difference",
  "disjunct",
  "elementMap",
  "emit",
  "endingWith",
  "eq",
  "explain",
  "fail",
  "filter",
  "flatMap",
  "fold",
  "format",
  "from",
  "group",
  "groupCount",
  "gt",
  "gte",
  "has",
  "hasId",
  "hasKey",
  "hasLabel",
  "hasNot",
  "hasValue",
  "identity",
  "id",
  "in",
  "inE",
  "inV",
  "index",
  "inject",
  "inside",
  "intersect",
  "is",
  "iterate",
  "key",
  "label",
  "limit",
  "local",
  "loops",
  "lt",
  "lte",
  "map",
  "match",
  "math",
  "max",
  "mean",
  "merge",
  "min",
  "none",
  "not",
  "notContaining",
  "notEndingWith",
  "notRegex",
  "notStartingWith",
  "neq",
  "option",
  "optional",
  "or",
  "order",
  "otherV",
  "out",
  "outE",
  "outV",
  "outside",
  "path",
  "product",
  "profile",
  "project",
  "properties",
  "propertyMap",
  "range",
  "regex",
  "repeat",
  "replace",
  "sack",
  "sample",
  "select",
  "sideEffect",
  "simplePath",
  "skip",
  "split",
  "startingWith",
  "store",
  "subgraph",
  "sum",
  "tail",
  "timeLimit",
  "times",
  "to",
  "tree",
  "unfold",
  "union",
  "until",
  "value",
  "valueMap",
  "values",
  "where",
  "withBulk",
  "withPath",
  "withSack",
  "withSideEffect",
  "within",
  "without",
]);

const NON_DESTRUCTIVE_MUTATION_CALLS = new Set([
  "addE",
  "addV",
  "mergeE",
  "mergeV",
  "property",
]);

const DESTRUCTIVE_MUTATION_CALLS = new Set(["drop"]);

const ALLOWED_CALLS = new Set([
  ...READ_ONLY_CALLS,
  ...NON_DESTRUCTIVE_MUTATION_CALLS,
  ...DESTRUCTIVE_MUTATION_CALLS,
]);

// Bare identifiers are limited to traversal roots, literals, and Gremlin enum
// constants. Unquoted map keys are handled separately when followed by ':'.
const ALLOWED_BARE_IDENTIFIERS = new Set([
  "BOTH",
  "Barrier",
  "Cardinality",
  "Column",
  "DT",
  "Direction",
  "GValue",
  "IN",
  "Infinity",
  "Merge",
  "NaN",
  "OUT",
  "Operator",
  "Order",
  "P",
  "Pick",
  "Pop",
  "SackFunctions",
  "Scope",
  "T",
  "TextP",
  "WithOptions",
  "__",
  "addAll",
  "all",
  "and",
  "any",
  "asc",
  "assign",
  "current",
  "day",
  "desc",
  "div",
  "false",
  "first",
  "global",
  "hour",
  "id",
  "ids",
  "inV",
  "key",
  "keys",
  "label",
  "labels",
  "last",
  "list",
  "local",
  "max",
  "min",
  "minus",
  "minute",
  "mixed",
  "mult",
  "none",
  "normSack",
  "null",
  "onCreate",
  "onMatch",
  "or",
  "outV",
  "second",
  "set",
  "shuffle",
  "single",
  "sum",
  "sumLong",
  "tokens",
  "true",
  "value",
  "values",
]);

const NUMBER =
  /^(?:0[xX][0-9A-Fa-f]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?:[DdFfGgLl])?/u;

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_]/u.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_]/u.test(character);
}

function tokenize(query: string): Token[] | undefined {
  const tokens: Token[] = [];
  let index = 0;

  while (index < query.length) {
    const character = query[index];
    if (character === undefined) return undefined;

    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }

    if (character === "/" && query[index + 1] === "/") {
      index += 2;
      while (index < query.length && query[index] !== "\n") index += 1;
      continue;
    }

    if (character === "/" && query[index + 1] === "*") {
      const end = query.indexOf("*/", index + 2);
      if (end < 0) return undefined;
      index = end + 2;
      continue;
    }

    if (character === "'" || character === '"') {
      const quote = character;
      index += 1;
      let closed = false;
      while (index < query.length) {
        const stringCharacter = query[index];
        if (stringCharacter === undefined || stringCharacter === "\n") {
          return undefined;
        }
        if (stringCharacter === "\\") {
          index += 2;
          continue;
        }
        // Groovy interpolates unescaped '$' in double-quoted strings. Reject it
        // rather than attempting to prove the embedded expression harmless.
        if (quote === '"' && stringCharacter === "$") return undefined;
        if (stringCharacter === quote) {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) return undefined;
      tokens.push({ kind: "string", value: "" });
      continue;
    }

    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (index < query.length) {
        const identifierCharacter = query[index];
        if (
          identifierCharacter === undefined ||
          !isIdentifierPart(identifierCharacter)
        ) {
          break;
        }
        index += 1;
      }
      tokens.push({ kind: "identifier", value: query.slice(start, index) });
      continue;
    }

    if (/\d/u.test(character)) {
      const match = NUMBER.exec(query.slice(index));
      if (!match?.[0]) return undefined;
      tokens.push({ kind: "number", value: match[0] });
      index += match[0].length;
      continue;
    }

    if (character === "-" && /\d/u.test(query[index + 1] ?? "")) {
      const match = NUMBER.exec(query.slice(index + 1));
      if (!match?.[0]) return undefined;
      tokens.push({ kind: "number", value: `-${match[0]}` });
      index += match[0].length + 1;
      continue;
    }

    if (".,()[]:".includes(character)) {
      tokens.push({ kind: "punctuation", value: character });
      index += 1;
      continue;
    }

    // Reject Groovy statements, assignments, closures, interpolation, method
    // pointers, regex/slashy strings, spread/safe navigation, and operators.
    return undefined;
  }

  return tokens;
}

function isPunctuation(token: Token | undefined, value: string): boolean {
  return token?.kind === "punctuation" && token.value === value;
}

function inspectTokens(tokens: Token[]): { calls: Set<string> } | undefined {
  if (
    tokens.length < 4 ||
    tokens[0]?.kind !== "identifier" ||
    tokens[0].value !== "g" ||
    !isPunctuation(tokens[1], ".") ||
    tokens[2]?.kind !== "identifier" ||
    !isPunctuation(tokens[3], "(")
  ) {
    return undefined;
  }

  const calls = new Set<string>();
  const delimiters: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (token === undefined) return undefined;

    if (token.kind === "punctuation") {
      if (token.value === "(") {
        if (previous?.kind === "identifier") {
          if (!ALLOWED_CALLS.has(previous.value)) return undefined;
          calls.add(previous.value);
        } else if (
          previous !== undefined &&
          !(
            previous.kind === "punctuation" &&
            ["(", "[", ",", ":"].includes(previous.value)
          )
        ) {
          return undefined;
        }
        delimiters.push(")");
      } else if (token.value === "[") {
        if (
          previous !== undefined &&
          !(
            previous.kind === "punctuation" &&
            ["(", "[", ",", ":"].includes(previous.value)
          )
        ) {
          return undefined;
        }
        delimiters.push("]");
      } else if (token.value === ")" || token.value === "]") {
        if (delimiters.pop() !== token.value) return undefined;
        if (isPunctuation(next, "(")) return undefined;
      } else if (token.value === ".") {
        if (
          !(previous?.kind === "identifier" || isPunctuation(previous, ")")) ||
          next?.kind !== "identifier"
        ) {
          return undefined;
        }
      } else if (token.value === ":") {
        if (!delimiters.includes("]")) return undefined;
      } else if (token.value === ",") {
        if (delimiters.length === 0) return undefined;
      }
      continue;
    }

    if (token.kind === "string" || token.kind === "number") {
      if (isPunctuation(previous, ".") || isPunctuation(next, "(")) {
        return undefined;
      }
      continue;
    }

    if (isPunctuation(next, "(")) continue;

    if (index === 0 && token.value === "g") continue;

    if (isPunctuation(next, ":") && delimiters.includes("]")) {
      continue;
    }

    if (!ALLOWED_BARE_IDENTIFIERS.has(token.value)) return undefined;
  }

  if (delimiters.length > 0 || calls.size === 0) return undefined;
  return { calls };
}

export function classifyGremlin(
  query: string,
): GremlinClassification | undefined {
  const tokens = tokenize(query);
  if (!tokens) return undefined;
  const inspected = inspectTokens(tokens);
  if (!inspected) return undefined;

  if (
    [...inspected.calls].some((call) => DESTRUCTIVE_MUTATION_CALLS.has(call))
  ) {
    return "delete";
  }
  if (
    [...inspected.calls].some((call) =>
      NON_DESTRUCTIVE_MUTATION_CALLS.has(call),
    )
  ) {
    return "write";
  }
  return "read";
}

export function validateGremlinForTool(
  query: string,
  mode: GremlinToolMode,
): GremlinValidationResult {
  const classification = classifyGremlin(query);
  if (!classification) {
    return { ok: false, reason: "unsupported_syntax" };
  }
  if (classification !== mode) {
    return { ok: false, reason: "tool_mismatch", classification };
  }
  return { ok: true, classification };
}
