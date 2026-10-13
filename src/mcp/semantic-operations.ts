import { createHash } from "node:crypto";

import {
  commitSemanticDeltaInputSchema,
  type CommitSemanticDeltaInput,
  type CommitSemanticDeltaResult,
  type GetGraphStateInput,
  type GraphState,
  type JsonScalar,
  type ReconcileOperationInput,
  type SemanticError,
  type SemanticErrorCode,
  type SemanticOperationResult,
  type SemanticPropertyValue,
  type SemanticRevisionSet,
} from "./semantic-contracts.js";
import {
  ExecutorInvocationError,
  type ExecutorInvoker,
} from "./executor-invoker.js";
import { safeLogger, type SafeLogger } from "../shared/logging.js";
import { MAX_QUERY_BYTES } from "../shared/contracts.js";

type UnknownRecord = Record<string, unknown>;
type PropertyMap = Record<string, SemanticPropertyValue>;
type SemanticCreateInput = CommitSemanticDeltaInput["creates"][number];
type ExpectedProperty =
  { present: false } | { present: true; value: SemanticPropertyValue };

type PlannedVertex = {
  id: string;
  graphLabel: string;
  properties: PropertyMap;
};

type PlannedUpdate = {
  id: string;
  set: PropertyMap;
  expected: Record<string, ExpectedProperty>;
};

type PlannedRelationship = {
  id: string;
  out: string;
  label: string;
  in: string;
  properties: PropertyMap;
};

export type SemanticOperationPlan = {
  operationId: string;
  receiptId: string;
  canonicalPayloadHash: string;
  canonicalPayloadJson: string;
  authorityEpoch: string;
  origin: CommitSemanticDeltaInput["origin"];
  createdAt: string;
  revisions: {
    before: SemanticRevisionSet;
    after: SemanticRevisionSet;
  };
  allocatorBefore: Record<string, string>;
  allocatorAfter: Record<string, string>;
  allocatedIds: Record<string, string>;
  creates: PlannedVertex[];
  updates: PlannedUpdate[];
  relationships: PlannedRelationship[];
};

type StoredReceipt = {
  operationId: string;
  payloadHash?: string;
  payloadJson?: string;
  planJson?: string;
  authorityEpoch?: string;
  status?: string;
};

type Verification = {
  verified: boolean;
  mismatches: string[];
  expectedVertices: number;
  actualVertices: number;
  expectedEdges: number;
  actualEdges: number;
};

type GraphSnapshot = {
  publicState: GraphState;
  allocatorValues: Record<string, string>;
};

export type SemanticOperationBackend = {
  readGraphState(
    input: GetGraphStateInput,
    requestId: string,
  ): Promise<GraphSnapshot>;
  readReceipt(
    operationId: string,
    requestId: string,
  ): Promise<StoredReceipt | undefined>;
  readVertices(
    ids: string[],
    requestId: string,
  ): Promise<Map<string, UnknownRecord>>;
  readEdges(
    ids: string[],
    requestId: string,
  ): Promise<Map<string, UnknownRecord>>;
  applyNewOperation(
    plan: SemanticOperationPlan,
    requestId: string,
  ): Promise<void>;
  applyRecovery(
    plan: SemanticOperationPlan,
    state: GraphSnapshot,
    requestId: string,
  ): Promise<void>;
  markReceipt(
    plan: SemanticOperationPlan,
    status: "complete" | "recovery_needed",
    verification: Verification,
    requestId: string,
  ): Promise<void>;
};

class SemanticFailure extends Error {
  public constructor(
    public readonly code: SemanticErrorCode,
    message: string,
    public readonly retrySafe: boolean,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SemanticFailure";
  }
}

class BackendFailure extends Error {
  public constructor(
    public readonly executorCode: string,
    public readonly mutationMayHaveStarted: boolean,
  ) {
    super("The semantic-operation backend request failed");
    this.name = "BackendFailure";
  }
}

const ALLOCATOR_FIELDS = [
  "next_primary_source_id",
  "next_primary_claim_id",
  "next_primary_concept_id",
  "next_primary_node_id",
  "next_primary_hole_id",
] as const;

type AllocatorField = (typeof ALLOCATOR_FIELDS)[number];

const OBJECT_ALLOCATORS: Record<
  string,
  { field: AllocatorField; prefix: string }
> = {
  SOURCE_EVIDENCE: { field: "next_primary_source_id", prefix: "S" },
  TURN_EVIDENCE: { field: "next_primary_source_id", prefix: "S" },
  CLAIM: { field: "next_primary_claim_id", prefix: "K" },
  CONCEPT: { field: "next_primary_concept_id", prefix: "T" },
  ENTITY: { field: "next_primary_node_id", prefix: "N" },
  NODE: { field: "next_primary_node_id", prefix: "N" },
  HOLE: { field: "next_primary_hole_id", prefix: "H" },
};

const DEFAULT_SEMANTIC_GRAPH_LABEL = "Object";
const INTERNAL_GRAPH_LABEL_KEY = "__graph_label";

const RESERVED_PROPERTIES = new Set([
  "id",
  "label",
  "object_type",
  "major_version",
  "origin_identity",
  "origin_actor",
  "origin_context",
  "authoritative_operation_id",
  "authoritative_revision",
  "authority_epoch",
]);

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function firstValue(record: UnknownRecord, key: string): unknown {
  const value = record[key];
  return Array.isArray(value) ? value[0] : value;
}

function stringValue(record: UnknownRecord, key: string): string | undefined {
  const value = firstValue(record, key);
  return typeof value === "string" ? value : undefined;
}

function numberValue(record: UnknownRecord, key: string): number | undefined {
  const value = firstValue(record, key);
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function booleanValue(record: UnknownRecord, key: string): boolean | undefined {
  const value = firstValue(record, key);
  return typeof value === "boolean" ? value : undefined;
}

function requiredString(
  record: UnknownRecord,
  key: string,
  context: string,
): string {
  const value = stringValue(record, key);
  if (value === undefined) {
    throw new SemanticFailure(
      "INTERNAL_ERROR",
      `The ${context} is missing ${key}.`,
      false,
    );
  }
  return value;
}

function requiredNumber(
  record: UnknownRecord,
  key: string,
  context: string,
): number {
  const value = numberValue(record, key);
  if (value === undefined) {
    throw new SemanticFailure(
      "INTERNAL_ERROR",
      `The ${context} is missing ${key}.`,
      false,
    );
  }
  return value;
}

function canonicalize(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    const record = asRecord(candidate);
    if (!record) return candidate;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, normalize(record[key])]),
    );
  };
  return JSON.stringify(normalize(value));
}

function canonicalPayload(input: CommitSemanticDeltaInput): {
  hash: string;
  json: string;
} {
  const payload = Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "operation_id"),
  );
  const json = canonicalize(payload);
  return {
    hash: createHash("sha256").update(json, "utf8").digest("hex"),
    json: canonicalize(input),
  };
}

function semanticError(error: SemanticFailure): SemanticError {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      retry_safe: error.retrySafe,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

function parseAllocatedId(
  value: string,
  prefix: string,
): {
  numeric: bigint;
  width: number;
} {
  const match = new RegExp(`^${prefix}(\\d+)$`, "u").exec(value);
  if (!match?.[1]) {
    throw new SemanticFailure(
      "ID_ALLOCATION_CONFLICT",
      `Allocator value ${value} does not use the expected ${prefix} prefix.`,
      false,
    );
  }
  return { numeric: BigInt(match[1]), width: match[1].length };
}

function formatAllocatedId(
  prefix: string,
  numeric: bigint,
  width: number,
): string {
  return `${prefix}${numeric.toString().padStart(width, "0")}`;
}

function resolveReference(
  value: string,
  allocatedIds: Record<string, string>,
): string {
  if (!value.startsWith("$")) return value;
  const resolved = allocatedIds[value];
  if (!resolved) {
    throw new SemanticFailure(
      "TEMP_REF_UNRESOLVED",
      `Temporary reference ${value} is not defined by this operation.`,
      false,
    );
  }
  return resolved;
}

function normalizedCreateReferences(create: SemanticCreateInput): {
  sourceRefs: string[];
  aboutRef?: string;
} {
  const genericSourceRefs = create.properties?.source_refs;
  const genericAboutRef = create.properties?.about_ref;
  const sourceRefs =
    create.source_refs ??
    (Array.isArray(genericSourceRefs)
      ? (genericSourceRefs as string[])
      : undefined);
  const aboutRef =
    create.about_ref ??
    (typeof genericAboutRef === "string" ? genericAboutRef : undefined);
  return {
    sourceRefs: sourceRefs ?? [],
    ...(aboutRef === undefined ? {} : { aboutRef }),
  };
}

function createCustomProperties(create: SemanticCreateInput): PropertyMap {
  const properties = { ...(create.properties ?? {}) };
  delete properties.source_refs;
  delete properties.about_ref;
  return properties;
}

function assertAllowedProperties(properties: PropertyMap | undefined): void {
  for (const key of Object.keys(properties ?? {})) {
    if (RESERVED_PROPERTIES.has(key)) {
      throw new SemanticFailure(
        "WRITER_SCOPE_DENIED",
        `Property ${key} is owned by the semantic-operation protocol.`,
        false,
      );
    }
  }
}

function semanticValuesEqual(
  actual: unknown,
  expected: SemanticPropertyValue,
): boolean {
  const actualValues = Array.isArray(actual) ? actual : [actual];
  const expectedValues = Array.isArray(expected) ? expected : [expected];
  if (actualValues.length !== expectedValues.length) return false;
  const left = actualValues.map(canonicalize).sort();
  const right = expectedValues.map(canonicalize).sort();
  return left.every((value, index) => value === right[index]);
}

function actualProperty(record: UnknownRecord, key: string): ExpectedProperty {
  if (!(key in record)) return { present: false };
  const raw = record[key];
  const values = Array.isArray(raw) ? raw : [raw];
  if (
    values.length === 0 ||
    !values.every(
      (value) =>
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)),
    )
  ) {
    throw new SemanticFailure(
      "MANUAL_REPAIR_REQUIRED",
      `Property ${key} cannot be represented by the typed semantic API.`,
      false,
    );
  }
  return {
    present: true,
    value:
      values.length === 1
        ? (values[0] as JsonScalar)
        : (values as JsonScalar[]),
  };
}

function propertyMatches(
  record: UnknownRecord,
  key: string,
  expected: ExpectedProperty,
): boolean {
  if (!expected.present) return !(key in record);
  return key in record && semanticValuesEqual(record[key], expected.value);
}

function revisionSet(state: GraphState): SemanticRevisionSet {
  return {
    semantic: state.semantic_revision,
    graph: state.graph_revision,
    projection: state.projection_revision,
  };
}

function receiptId(operationId: string): string {
  return `operation:${operationId}`;
}

function buildAllocations(
  input: CommitSemanticDeltaInput,
  allocatorBefore: Record<string, string>,
): {
  allocatedIds: Record<string, string>;
  allocatorAfter: Record<string, string>;
} {
  const allocatedIds: Record<string, string> = {};
  const allocatorAfter = { ...allocatorBefore };
  const parsed = new Map<
    AllocatorField,
    { prefix: string; numeric: bigint; width: number; reserved: Set<bigint> }
  >();

  for (const [objectType, allocation] of Object.entries(OBJECT_ALLOCATORS)) {
    if (parsed.has(allocation.field)) continue;
    const current = allocatorBefore[allocation.field];
    if (!current) {
      throw new SemanticFailure(
        "ID_ALLOCATION_CONFLICT",
        `Allocator ${allocation.field} is unavailable for ${objectType}.`,
        false,
      );
    }
    const decoded = parseAllocatedId(current, allocation.prefix);
    parsed.set(allocation.field, {
      ...allocation,
      ...decoded,
      reserved: new Set(),
    });
  }

  for (const create of input.creates) {
    const allocation = OBJECT_ALLOCATORS[create.object_type];
    if (!allocation || !create.id) continue;
    const decoded = parseAllocatedId(create.id, allocation.prefix);
    parsed.get(allocation.field)?.reserved.add(decoded.numeric);
  }

  for (const create of input.creates) {
    if (!create.ref) continue;
    if (allocatedIds[create.ref]) {
      throw new SemanticFailure(
        "VALIDATION_ERROR",
        `Temporary reference ${create.ref} is duplicated.`,
        false,
      );
    }
    const allocation = OBJECT_ALLOCATORS[create.object_type];
    if (!allocation) {
      throw new SemanticFailure(
        "VALIDATION_ERROR",
        `Object type ${create.object_type} requires an explicit id because it has no allocator.`,
        false,
      );
    }
    const cursor = parsed.get(allocation.field);
    if (!cursor) {
      throw new SemanticFailure(
        "ID_ALLOCATION_CONFLICT",
        `Allocator ${allocation.field} is unavailable.`,
        false,
      );
    }
    while (cursor.reserved.has(cursor.numeric)) cursor.numeric += 1n;
    allocatedIds[create.ref] = formatAllocatedId(
      cursor.prefix,
      cursor.numeric,
      cursor.width,
    );
    cursor.reserved.add(cursor.numeric);
    cursor.numeric += 1n;
  }

  for (const create of input.creates) {
    const allocation = OBJECT_ALLOCATORS[create.object_type];
    if (!allocation || !create.id) continue;
    const decoded = parseAllocatedId(create.id, allocation.prefix);
    const cursor = parsed.get(allocation.field);
    if (cursor && decoded.numeric >= cursor.numeric) {
      cursor.numeric = decoded.numeric + 1n;
    }
  }

  for (const [field, cursor] of parsed) {
    allocatorAfter[field] = formatAllocatedId(
      cursor.prefix,
      cursor.numeric,
      cursor.width,
    );
  }

  return { allocatedIds, allocatorAfter };
}

function relationshipId(out: string, label: string, incoming: string): string {
  return `port:${out}:${label}:${incoming}`;
}

function addRelationship(
  relationships: PlannedRelationship[],
  seen: Map<string, PlannedRelationship>,
  relationship: PlannedRelationship,
): void {
  if (relationship.id.length > 512) {
    throw new SemanticFailure(
      "VALIDATION_ERROR",
      "A deterministic relationship id exceeds the 512-character typed-operation limit.",
      false,
    );
  }
  const existing = seen.get(relationship.id);
  if (existing) {
    if (canonicalize(existing) !== canonicalize(relationship)) {
      throw new SemanticFailure(
        "RELATIONSHIP_CONFLICT",
        `Relationship id ${relationship.id} has conflicting definitions.`,
        false,
      );
    }
    return;
  }
  seen.set(relationship.id, relationship);
  relationships.push(relationship);
}

function edgeProperties(
  input: CommitSemanticDeltaInput,
  revision: number,
  label: string,
  custom: PropertyMap | undefined,
): PropertyMap {
  assertAllowedProperties(custom);
  return {
    ...(custom ?? {}),
    slot: label,
    epistemic_class: "port",
    major_version: 0,
    origin_identity: input.origin.identity,
    origin_actor: input.origin.actor,
    origin_context: input.origin.context,
    authoritative_operation_id: input.operation_id,
    authoritative_revision: revision,
    authority_epoch: input.authority_epoch,
  };
}

function canonicalCreates(
  input: CommitSemanticDeltaInput,
  allocatedIds: Record<string, string>,
  revision: number,
): PlannedVertex[] {
  const result: PlannedVertex[] = [];
  const seenIds = new Set<string>();
  for (const create of input.creates) {
    const customProperties = createCustomProperties(create);
    assertAllowedProperties(customProperties);
    const id = create.id ?? resolveReference(create.ref ?? "", allocatedIds);
    if (seenIds.has(id)) {
      throw new SemanticFailure(
        "VALIDATION_ERROR",
        `Create id ${id} is duplicated.`,
        false,
      );
    }
    seenIds.add(id);
    const references = normalizedCreateReferences(create);
    const sourceRefs = references.sourceRefs.map((reference) =>
      resolveReference(reference, allocatedIds),
    );
    const aboutRef =
      references.aboutRef === undefined
        ? undefined
        : resolveReference(references.aboutRef, allocatedIds);
    result.push({
      id,
      graphLabel: create.graph_label ?? DEFAULT_SEMANTIC_GRAPH_LABEL,
      properties: {
        ...customProperties,
        object_type: create.object_type,
        ...(create.label === undefined ? {} : { label: create.label }),
        ...(create.canonical === undefined
          ? {}
          : { canonical: create.canonical }),
        ...(create.decision_state === undefined
          ? {}
          : { decision_state: create.decision_state }),
        ...(create.epistemic_class === undefined
          ? {}
          : { epistemic_class: create.epistemic_class }),
        ...(create.sensitivity === undefined
          ? {}
          : { sensitivity: create.sensitivity }),
        ...(sourceRefs.length === 0 ? {} : { source_refs: sourceRefs }),
        ...(aboutRef === undefined ? {} : { about_ref: aboutRef }),
        major_version: 0,
        origin_identity: input.origin.identity,
        origin_actor: input.origin.actor,
        origin_context: input.origin.context,
        authoritative_operation_id: input.operation_id,
        authoritative_revision: revision,
        authority_epoch: input.authority_epoch,
      },
    });
  }
  return result;
}

function canonicalRelationships(
  input: CommitSemanticDeltaInput,
  allocatedIds: Record<string, string>,
  revision: number,
): PlannedRelationship[] {
  const relationships: PlannedRelationship[] = [];
  const seen = new Map<string, PlannedRelationship>();
  for (const relationship of input.relationships) {
    const out = resolveReference(relationship.out, allocatedIds);
    const incoming = resolveReference(relationship.in, allocatedIds);
    const id =
      relationship.id ?? relationshipId(out, relationship.label, incoming);
    if (relationship.ref) {
      if (
        allocatedIds[relationship.ref] &&
        allocatedIds[relationship.ref] !== id
      ) {
        throw new SemanticFailure(
          "VALIDATION_ERROR",
          `Temporary reference ${relationship.ref} is duplicated.`,
          false,
        );
      }
      allocatedIds[relationship.ref] = id;
    }
    addRelationship(relationships, seen, {
      id,
      out,
      label: relationship.label,
      in: incoming,
      properties: edgeProperties(
        input,
        revision,
        relationship.label,
        relationship.properties,
      ),
    });
  }
  for (const create of input.creates) {
    const out = create.id ?? resolveReference(create.ref ?? "", allocatedIds);
    const references = normalizedCreateReferences(create);
    for (const sourceRef of references.sourceRefs) {
      const incoming = resolveReference(sourceRef, allocatedIds);
      const label = "source";
      addRelationship(relationships, seen, {
        id: relationshipId(out, label, incoming),
        out,
        label,
        in: incoming,
        properties: edgeProperties(input, revision, label, undefined),
      });
    }
    if (references.aboutRef !== undefined) {
      const incoming = resolveReference(references.aboutRef, allocatedIds);
      const label = "about";
      addRelationship(relationships, seen, {
        id: relationshipId(out, label, incoming),
        out,
        label,
        in: incoming,
        properties: edgeProperties(input, revision, label, undefined),
      });
    }
  }
  for (const supersession of input.supersessions) {
    const out = resolveReference(supersession.newer, allocatedIds);
    const incoming = resolveReference(supersession.older, allocatedIds);
    const label = "supersedes";
    addRelationship(relationships, seen, {
      id: relationshipId(out, label, incoming),
      out,
      label,
      in: incoming,
      properties: edgeProperties(input, revision, label, undefined),
    });
  }
  return relationships;
}

async function buildPlan(
  input: CommitSemanticDeltaInput,
  state: GraphSnapshot,
  backend: SemanticOperationBackend,
  requestId: string,
  now: () => Date,
): Promise<SemanticOperationPlan> {
  const payload = canonicalPayload(input);
  const allocatorBefore = { ...state.allocatorValues };
  const { allocatedIds, allocatorAfter } = buildAllocations(
    input,
    allocatorBefore,
  );
  const before = revisionSet(state.publicState);
  const after = {
    semantic: before.semantic + (input.revision_effect.semantic ? 1 : 0),
    graph: before.graph + (input.revision_effect.graph ? 1 : 0),
    projection: before.projection + (input.revision_effect.projection ? 1 : 0),
  };

  const creates = canonicalCreates(input, allocatedIds, after.semantic);
  const createIds = new Set(creates.map((create) => create.id));
  const relationships = canonicalRelationships(
    input,
    allocatedIds,
    after.semantic,
  );

  const updateIds = [
    ...new Set(input.property_updates.map((update) => update.id)),
  ];
  const endpointIds = new Set(
    relationships.flatMap((relationship) => [
      relationship.out,
      relationship.in,
    ]),
  );
  const existingNeeded = [...new Set([...updateIds, ...endpointIds])].filter(
    (id) => !createIds.has(id),
  );
  const existingVertices = await backend.readVertices(
    existingNeeded,
    requestId,
  );
  for (const id of existingNeeded) {
    const existing = existingVertices.get(id);
    if (!existing) {
      throw new SemanticFailure(
        "REFERENCE_NOT_FOUND",
        `Referenced semantic object ${id} does not exist.`,
        false,
        { id },
      );
    }
    if (firstValue(existing, "major_version") !== 0) {
      throw new SemanticFailure(
        "WRITER_SCOPE_DENIED",
        `Referenced semantic object ${id} is outside major version 0.`,
        false,
      );
    }
  }

  const updates: PlannedUpdate[] = [];
  const seenUpdateIds = new Set<string>();
  for (const update of input.property_updates) {
    if (seenUpdateIds.has(update.id)) {
      throw new SemanticFailure(
        "VALIDATION_ERROR",
        `Update target ${update.id} is duplicated.`,
        false,
      );
    }
    seenUpdateIds.add(update.id);
    assertAllowedProperties(update.set);
    assertAllowedProperties(update.expected);
    if (createIds.has(update.id)) {
      throw new SemanticFailure(
        "VALIDATION_ERROR",
        `New object ${update.id} must be fully described in creates, not property_updates.`,
        false,
      );
    }
    const current = existingVertices.get(update.id);
    if (!current) {
      throw new SemanticFailure(
        "VALIDATION_ERROR",
        `Update target ${update.id} does not exist.`,
        false,
      );
    }
    if (firstValue(current, "object_type") === "SOURCE_EVIDENCE") {
      throw new SemanticFailure(
        "WRITER_SCOPE_DENIED",
        `Source evidence ${update.id} is immutable.`,
        false,
      );
    }
    if (firstValue(current, "major_version") !== 0) {
      throw new SemanticFailure(
        "WRITER_SCOPE_DENIED",
        `Update target ${update.id} is outside major version 0.`,
        false,
      );
    }
    const expected: Record<string, ExpectedProperty> = {};
    for (const [key, value] of Object.entries(update.expected ?? {})) {
      const actual = actualProperty(current, key);
      if (!propertyMatches(current, key, { present: true, value })) {
        throw new SemanticFailure(
          "REVISION_CONFLICT",
          `Update precondition failed for ${update.id}.${key}.`,
          true,
          { id: update.id, property: key },
        );
      }
      expected[key] = actual;
    }
    for (const [key, desired] of Object.entries(update.set)) {
      const actual = actualProperty(current, key);
      expected[key] ??= actual;
      if (Array.isArray(desired) && actual.present) {
        const currentValues = Array.isArray(actual.value)
          ? actual.value
          : [actual.value];
        if (
          currentValues.some(
            (value) =>
              !desired.some(
                (candidate) => canonicalize(candidate) === canonicalize(value),
              ),
          )
        ) {
          throw new SemanticFailure(
            "WRITER_SCOPE_DENIED",
            `Updating ${update.id}.${key} would require destructive multi-property removal.`,
            false,
          );
        }
      }
    }
    const stampedSet: PropertyMap = {
      ...update.set,
      origin_identity: input.origin.identity,
      origin_actor: input.origin.actor,
      origin_context: input.origin.context,
      authoritative_operation_id: input.operation_id,
      authoritative_revision: after.semantic,
      authority_epoch: input.authority_epoch,
    };
    for (const key of Object.keys(stampedSet)) {
      expected[key] ??= actualProperty(current, key);
    }
    updates.push({ id: update.id, expected, set: stampedSet });
  }

  return {
    operationId: input.operation_id,
    receiptId: receiptId(input.operation_id),
    canonicalPayloadHash: payload.hash,
    canonicalPayloadJson: payload.json,
    authorityEpoch: input.authority_epoch,
    origin: input.origin,
    createdAt: now().toISOString(),
    revisions: { before, after },
    allocatorBefore,
    allocatorAfter,
    allocatedIds,
    creates,
    updates,
    relationships,
  };
}

function planFromReceipt(receipt: StoredReceipt): SemanticOperationPlan {
  if (!receipt.planJson) {
    throw new SemanticFailure(
      "MANUAL_REPAIR_REQUIRED",
      "The operation receipt does not contain a recoverable operation plan.",
      false,
      { operation_id: receipt.operationId },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(receipt.planJson);
  } catch {
    throw new SemanticFailure(
      "MANUAL_REPAIR_REQUIRED",
      "The operation receipt contains an invalid recovery plan.",
      false,
      { operation_id: receipt.operationId },
    );
  }
  const plan = asRecord(parsed);
  if (
    plan?.operationId !== receipt.operationId ||
    typeof plan.canonicalPayloadHash !== "string" ||
    !Array.isArray(plan.creates) ||
    !Array.isArray(plan.updates) ||
    !Array.isArray(plan.relationships)
  ) {
    throw new SemanticFailure(
      "MANUAL_REPAIR_REQUIRED",
      "The operation receipt recovery plan is internally inconsistent.",
      false,
      { operation_id: receipt.operationId },
    );
  }
  return parsed as SemanticOperationPlan;
}

function successResult(
  plan: SemanticOperationPlan,
  status: CommitSemanticDeltaResult["status"],
): CommitSemanticDeltaResult {
  return {
    ok: true,
    operation_id: plan.operationId,
    status,
    authority_epoch: plan.authorityEpoch,
    revisions: plan.revisions,
    allocated_ids: plan.allocatedIds,
    created_ids: plan.creates.map((create) => create.id),
    updated_ids: plan.updates.map((update) => update.id),
    relationship_ids: plan.relationships.map((relationship) => relationship.id),
    verification: { verified: true, mismatch_count: 0 },
  };
}

function pushMismatch(mismatches: string[], value: string): void {
  if (mismatches.length < 100) mismatches.push(value);
}

type CanonicalExpectations = {
  input: CommitSemanticDeltaInput;
  allocatedIds: Record<string, string>;
  allocatorAfter: Record<string, string>;
  creates: PlannedVertex[];
  relationships: PlannedRelationship[];
};

function canonicalExpectations(
  plan: SemanticOperationPlan,
): CanonicalExpectations {
  let decoded: unknown;
  try {
    decoded = JSON.parse(plan.canonicalPayloadJson);
  } catch {
    throw new SemanticFailure(
      "MANUAL_REPAIR_REQUIRED",
      "The operation receipt canonical payload is not valid JSON.",
      false,
      { operation_id: plan.operationId },
    );
  }
  const parsed = commitSemanticDeltaInputSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.operation_id !== plan.operationId) {
    throw new SemanticFailure(
      "MANUAL_REPAIR_REQUIRED",
      "The operation receipt canonical payload does not satisfy the current semantic contract.",
      false,
      { operation_id: plan.operationId },
    );
  }
  const input = parsed.data;
  const allocation = buildAllocations(input, plan.allocatorBefore);
  const revision =
    input.expected.semantic_revision + (input.revision_effect.semantic ? 1 : 0);
  const creates = canonicalCreates(input, allocation.allocatedIds, revision);
  const relationships = canonicalRelationships(
    input,
    allocation.allocatedIds,
    revision,
  );
  return {
    input,
    allocatedIds: allocation.allocatedIds,
    allocatorAfter: allocation.allocatorAfter,
    creates,
    relationships,
  };
}

function canonicalPlanMismatches(plan: SemanticOperationPlan): string[] {
  const expected = canonicalExpectations(plan);
  const mismatches: string[] = [];
  const expectedPayload = canonicalPayload(expected.input);
  if (plan.canonicalPayloadHash !== expectedPayload.hash) {
    pushMismatch(mismatches, "canonical payload hash");
  }
  if (plan.receiptId !== receiptId(expected.input.operation_id)) {
    pushMismatch(mismatches, "operation receipt id");
  }
  if (plan.authorityEpoch !== expected.input.authority_epoch) {
    pushMismatch(mismatches, "operation authority epoch");
  }
  if (canonicalize(plan.origin) !== canonicalize(expected.input.origin)) {
    pushMismatch(mismatches, "operation origin");
  }
  if (
    plan.revisions.before.semantic !==
      expected.input.expected.semantic_revision ||
    (expected.input.expected.graph_revision !== undefined &&
      plan.revisions.before.graph !== expected.input.expected.graph_revision) ||
    (expected.input.expected.projection_revision !== undefined &&
      plan.revisions.before.projection !==
        expected.input.expected.projection_revision)
  ) {
    pushMismatch(mismatches, "operation starting revisions");
  }
  const expectedAfter: SemanticRevisionSet = {
    semantic:
      plan.revisions.before.semantic +
      (expected.input.revision_effect.semantic ? 1 : 0),
    graph:
      plan.revisions.before.graph +
      (expected.input.revision_effect.graph ? 1 : 0),
    projection:
      plan.revisions.before.projection +
      (expected.input.revision_effect.projection ? 1 : 0),
  };
  if (canonicalize(plan.revisions.after) !== canonicalize(expectedAfter)) {
    pushMismatch(mismatches, "operation resulting revisions");
  }
  if (canonicalize(plan.allocatedIds) !== canonicalize(expected.allocatedIds)) {
    pushMismatch(mismatches, "allocated ids");
  }
  if (
    canonicalize(plan.allocatorAfter) !== canonicalize(expected.allocatorAfter)
  ) {
    pushMismatch(mismatches, "allocator result");
  }
  if (canonicalize(plan.creates) !== canonicalize(expected.creates)) {
    pushMismatch(mismatches, "canonical semantic creates");
  }
  if (
    canonicalize(plan.relationships) !== canonicalize(expected.relationships)
  ) {
    pushMismatch(mismatches, "canonical semantic relationships");
  }
  return mismatches;
}

function assertCanonicalPlan(plan: SemanticOperationPlan): void {
  const mismatches = canonicalPlanMismatches(plan);
  if (mismatches.length > 0) {
    throw new SemanticFailure(
      "MANUAL_REPAIR_REQUIRED",
      "The durable operation plan does not match canonical major-version-0 serialization.",
      false,
      { operation_id: plan.operationId, mismatches },
    );
  }
}

async function verifyPlan(
  plan: SemanticOperationPlan,
  backend: SemanticOperationBackend,
  requestId: string,
): Promise<Verification> {
  const canonical = canonicalExpectations(plan);
  const vertexIds = [
    plan.receiptId,
    ...canonical.creates.map((value) => value.id),
    ...plan.updates.map((value) => value.id),
  ];
  const vertices = await backend.readVertices(
    [...new Set(vertexIds)],
    requestId,
  );
  const edges = await backend.readEdges(
    canonical.relationships.map((relationship) => relationship.id),
    requestId,
  );
  const state = await backend.readGraphState(
    { include_allocators: true, include_v1_state: false },
    requestId,
  );
  const mismatches: string[] = [];
  const receipt = vertices.get(plan.receiptId);
  if (
    !receipt ||
    firstValue(receipt, "canonical_payload_hash") !== plan.canonicalPayloadHash
  ) {
    pushMismatch(mismatches, "operation receipt identity");
  }
  for (const create of canonical.creates) {
    const actual = vertices.get(create.id);
    if (!actual) {
      pushMismatch(mismatches, `missing vertex ${create.id}`);
      continue;
    }
    if (firstValue(actual, INTERNAL_GRAPH_LABEL_KEY) !== create.graphLabel) {
      pushMismatch(mismatches, `vertex label ${create.id}`);
    }
    for (const [key, expected] of Object.entries(create.properties)) {
      if (!semanticValuesEqual(actual[key], expected)) {
        pushMismatch(mismatches, `vertex property ${create.id}.${key}`);
      }
    }
  }
  for (const update of plan.updates) {
    const actual = vertices.get(update.id);
    if (!actual) {
      pushMismatch(mismatches, `missing update target ${update.id}`);
      continue;
    }
    for (const [key, expected] of Object.entries(update.set)) {
      if (!semanticValuesEqual(actual[key], expected)) {
        pushMismatch(mismatches, `updated property ${update.id}.${key}`);
      }
    }
  }
  for (const relationship of canonical.relationships) {
    const actual = edges.get(relationship.id);
    if (!actual) {
      pushMismatch(mismatches, `missing relationship ${relationship.id}`);
      continue;
    }
    if (
      firstValue(actual, "label") !== relationship.label ||
      firstValue(actual, "out") !== relationship.out ||
      firstValue(actual, "in") !== relationship.in
    ) {
      pushMismatch(mismatches, `relationship identity ${relationship.id}`);
    }
    const properties = asRecord(actual.properties) ?? {};
    for (const [key, expected] of Object.entries(relationship.properties)) {
      if (!semanticValuesEqual(properties[key], expected)) {
        pushMismatch(
          mismatches,
          `relationship property ${relationship.id}.${key}`,
        );
      }
    }
  }
  const current = state.publicState;
  if (current.semantic_revision < plan.revisions.after.semantic) {
    pushMismatch(mismatches, "semantic revision");
  }
  if (current.graph_revision < plan.revisions.after.graph) {
    pushMismatch(mismatches, "graph revision");
  }
  if (current.projection_revision < plan.revisions.after.projection) {
    pushMismatch(mismatches, "projection revision");
  }
  for (const [field, expected] of Object.entries(plan.allocatorAfter)) {
    const actual = state.allocatorValues[field];
    const prefix = expected.slice(0, 1);
    if (
      !actual ||
      parseAllocatedId(actual, prefix).numeric <
        parseAllocatedId(expected, prefix).numeric
    ) {
      pushMismatch(mismatches, `allocator ${field}`);
    }
  }
  return {
    verified: mismatches.length === 0,
    mismatches,
    expectedVertices: 1 + canonical.creates.length + plan.updates.length,
    actualVertices: vertices.size,
    expectedEdges: canonical.relationships.length,
    actualEdges: edges.size,
  };
}

function ensureAuthorityAndRevision(
  input: CommitSemanticDeltaInput,
  state: GraphSnapshot,
): void {
  const current = state.publicState;
  if (current.authority_epoch !== input.authority_epoch) {
    throw new SemanticFailure(
      "AUTHORITY_EPOCH_MISMATCH",
      "The live authority epoch does not match the requested epoch.",
      true,
      { expected: input.authority_epoch, actual: current.authority_epoch },
    );
  }
  const mismatches: Record<string, { expected: number; actual: number }> = {};
  if (current.semantic_revision !== input.expected.semantic_revision) {
    mismatches.semantic_revision = {
      expected: input.expected.semantic_revision,
      actual: current.semantic_revision,
    };
  }
  if (
    input.expected.graph_revision !== undefined &&
    current.graph_revision !== input.expected.graph_revision
  ) {
    mismatches.graph_revision = {
      expected: input.expected.graph_revision,
      actual: current.graph_revision,
    };
  }
  if (
    input.expected.projection_revision !== undefined &&
    current.projection_revision !== input.expected.projection_revision
  ) {
    mismatches.projection_revision = {
      expected: input.expected.projection_revision,
      actual: current.projection_revision,
    };
  }
  if (Object.keys(mismatches).length > 0) {
    throw new SemanticFailure(
      "REVISION_CONFLICT",
      "The live graph revision state has advanced beyond the requested boundary.",
      true,
      mismatches,
    );
  }
}

export type SemanticOperations = {
  getGraphState(
    input: GetGraphStateInput,
    requestId: string,
  ): Promise<GraphState | SemanticError>;
  commitSemanticDelta(
    input: CommitSemanticDeltaInput,
    requestId: string,
  ): Promise<SemanticOperationResult>;
  reconcileOperation(
    input: ReconcileOperationInput,
    requestId: string,
  ): Promise<SemanticOperationResult>;
};

export function createSemanticOperations(
  backend: SemanticOperationBackend,
  options: { logger?: SafeLogger; now?: () => Date } = {},
): SemanticOperations {
  const logger = options.logger ?? safeLogger;
  const now = options.now ?? (() => new Date());

  const logTransition = (
    requestId: string,
    operationId: string,
    transition: string,
    status?: string,
  ) => {
    logger.info({
      component: "mcp",
      event: `semantic_operation_${transition}`,
      request_id: requestId,
      operation_id: operationId,
      ...(status === undefined ? {} : { status }),
    });
  };

  const finishPlan = async (
    plan: SemanticOperationPlan,
    requestId: string,
    status: CommitSemanticDeltaResult["status"],
  ): Promise<SemanticOperationResult> => {
    assertCanonicalPlan(plan);
    logTransition(requestId, plan.operationId, "verify");
    const verification = await verifyPlan(plan, backend, requestId);
    if (!verification.verified) {
      try {
        await backend.markReceipt(
          plan,
          "recovery_needed",
          verification,
          requestId,
        );
      } catch {
        logger.error({
          component: "mcp",
          event: "semantic_operation_recovery_status_unconfirmed",
          request_id: requestId,
          operation_id: plan.operationId,
          status: "RECOVERY_NEEDED",
        });
      }
      throw new SemanticFailure(
        "RECOVERY_NEEDED",
        "The semantic mutation did not pass exact readback verification.",
        false,
        {
          operation_id: plan.operationId,
          mismatches: verification.mismatches,
        },
      );
    }
    try {
      await backend.markReceipt(plan, "complete", verification, requestId);
    } catch {
      const uncertainReceipt = await backend
        .readReceipt(plan.operationId, requestId)
        .catch(() => undefined);
      if (
        uncertainReceipt?.status === "complete" &&
        uncertainReceipt.payloadHash === plan.canonicalPayloadHash
      ) {
        logTransition(requestId, plan.operationId, "complete", status);
        return successResult(plan, status);
      }
      throw new SemanticFailure(
        "RECOVERY_NEEDED",
        "Exact graph verification passed, but receipt completion acknowledgement was lost.",
        false,
        { operation_id: plan.operationId },
      );
    }
    const completed = await backend.readReceipt(plan.operationId, requestId);
    if (
      completed?.status !== "complete" ||
      completed.payloadHash !== plan.canonicalPayloadHash
    ) {
      throw new SemanticFailure(
        "RECOVERY_NEEDED",
        "Exact graph verification passed, but receipt completion was not confirmed.",
        false,
        { operation_id: plan.operationId },
      );
    }
    logTransition(requestId, plan.operationId, "complete", status);
    return successResult(plan, status);
  };

  const reconcileReceipt = async (
    receipt: StoredReceipt,
    requestId: string,
    allowContinue: boolean,
    requestedEpoch?: string,
    completeStatus: CommitSemanticDeltaResult["status"] = "recovered_complete",
  ): Promise<SemanticOperationResult> => {
    const plan = planFromReceipt(receipt);
    assertCanonicalPlan(plan);
    if (receipt.payloadHash !== plan.canonicalPayloadHash) {
      throw new SemanticFailure(
        "MANUAL_REPAIR_REQUIRED",
        "The operation receipt payload identity is internally inconsistent.",
        false,
        { operation_id: receipt.operationId },
      );
    }
    if (requestedEpoch && requestedEpoch !== plan.authorityEpoch) {
      throw new SemanticFailure(
        "AUTHORITY_EPOCH_MISMATCH",
        "The requested reconciliation epoch does not match the operation receipt.",
        true,
        { expected: requestedEpoch, actual: plan.authorityEpoch },
      );
    }
    const state = await backend.readGraphState(
      { include_allocators: true, include_v1_state: false },
      requestId,
    );
    if (state.publicState.authority_epoch !== plan.authorityEpoch) {
      throw new SemanticFailure(
        "AUTHORITY_EPOCH_MISMATCH",
        "The live authority epoch no longer matches the operation receipt.",
        true,
        {
          expected: plan.authorityEpoch,
          actual: state.publicState.authority_epoch,
        },
      );
    }
    logger.info({
      component: "mcp",
      event: "semantic_operation_recovery_plan_loaded",
      request_id: requestId,
      operation_id: plan.operationId,
      tool_name: "reconcile_operation",
      authority_epoch: plan.authorityEpoch,
      expected_revision: plan.revisions.before.semantic,
      observed_revision: state.publicState.semantic_revision,
      canonical_payload_hash: plan.canonicalPayloadHash,
      allocated_ids: canonicalize(plan.allocatedIds),
    });
    const verification = await verifyPlan(plan, backend, requestId);
    if (verification.verified) {
      if (receipt.status === "complete") {
        logTransition(
          requestId,
          plan.operationId,
          "already_complete",
          "already_complete",
        );
        return successResult(plan, "already_complete");
      }
      return await finishPlan(plan, requestId, completeStatus);
    }
    if (!allowContinue) {
      throw new SemanticFailure(
        "RECOVERY_NEEDED",
        "The operation is incomplete and continuation was disabled.",
        false,
        {
          operation_id: plan.operationId,
          mismatches: verification.mismatches,
        },
      );
    }

    const vertices = await backend.readVertices(
      [
        ...new Set([
          ...plan.creates.map((value) => value.id),
          ...plan.updates.map((value) => value.id),
        ]),
      ],
      requestId,
    );
    for (const create of plan.creates) {
      const actual = vertices.get(create.id);
      if (!actual) continue;
      if (
        firstValue(actual, INTERNAL_GRAPH_LABEL_KEY) !== create.graphLabel ||
        Object.entries(create.properties).some(
          ([key, expected]) => !semanticValuesEqual(actual[key], expected),
        )
      ) {
        throw new SemanticFailure(
          "TARGET_ALREADY_EXISTS_CONFLICT",
          `Existing partial target ${create.id} conflicts with the receipt.`,
          false,
          { operation_id: plan.operationId, id: create.id },
        );
      }
    }
    for (const update of plan.updates) {
      const actual = vertices.get(update.id);
      if (!actual) {
        throw new SemanticFailure(
          "MANUAL_REPAIR_REQUIRED",
          `Update target ${update.id} is missing during reconciliation.`,
          false,
        );
      }
      for (const [key, desired] of Object.entries(update.set)) {
        if (
          !semanticValuesEqual(actual[key], desired) &&
          !propertyMatches(
            actual,
            key,
            update.expected[key] ?? { present: false },
          )
        ) {
          throw new SemanticFailure(
            "MANUAL_REPAIR_REQUIRED",
            `Update target ${update.id}.${key} changed after the operation began.`,
            false,
          );
        }
      }
    }
    const edges = await backend.readEdges(
      plan.relationships.map((relationship) => relationship.id),
      requestId,
    );
    for (const relationship of plan.relationships) {
      const actual = edges.get(relationship.id);
      if (!actual) continue;
      if (
        firstValue(actual, "label") !== relationship.label ||
        firstValue(actual, "out") !== relationship.out ||
        firstValue(actual, "in") !== relationship.in
      ) {
        throw new SemanticFailure(
          "RELATIONSHIP_CONFLICT",
          `Existing relationship ${relationship.id} has conflicting endpoints.`,
          false,
        );
      }
    }
    logTransition(requestId, plan.operationId, "continue");
    await backend.applyRecovery(plan, state, requestId);
    return await finishPlan(plan, requestId, completeStatus);
  };

  return {
    async getGraphState(input, requestId) {
      try {
        return (await backend.readGraphState(input, requestId)).publicState;
      } catch (error) {
        const failure =
          error instanceof SemanticFailure
            ? error
            : new SemanticFailure(
                "NEPTUNE_UNAVAILABLE",
                "The graph control state could not be read.",
                false,
              );
        return semanticError(failure);
      }
    },

    async commitSemanticDelta(input, requestId) {
      try {
        logTransition(requestId, input.operation_id, "receive");
        const payload = canonicalPayload(input);
        const existing = await backend.readReceipt(
          input.operation_id,
          requestId,
        );
        if (existing) {
          if (existing.payloadHash !== payload.hash) {
            throw new SemanticFailure(
              "OPERATION_ID_PAYLOAD_CONFLICT",
              "This operation id is already bound to a different canonical payload.",
              false,
              { operation_id: input.operation_id },
            );
          }
          return await reconcileReceipt(
            existing,
            requestId,
            true,
            input.authority_epoch,
            existing.status === "complete"
              ? "already_complete"
              : "recovered_complete",
          );
        }
        const state = await backend.readGraphState(
          { include_allocators: true, include_v1_state: false },
          requestId,
        );
        ensureAuthorityAndRevision(input, state);
        logTransition(requestId, input.operation_id, "plan");
        const plan = await buildPlan(input, state, backend, requestId, now);
        assertCanonicalPlan(plan);
        logger.info({
          component: "mcp",
          event: "semantic_operation_plan_ready",
          request_id: requestId,
          operation_id: plan.operationId,
          tool_name: "commit_semantic_delta",
          authority_epoch: plan.authorityEpoch,
          expected_revision: input.expected.semantic_revision,
          observed_revision: state.publicState.semantic_revision,
          canonical_payload_hash: plan.canonicalPayloadHash,
          allocated_ids: canonicalize(plan.allocatedIds),
        });
        const existingTargets = await backend.readVertices(
          plan.creates.map((create) => create.id),
          requestId,
        );
        if (existingTargets.size > 0) {
          throw new SemanticFailure(
            "TARGET_ALREADY_EXISTS_CONFLICT",
            "At least one requested create id already exists.",
            false,
            { ids: [...existingTargets.keys()] },
          );
        }
        const existingEdges = await backend.readEdges(
          plan.relationships.map((relationship) => relationship.id),
          requestId,
        );
        if (existingEdges.size > 0) {
          throw new SemanticFailure(
            "RELATIONSHIP_CONFLICT",
            "At least one requested relationship id already exists.",
            false,
            { ids: [...existingEdges.keys()] },
          );
        }
        logTransition(requestId, input.operation_id, "apply");
        try {
          await backend.applyNewOperation(plan, requestId);
        } catch (error) {
          const receipt = await backend.readReceipt(
            input.operation_id,
            requestId,
          );
          if (receipt?.payloadHash === plan.canonicalPayloadHash) {
            return await reconcileReceipt(
              receipt,
              requestId,
              true,
              input.authority_epoch,
            );
          }
          const latest = await backend.readGraphState(
            { include_allocators: true, include_v1_state: false },
            requestId,
          );
          ensureAuthorityAndRevision(input, latest);
          const changedAllocators = Object.entries(plan.allocatorBefore)
            .filter(([field, value]) => latest.allocatorValues[field] !== value)
            .map(([field]) => field);
          if (changedAllocators.length > 0) {
            throw new SemanticFailure(
              "ID_ALLOCATION_CONFLICT",
              "Allocator state changed before the guarded operation could begin.",
              true,
              { allocators: changedAllocators },
            );
          }
          const collidedTargets = await backend.readVertices(
            plan.creates.map((create) => create.id),
            requestId,
          );
          if (collidedTargets.size > 0) {
            throw new SemanticFailure(
              "TARGET_ALREADY_EXISTS_CONFLICT",
              "A requested create id appeared before the guarded transaction could begin.",
              false,
              { ids: [...collidedTargets.keys()] },
            );
          }
          const collidedRelationships = await backend.readEdges(
            plan.relationships.map((relationship) => relationship.id),
            requestId,
          );
          if (collidedRelationships.size > 0) {
            throw new SemanticFailure(
              "RELATIONSHIP_CONFLICT",
              "A requested relationship id appeared before the guarded transaction could begin.",
              false,
              { ids: [...collidedRelationships.keys()] },
            );
          }
          const updateTargets = await backend.readVertices(
            plan.updates.map((update) => update.id),
            requestId,
          );
          for (const update of plan.updates) {
            const actual = updateTargets.get(update.id);
            if (
              !actual ||
              Object.entries(update.expected).some(
                ([key, expected]) => !propertyMatches(actual, key, expected),
              )
            ) {
              throw new SemanticFailure(
                "REVISION_CONFLICT",
                `Update target ${update.id} changed before the guarded transaction could begin.`,
                true,
                { id: update.id },
              );
            }
          }
          if (error instanceof BackendFailure && error.mutationMayHaveStarted) {
            throw new SemanticFailure(
              "RECOVERY_NEEDED",
              "The commit acknowledgement was lost; reconcile the operation id before retrying.",
              false,
              { operation_id: input.operation_id },
            );
          }
          throw error;
        }
        return await finishPlan(plan, requestId, "complete");
      } catch (error) {
        const failure =
          error instanceof SemanticFailure
            ? error
            : error instanceof BackendFailure
              ? new SemanticFailure(
                  error.executorCode === "NEPTUNE_UNAVAILABLE"
                    ? "NEPTUNE_UNAVAILABLE"
                    : "INTERNAL_ERROR",
                  "The semantic operation could not be completed.",
                  false,
                )
              : new SemanticFailure(
                  "INTERNAL_ERROR",
                  "The semantic operation could not be completed.",
                  false,
                );
        return semanticError(failure);
      }
    },

    async reconcileOperation(input, requestId) {
      try {
        logTransition(requestId, input.operation_id, "reconcile");
        const receipt = await backend.readReceipt(
          input.operation_id,
          requestId,
        );
        if (!receipt) {
          throw new SemanticFailure(
            "VALIDATION_ERROR",
            "No durable receipt exists for this operation id.",
            false,
            { operation_id: input.operation_id },
          );
        }
        return await reconcileReceipt(
          receipt,
          requestId,
          input.allow_continue,
          input.authority_epoch,
        );
      } catch (error) {
        const failure =
          error instanceof SemanticFailure
            ? error
            : error instanceof BackendFailure
              ? new SemanticFailure(
                  error.executorCode === "NEPTUNE_UNAVAILABLE"
                    ? "NEPTUNE_UNAVAILABLE"
                    : "RECOVERY_NEEDED",
                  error.mutationMayHaveStarted
                    ? "The reconciliation acknowledgement was lost; inspect the same operation id again."
                    : "The operation could not be reconciled because Neptune is unavailable.",
                  false,
                  { operation_id: input.operation_id },
                )
              : new SemanticFailure(
                  "INTERNAL_ERROR",
                  "The operation could not be reconciled.",
                  false,
                );
        return semanticError(failure);
      }
    },
  };
}

function gremlinLiteral(value: JsonScalar): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (!Number.isFinite(value)) {
    throw new SemanticFailure(
      "VALIDATION_ERROR",
      "Non-finite numbers cannot be persisted in Neptune.",
      false,
    );
  }
  return String(value);
}

function propertySteps(properties: PropertyMap): string {
  let result = "";
  for (const [key, value] of Object.entries(properties)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        result += `.property(set,${JSON.stringify(key)},${gremlinLiteral(item)})`;
      }
    } else {
      result += `.property(single,${JSON.stringify(key)},${gremlinLiteral(value)})`;
    }
  }
  return result;
}

function guardExists(id: string, suffix = ""): string {
  return `g.V(${JSON.stringify(id)})${suffix}.fold().coalesce(unfold(),fail('typed semantic guard failed')).iterate()`;
}

function guardAbsent(id: string, edge = false): string {
  const start = edge ? "g.E" : "g.V";
  return `${start}(${JSON.stringify(id)}).fold().choose(count(local).is(0),constant(true),fail('typed semantic target already exists')).iterate()`;
}

function expectedGuard(update: PlannedUpdate): string {
  let suffix = "";
  for (const [key, expected] of Object.entries(update.expected)) {
    if (!expected.present) {
      suffix += `.hasNot(${JSON.stringify(key)})`;
      continue;
    }
    const values = Array.isArray(expected.value)
      ? expected.value
      : [expected.value];
    for (const value of values) {
      suffix += `.has(${JSON.stringify(key)},${gremlinLiteral(value)})`;
    }
    suffix += `.filter(values(${JSON.stringify(key)}).count().is(${String(values.length)}))`;
  }
  return guardExists(update.id, suffix);
}

function receiptProperties(plan: SemanticOperationPlan): PropertyMap {
  return {
    operation_id: plan.operationId,
    operation_kind: "typed_semantic_delta",
    canonical_payload_hash: plan.canonicalPayloadHash,
    canonical_payload_json: plan.canonicalPayloadJson,
    operation_plan_json: canonicalize(plan),
    authority_epoch: plan.authorityEpoch,
    expected_semantic_revision: plan.revisions.before.semantic,
    proposed_semantic_revision: plan.revisions.after.semantic,
    expected_graph_revision: plan.revisions.before.graph,
    proposed_graph_revision: plan.revisions.after.graph,
    expected_projection_revision: plan.revisions.before.projection,
    proposed_projection_revision: plan.revisions.after.projection,
    semantic_revision: plan.revisions.after.semantic,
    graph_revision: plan.revisions.after.graph,
    projection_revision: plan.revisions.after.projection,
    origin_identity: plan.origin.identity,
    origin_actor: plan.origin.actor,
    origin_context: plan.origin.context,
    status: "writing",
    allocated_ids_json: canonicalize(plan.allocatedIds),
    created_ids_json: canonicalize(plan.creates.map((value) => value.id)),
    updated_ids_json: canonicalize(plan.updates.map((value) => value.id)),
    relationship_ids_json: canonicalize(
      plan.relationships.map((value) => value.id),
    ),
    major_version: 0,
    origin_store: "neptune",
    writer_id: "typed-semantic-mcp",
    created_at: plan.createdAt,
    updated_at: plan.createdAt,
  };
}

function createVertexStatement(vertex: PlannedVertex): string {
  return `g.addV(${JSON.stringify(vertex.graphLabel)}).property(id,${JSON.stringify(vertex.id)})${propertySteps(vertex.properties)}.iterate()`;
}

function createRelationshipStatement(
  relationship: PlannedRelationship,
): string {
  return `g.V(${JSON.stringify(relationship.out)}).addE(${JSON.stringify(relationship.label)}).to(__.V(${JSON.stringify(relationship.in)})).property(id,${JSON.stringify(relationship.id)})${propertySteps(relationship.properties)}.iterate()`;
}

function updateStatement(update: PlannedUpdate): string {
  return `g.V(${JSON.stringify(update.id)})${propertySteps(update.set)}.iterate()`;
}

function controlUpdateStatements(plan: SemanticOperationPlan): string[] {
  const syncProperties: PropertyMap = {
    last_semantic_revision: plan.revisions.after.semantic,
    last_graph_revision: plan.revisions.after.graph,
    last_projection_revision: plan.revisions.after.projection,
    last_operation_id: plan.operationId,
    origin_identity: plan.origin.identity,
    origin_actor: plan.origin.actor,
    origin_context: plan.origin.context,
  };
  const allocatorChanges: PropertyMap = {
    last_operation_id: plan.operationId,
    origin_identity: plan.origin.identity,
    origin_actor: plan.origin.actor,
    origin_context: plan.origin.context,
  };
  for (const [field, value] of Object.entries(plan.allocatorAfter)) {
    if (plan.allocatorBefore[field] !== value) allocatorChanges[field] = value;
  }
  return [
    `g.V('sol:sync_state')${propertySteps(syncProperties)}.iterate()`,
    `g.V('sol:allocators')${propertySteps(allocatorChanges)}.iterate()`,
  ];
}

function newOperationQuery(plan: SemanticOperationPlan): string {
  const createIds = new Set(plan.creates.map((create) => create.id));
  const guards = [
    guardExists(
      "sol:authority",
      `.has('primary_store','neptune').has('status','active').has('authority_epoch',${JSON.stringify(plan.authorityEpoch)})`,
    ),
    guardExists(
      "sol:sync_state",
      `.has('authority_epoch',${JSON.stringify(plan.authorityEpoch)}).has('last_semantic_revision',${String(plan.revisions.before.semantic)}).has('last_graph_revision',${String(plan.revisions.before.graph)}).has('last_projection_revision',${String(plan.revisions.before.projection)})`,
    ),
    guardExists(
      "sol:allocators",
      `.has('authority_epoch',${JSON.stringify(plan.authorityEpoch)})${Object.entries(
        plan.allocatorBefore,
      )
        .map(
          ([field, value]) =>
            `.has(${JSON.stringify(field)},${JSON.stringify(value)})`,
        )
        .join("")}`,
    ),
    guardAbsent(plan.receiptId),
    ...plan.creates.map((create) => guardAbsent(create.id)),
    ...plan.updates.map(expectedGuard),
    ...plan.relationships.flatMap((relationship) => [
      ...(createIds.has(relationship.out)
        ? []
        : [guardExists(relationship.out)]),
      ...(createIds.has(relationship.in) ? [] : [guardExists(relationship.in)]),
      guardAbsent(relationship.id, true),
    ]),
  ];
  const receipt: PlannedVertex = {
    id: plan.receiptId,
    graphLabel: "GraphOperation",
    properties: receiptProperties(plan),
  };
  return [
    ...guards,
    createVertexStatement(receipt),
    ...plan.creates.map(createVertexStatement),
    ...plan.updates.map(updateStatement),
    ...plan.relationships.map(createRelationshipStatement),
    ...controlUpdateStatements(plan),
    `g.V(${JSON.stringify(plan.receiptId)}).elementMap()`,
  ].join(";");
}

function recoveryQuery(
  plan: SemanticOperationPlan,
  state: GraphSnapshot,
): string {
  const createIds = new Set(plan.creates.map((create) => create.id));
  const guards = [
    guardExists(
      "sol:authority",
      `.has('primary_store','neptune').has('status','active').has('authority_epoch',${JSON.stringify(plan.authorityEpoch)})`,
    ),
    guardExists(
      plan.receiptId,
      `.has('canonical_payload_hash',${JSON.stringify(plan.canonicalPayloadHash)})`,
    ),
    guardExists(
      "sol:sync_state",
      `.has('last_semantic_revision',${String(state.publicState.semantic_revision)}).has('last_graph_revision',${String(state.publicState.graph_revision)}).has('last_projection_revision',${String(state.publicState.projection_revision)})`,
    ),
    guardExists(
      "sol:allocators",
      Object.entries(state.allocatorValues)
        .map(
          ([field, value]) =>
            `.has(${JSON.stringify(field)},${JSON.stringify(value)})`,
        )
        .join(""),
    ),
    ...plan.updates.map((update) => guardExists(update.id)),
    ...plan.relationships.flatMap((relationship) => [
      ...(createIds.has(relationship.out)
        ? []
        : [guardExists(relationship.out)]),
      ...(createIds.has(relationship.in) ? [] : [guardExists(relationship.in)]),
    ]),
  ];
  const creates = plan.creates.map(
    (create) =>
      `g.V(${JSON.stringify(create.id)}).fold().coalesce(unfold(),addV(${JSON.stringify(create.graphLabel)}).property(id,${JSON.stringify(create.id)})${propertySteps(create.properties)}).iterate()`,
  );
  const relationships = plan.relationships.map(
    (relationship) =>
      `g.V(${JSON.stringify(relationship.out)}).coalesce(outE(${JSON.stringify(relationship.label)}).hasId(${JSON.stringify(relationship.id)}),addE(${JSON.stringify(relationship.label)}).to(__.V(${JSON.stringify(relationship.in)})).property(id,${JSON.stringify(relationship.id)})${propertySteps(relationship.properties)}).iterate()`,
  );
  const control: string[] = [];
  if (state.publicState.semantic_revision < plan.revisions.after.semantic) {
    control.push(
      `g.V('sol:sync_state').property(single,'last_semantic_revision',${String(plan.revisions.after.semantic)}).iterate()`,
    );
  }
  if (state.publicState.graph_revision < plan.revisions.after.graph) {
    control.push(
      `g.V('sol:sync_state').property(single,'last_graph_revision',${String(plan.revisions.after.graph)}).iterate()`,
    );
  }
  if (state.publicState.projection_revision < plan.revisions.after.projection) {
    control.push(
      `g.V('sol:sync_state').property(single,'last_projection_revision',${String(plan.revisions.after.projection)}).iterate()`,
    );
  }
  for (const [field, desired] of Object.entries(plan.allocatorAfter)) {
    const current = state.allocatorValues[field];
    if (!current) continue;
    const prefix = desired.slice(0, 1);
    if (
      parseAllocatedId(current, prefix).numeric <
      parseAllocatedId(desired, prefix).numeric
    ) {
      control.push(
        `g.V('sol:allocators').property(single,${JSON.stringify(field)},${JSON.stringify(desired)}).iterate()`,
      );
    }
  }
  return [
    ...guards,
    ...creates,
    ...plan.updates.map(updateStatement),
    ...relationships,
    ...control,
    `g.V(${JSON.stringify(plan.receiptId)}).elementMap()`,
  ].join(";");
}

function dataFromExecutionResult(result: unknown): unknown[] {
  const record = asRecord(result);
  if (record && Array.isArray(record.data)) return record.data;
  return Array.isArray(result) ? result : result === undefined ? [] : [result];
}

export function createGremlinSemanticBackend(
  invokeExecutor: ExecutorInvoker,
): SemanticOperationBackend {
  const execute = async (
    query: string,
    requestId: string,
    mutation: boolean,
  ): Promise<unknown[]> => {
    if (Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) {
      throw new SemanticFailure(
        "VALIDATION_ERROR",
        "The deterministic semantic operation exceeds the 262,144-byte Neptune query limit.",
        false,
        { query_bytes: Buffer.byteLength(query, "utf8") },
      );
    }
    let response;
    try {
      response = await invokeExecutor(query, requestId);
    } catch (error) {
      if (error instanceof ExecutorInvocationError) {
        throw new BackendFailure(
          error.definitelyNotInvoked
            ? "NEPTUNE_UNAVAILABLE"
            : "UNKNOWN_MUTATION_OUTCOME",
          mutation && !error.definitelyNotInvoked,
        );
      }
      throw new BackendFailure("NEPTUNE_UNAVAILABLE", mutation);
    }
    if (!response.ok) {
      throw new BackendFailure(
        response.error.code,
        mutation && response.error.code === "UNKNOWN_MUTATION_OUTCOME",
      );
    }
    return dataFromExecutionResult(response.result);
  };

  const recordsById = (data: unknown[]): Map<string, UnknownRecord> => {
    const result = new Map<string, UnknownRecord>();
    for (const item of data) {
      const record = asRecord(item);
      const id = record ? firstValue(record, "id") : undefined;
      if (record && typeof id === "string") result.set(id, record);
    }
    return result;
  };

  return {
    async readGraphState(input, requestId) {
      const data = await execute(
        "g.V('sol:authority','sol:sync_state','sol:allocators','sol:v1:graph','sol:v1:population').valueMap(true)",
        requestId,
        false,
      );
      const records = recordsById(data);
      const authority = records.get("sol:authority");
      const sync = records.get("sol:sync_state");
      const allocators = records.get("sol:allocators");
      if (!authority || !sync || !allocators) {
        throw new SemanticFailure(
          "INTERNAL_ERROR",
          "The canonical graph control objects are incomplete.",
          false,
        );
      }
      const primaryStore = requiredString(
        authority,
        "primary_store",
        "authority object",
      );
      if (primaryStore !== "neptune") {
        throw new SemanticFailure(
          "WRITER_SCOPE_DENIED",
          "The canonical authority object does not name Neptune as primary store.",
          false,
          { actual: primaryStore },
        );
      }
      const allocatorValues: Record<string, string> = {};
      for (const field of ALLOCATOR_FIELDS) {
        const value = stringValue(allocators, field);
        if (value) allocatorValues[field] = value;
      }
      const controlRevision = numberValue(sync, "last_control_revision");
      const publicState: GraphState = {
        primary_store: "neptune",
        authority_epoch: requiredString(
          authority,
          "authority_epoch",
          "authority object",
        ),
        authority_status: requiredString(
          authority,
          "status",
          "authority object",
        ),
        semantic_revision: requiredNumber(
          sync,
          "last_semantic_revision",
          "sync state",
        ),
        graph_revision: requiredNumber(
          sync,
          "last_graph_revision",
          "sync state",
        ),
        projection_revision: requiredNumber(
          sync,
          "last_projection_revision",
          "sync state",
        ),
        ...(controlRevision === undefined
          ? {}
          : { control_revision: controlRevision }),
        major_version: requiredNumber(
          authority,
          "major_version",
          "authority object",
        ),
        ...(input.include_allocators ? { allocators: allocatorValues } : {}),
      };
      if (input.include_v1_state) {
        const graph = records.get("sol:v1:graph") ?? {};
        const population = records.get("sol:v1:population") ?? {};
        const activationState = stringValue(graph, "activation_state");
        const semanticAuthority = booleanValue(graph, "semantic_authority");
        const foregroundReadEnabled = booleanValue(
          graph,
          "foreground_read_enabled",
        );
        const populationState = stringValue(population, "population_state");
        const copied =
          numberValue(population, "catchup_through_semantic_revision") ??
          numberValue(population, "verified_boundary_semantic_revision") ??
          numberValue(population, "last_verified_copy_revision");
        publicState.v1 = {
          ...(activationState === undefined
            ? {}
            : { activation_state: activationState }),
          ...(semanticAuthority === undefined
            ? {}
            : { semantic_authority: semanticAuthority }),
          ...(foregroundReadEnabled === undefined
            ? {}
            : { foreground_read_enabled: foregroundReadEnabled }),
          ...(copied === undefined ? {} : { copied_through_revision: copied }),
          ...(populationState === undefined
            ? {}
            : { population_state: populationState }),
        };
      }
      return { publicState, allocatorValues };
    },

    async readReceipt(operationId, requestId) {
      const data = await execute(
        `g.V(${JSON.stringify(receiptId(operationId))}).limit(1).valueMap(true)`,
        requestId,
        false,
      );
      const record = asRecord(data[0]);
      if (!record) return undefined;
      const payloadHash = stringValue(record, "canonical_payload_hash");
      const payloadJson = stringValue(record, "canonical_payload_json");
      const planJson = stringValue(record, "operation_plan_json");
      const authorityEpoch = stringValue(record, "authority_epoch");
      const status = stringValue(record, "status");
      return {
        operationId,
        ...(payloadHash === undefined ? {} : { payloadHash }),
        ...(payloadJson === undefined ? {} : { payloadJson }),
        ...(planJson === undefined ? {} : { planJson }),
        ...(authorityEpoch === undefined ? {} : { authorityEpoch }),
        ...(status === undefined ? {} : { status }),
      };
    },

    async readVertices(ids, requestId) {
      if (ids.length === 0) return new Map();
      const data = await execute(
        `g.V(${ids.map((id) => JSON.stringify(id)).join(",")}).project('id','graph_label','properties').by(id()).by(label()).by(valueMap())`,
        requestId,
        false,
      );
      const result = new Map<string, UnknownRecord>();
      for (const item of data) {
        const projected = asRecord(item);
        const id = projected ? firstValue(projected, "id") : undefined;
        const graphLabel = projected
          ? firstValue(projected, "graph_label")
          : undefined;
        const properties = projected
          ? asRecord(projected.properties)
          : undefined;
        if (typeof id === "string" && typeof graphLabel === "string") {
          result.set(id, {
            id,
            [INTERNAL_GRAPH_LABEL_KEY]: graphLabel,
            ...(properties ?? {}),
          });
        }
      }
      return result;
    },

    async readEdges(ids, requestId) {
      if (ids.length === 0) return new Map();
      const data = await execute(
        `g.E(${ids.map((id) => JSON.stringify(id)).join(",")}).project('id','label','out','in','properties').by(id()).by(label()).by(outV().id()).by(inV().id()).by(valueMap())`,
        requestId,
        false,
      );
      return recordsById(data);
    },

    async applyNewOperation(plan, requestId) {
      await execute(newOperationQuery(plan), requestId, true);
    },

    async applyRecovery(plan, state, requestId) {
      await execute(recoveryQuery(plan, state), requestId, true);
    },

    async markReceipt(plan, status, verification, requestId) {
      const properties: PropertyMap = {
        status,
        verification_json: canonicalize({
          expected_vertices: verification.expectedVertices,
          actual_vertices: verification.actualVertices,
          expected_edges: verification.expectedEdges,
          actual_edges: verification.actualEdges,
          mismatch_count: verification.mismatches.length,
          verified: verification.verified,
          mismatches: verification.mismatches,
        }),
        verification_expected_vertices: verification.expectedVertices,
        verification_actual_vertices: verification.actualVertices,
        verification_expected_edges: verification.expectedEdges,
        verification_actual_edges: verification.actualEdges,
        verification_mismatch_count: verification.mismatches.length,
        verification_verified: verification.verified,
        updated_at: new Date().toISOString(),
      };
      const query = `${guardExists(plan.receiptId, `.has('canonical_payload_hash',${JSON.stringify(plan.canonicalPayloadHash)})`)};g.V(${JSON.stringify(plan.receiptId)})${propertySteps(properties)}.elementMap()`;
      await execute(query, requestId, true);
    },
  };
}

export function parseCommitSemanticDeltaInput(
  value: unknown,
): CommitSemanticDeltaInput {
  const parsed = commitSemanticDeltaInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new SemanticFailure(
      "VALIDATION_ERROR",
      "The semantic delta input is invalid.",
      false,
      {
        issues: parsed.error.issues.slice(0, 20).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    );
  }
  return parsed.data;
}
