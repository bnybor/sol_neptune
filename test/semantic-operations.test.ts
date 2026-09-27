import {
  commitSemanticDeltaInputSchema,
  type CommitSemanticDeltaInput,
  type GraphState,
  type SemanticPropertyValue,
} from "../src/mcp/semantic-contracts.js";
import {
  createGremlinSemanticBackend,
  createSemanticOperations,
  type SemanticOperationBackend,
  type SemanticOperationPlan,
} from "../src/mcp/semantic-operations.js";
import type { ExecutorInvoker } from "../src/mcp/executor-invoker.js";
import type { ExecutionResponse } from "../src/shared/contracts.js";

type RecordValue = Record<string, unknown>;

function asStoredProperties(
  properties: Record<string, SemanticPropertyValue>,
): RecordValue {
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : [value],
    ]),
  );
}

class FakeSemanticBackend implements SemanticOperationBackend {
  public state: GraphState = {
    primary_store: "neptune",
    authority_epoch: "epoch-1",
    authority_status: "active",
    semantic_revision: 10,
    graph_revision: 10,
    projection_revision: 10,
    control_revision: 4,
    major_version: 0,
  };

  public allocators: Record<string, string> = {
    next_primary_source_id: "S1000097",
    next_primary_claim_id: "K1000242",
    next_primary_concept_id: "T1000029",
    next_primary_node_id: "N1000007",
    next_primary_hole_id: "H1000000",
  };

  public readonly vertices = new Map<string, RecordValue>();
  public readonly edges = new Map<string, RecordValue>();
  public readonly receipts = new Map<
    string,
    { plan: SemanticOperationPlan; status: string }
  >();
  public applyCount = 0;
  public recoveryCount = 0;
  public mode:
    | "normal"
    | "lost_ack"
    | "partial"
    | "revision_race"
    | "authority_race"
    | "wrong_edge"
    | "completion_lost_ack" = "normal";

  public readGraphState(input: {
    include_allocators: boolean;
    include_v1_state: boolean;
  }) {
    return Promise.resolve({
      publicState: {
        ...this.state,
        ...(input.include_allocators
          ? { allocators: { ...this.allocators } }
          : {}),
      },
      allocatorValues: { ...this.allocators },
    });
  }

  public readReceipt(operationId: string) {
    const stored = this.receipts.get(operationId);
    if (!stored) return Promise.resolve(undefined);
    return Promise.resolve({
      operationId,
      payloadHash: stored.plan.canonicalPayloadHash,
      payloadJson: stored.plan.canonicalPayloadJson,
      planJson: JSON.stringify(stored.plan),
      authorityEpoch: stored.plan.authorityEpoch,
      status: stored.status,
    });
  }

  public readVertices(ids: string[]) {
    return Promise.resolve(
      new Map(
        ids.flatMap((id) => {
          const value = this.vertices.get(id);
          return value ? [[id, structuredClone(value)] as const] : [];
        }),
      ),
    );
  }

  public readEdges(ids: string[]) {
    return Promise.resolve(
      new Map(
        ids.flatMap((id) => {
          const value = this.edges.get(id);
          return value ? [[id, structuredClone(value)] as const] : [];
        }),
      ),
    );
  }

  private storeReceipt(plan: SemanticOperationPlan): void {
    this.receipts.set(plan.operationId, { plan, status: "writing" });
    this.vertices.set(plan.receiptId, {
      id: plan.receiptId,
      label: "GraphOperation",
      canonical_payload_hash: [plan.canonicalPayloadHash],
      status: ["writing"],
    });
  }

  private storeVertex(vertex: SemanticOperationPlan["creates"][number]): void {
    this.vertices.set(vertex.id, {
      id: vertex.id,
      label: vertex.graphLabel,
      ...asStoredProperties(vertex.properties),
    });
  }

  private storeEdge(
    relationship: SemanticOperationPlan["relationships"][number],
  ): void {
    this.edges.set(relationship.id, {
      id: relationship.id,
      label: relationship.label,
      out: relationship.out,
      in: relationship.in,
      properties: asStoredProperties(relationship.properties),
    });
  }

  private applyControl(plan: SemanticOperationPlan): void {
    this.state = {
      ...this.state,
      semantic_revision: Math.max(
        this.state.semantic_revision,
        plan.revisions.after.semantic,
      ),
      graph_revision: Math.max(
        this.state.graph_revision,
        plan.revisions.after.graph,
      ),
      projection_revision: Math.max(
        this.state.projection_revision,
        plan.revisions.after.projection,
      ),
    };
    for (const [field, desired] of Object.entries(plan.allocatorAfter)) {
      const current = this.allocators[field];
      if (!current || BigInt(current.slice(1)) < BigInt(desired.slice(1))) {
        this.allocators[field] = desired;
      }
    }
  }

  private applyAll(plan: SemanticOperationPlan): void {
    this.storeReceipt(plan);
    for (const vertex of plan.creates) this.storeVertex(vertex);
    for (const update of plan.updates) {
      const current = this.vertices.get(update.id);
      if (current) Object.assign(current, asStoredProperties(update.set));
    }
    for (const relationship of plan.relationships) this.storeEdge(relationship);
    this.applyControl(plan);
  }

  public applyNewOperation(plan: SemanticOperationPlan): Promise<void> {
    this.applyCount += 1;
    if (this.mode === "revision_race") {
      this.state = {
        ...this.state,
        semantic_revision: this.state.semantic_revision + 1,
      };
      throw new Error("revision race");
    }
    if (this.mode === "authority_race") {
      this.state = { ...this.state, authority_epoch: "epoch-2" };
      throw new Error("authority race");
    }
    if (this.mode === "partial") {
      this.storeReceipt(plan);
      if (plan.creates[0]) this.storeVertex(plan.creates[0]);
      this.applyControl(plan);
      return Promise.resolve();
    }
    this.applyAll(plan);
    if (this.mode === "wrong_edge" && plan.relationships[0]) {
      const edge = this.edges.get(plan.relationships[0].id);
      if (edge) edge.in = "N-conflict";
    }
    if (this.mode === "lost_ack") {
      return Promise.reject(new Error("lost acknowledgement"));
    }
    return Promise.resolve();
  }

  public applyRecovery(plan: SemanticOperationPlan): Promise<void> {
    this.recoveryCount += 1;
    for (const vertex of plan.creates) {
      if (!this.vertices.has(vertex.id)) this.storeVertex(vertex);
    }
    for (const update of plan.updates) {
      const current = this.vertices.get(update.id);
      if (current) Object.assign(current, asStoredProperties(update.set));
    }
    for (const relationship of plan.relationships) {
      if (!this.edges.has(relationship.id)) this.storeEdge(relationship);
    }
    this.applyControl(plan);
    return Promise.resolve();
  }

  public markReceipt(
    plan: SemanticOperationPlan,
    status: "complete" | "recovery_needed",
  ): Promise<void> {
    const stored = this.receipts.get(plan.operationId);
    if (stored) stored.status = status;
    const vertex = this.vertices.get(plan.receiptId);
    if (vertex) vertex.status = [status];
    if (this.mode === "completion_lost_ack" && status === "complete") {
      return Promise.reject(new Error("completion acknowledgement lost"));
    }
    return Promise.resolve();
  }
}

function semanticInput(
  overrides: Partial<CommitSemanticDeltaInput> = {},
): CommitSemanticDeltaInput {
  return commitSemanticDeltaInputSchema.parse({
    operation_id: "typed-test-operation",
    authority_epoch: "epoch-1",
    expected: {
      semantic_revision: 10,
      graph_revision: 10,
      projection_revision: 10,
    },
    origin: {
      identity: "sol",
      actor: "N1002",
      context: "test:typed-semantic-operation",
    },
    creates: [
      {
        ref: "$source1",
        object_type: "SOURCE_EVIDENCE",
        label: "Typed semantic test source",
        canonical: "A bounded source record.",
        epistemic_class: "source",
        sensitivity: "ordinary",
      },
      {
        ref: "$claim1",
        object_type: "CLAIM",
        label: "typed_semantic_test_claim",
        canonical: "A bounded claim record.",
        epistemic_class: "observation",
        sensitivity: "ordinary",
        source_refs: ["$source1"],
      },
    ],
    ...overrides,
  });
}

describe("typed semantic operation state machine", () => {
  it("commits a source and claim with durable allocation and exact verification", async () => {
    const backend = new FakeSemanticBackend();
    const operations = createSemanticOperations(backend, {
      now: () => new Date("2026-09-27T12:00:00Z"),
    });

    const result = await operations.commitSemanticDelta(
      semanticInput(),
      "request-1",
    );

    expect(result).toMatchObject({
      ok: true,
      status: "complete",
      allocated_ids: {
        $source1: "S1000097",
        $claim1: "K1000242",
      },
      revisions: {
        before: { semantic: 10, graph: 10, projection: 10 },
        after: { semantic: 11, graph: 11, projection: 11 },
      },
      verification: { verified: true, mismatch_count: 0 },
    });
    expect(backend.vertices.has("S1000097")).toBe(true);
    expect(backend.vertices.has("K1000242")).toBe(true);
    expect(backend.edges.has("port:K1000242:source:S1000097")).toBe(true);
    expect(backend.allocators.next_primary_source_id).toBe("S1000098");
    expect(backend.allocators.next_primary_claim_id).toBe("K1000243");
    expect(backend.receipts.get("typed-test-operation")?.status).toBe(
      "complete",
    );
  });

  it("returns already_complete without creating anything on an identical retry", async () => {
    const backend = new FakeSemanticBackend();
    const operations = createSemanticOperations(backend);
    const input = semanticInput();

    expect((await operations.commitSemanticDelta(input, "request-1")).ok).toBe(
      true,
    );
    const retried = await operations.commitSemanticDelta(input, "request-2");

    expect(retried).toMatchObject({ ok: true, status: "already_complete" });
    expect(backend.applyCount).toBe(1);
    expect(backend.vertices.size).toBe(3);
    expect(backend.edges.size).toBe(1);
  });

  it("recovers a lost acknowledgement without duplicate records", async () => {
    const backend = new FakeSemanticBackend();
    backend.mode = "lost_ack";
    const operations = createSemanticOperations(backend);

    const result = await operations.commitSemanticDelta(
      semanticInput(),
      "request-lost",
    );

    expect(result).toMatchObject({ ok: true, status: "recovered_complete" });
    expect(backend.vertices.size).toBe(3);
    expect(backend.edges.size).toBe(1);
    expect(backend.applyCount).toBe(1);
  });

  it("confirms a completed receipt after its acknowledgement is lost", async () => {
    const backend = new FakeSemanticBackend();
    backend.mode = "completion_lost_ack";
    const operations = createSemanticOperations(backend);

    const result = await operations.commitSemanticDelta(
      semanticInput(),
      "request-completion-lost",
    );

    expect(result).toMatchObject({ ok: true, status: "complete" });
    expect(backend.receipts.get("typed-test-operation")?.status).toBe(
      "complete",
    );
    expect(backend.vertices.size).toBe(3);
    expect(backend.edges.size).toBe(1);
  });

  it("continues only missing deterministic work after a partial write", async () => {
    const backend = new FakeSemanticBackend();
    backend.mode = "partial";
    const operations = createSemanticOperations(backend);

    const first = await operations.commitSemanticDelta(
      semanticInput(),
      "request-partial",
    );
    expect(first).toMatchObject({
      ok: false,
      error: { code: "RECOVERY_NEEDED" },
    });
    expect(backend.receipts.get("typed-test-operation")?.status).toBe(
      "recovery_needed",
    );

    const recovered = await operations.reconcileOperation(
      { operation_id: "typed-test-operation", allow_continue: true },
      "request-reconcile",
    );
    expect(recovered).toMatchObject({
      ok: true,
      status: "recovered_complete",
      allocated_ids: {
        $source1: "S1000097",
        $claim1: "K1000242",
      },
    });
    expect(backend.recoveryCount).toBe(1);
    expect(backend.vertices.size).toBe(3);
    expect(backend.edges.size).toBe(1);
  });

  it("rejects a revision race before creating semantic records", async () => {
    const backend = new FakeSemanticBackend();
    backend.mode = "revision_race";
    const operations = createSemanticOperations(backend);

    const result = await operations.commitSemanticDelta(
      semanticInput(),
      "request-race",
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "REVISION_CONFLICT", retry_safe: true },
    });
    expect(backend.vertices.size).toBe(0);
    expect(backend.receipts.size).toBe(0);
  });

  it("rejects an authority race before creating semantic records", async () => {
    const backend = new FakeSemanticBackend();
    backend.mode = "authority_race";
    const operations = createSemanticOperations(backend);

    const result = await operations.commitSemanticDelta(
      semanticInput(),
      "request-authority-race",
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_EPOCH_MISMATCH", retry_safe: true },
    });
    expect(backend.vertices.size).toBe(0);
  });

  it("binds an operation id permanently to one canonical payload", async () => {
    const backend = new FakeSemanticBackend();
    const operations = createSemanticOperations(backend);
    expect(
      (await operations.commitSemanticDelta(semanticInput(), "request-1")).ok,
    ).toBe(true);
    const changed = semanticInput({
      creates: [
        {
          ref: "$source1",
          object_type: "SOURCE_EVIDENCE",
          label: "Changed source",
          canonical: "This payload is different.",
        },
      ],
    });

    const result = await operations.commitSemanticDelta(changed, "request-2");

    expect(result).toMatchObject({
      ok: false,
      error: { code: "OPERATION_ID_PAYLOAD_CONFLICT" },
    });
    expect(backend.applyCount).toBe(1);
  });

  it("reuses reserved allocation after unrelated allocators advance", async () => {
    const backend = new FakeSemanticBackend();
    backend.mode = "partial";
    const operations = createSemanticOperations(backend);
    await operations.commitSemanticDelta(semanticInput(), "request-partial");
    backend.allocators.next_primary_source_id = "S1000200";
    backend.allocators.next_primary_claim_id = "K1000300";

    const result = await operations.reconcileOperation(
      { operation_id: "typed-test-operation", allow_continue: true },
      "request-reconcile",
    );

    expect(result).toMatchObject({
      ok: true,
      allocated_ids: {
        $source1: "S1000097",
        $claim1: "K1000242",
      },
    });
    expect(backend.allocators.next_primary_source_id).toBe("S1000200");
    expect(backend.allocators.next_primary_claim_id).toBe("K1000300");
  });

  it("does not mark a conflicting relationship complete", async () => {
    const backend = new FakeSemanticBackend();
    backend.mode = "wrong_edge";
    const operations = createSemanticOperations(backend);

    const first = await operations.commitSemanticDelta(
      semanticInput(),
      "request-wrong-edge",
    );
    expect(first).toMatchObject({
      ok: false,
      error: { code: "RECOVERY_NEEDED" },
    });
    expect(backend.receipts.get("typed-test-operation")?.status).not.toBe(
      "complete",
    );

    const reconciled = await operations.reconcileOperation(
      { operation_id: "typed-test-operation", allow_continue: true },
      "request-reconcile",
    );
    expect(reconciled).toMatchObject({
      ok: false,
      error: { code: "RELATIONSHIP_CONFLICT" },
    });
  });

  it("recovers a bounded property update from its captured pre-image", async () => {
    const backend = new FakeSemanticBackend();
    backend.vertices.set("K0001", {
      id: "K0001",
      label: "existing_claim",
      object_type: ["CLAIM"],
      major_version: [0],
      canonical: ["before"],
      origin_identity: ["sol"],
      origin_actor: ["N1002"],
      origin_context: ["earlier"],
      authoritative_operation_id: ["earlier-operation"],
      authoritative_revision: [10],
      authority_epoch: ["epoch-1"],
    });
    backend.mode = "partial";
    const operations = createSemanticOperations(backend);
    const input = semanticInput({
      operation_id: "typed-property-update",
      creates: [],
      property_updates: [
        {
          id: "K0001",
          set: { canonical: "after" },
          expected: { canonical: "before" },
        },
      ],
    });

    const partial = await operations.commitSemanticDelta(
      input,
      "request-update",
    );
    expect(partial).toMatchObject({
      ok: false,
      error: { code: "RECOVERY_NEEDED" },
    });
    const recovered = await operations.reconcileOperation(
      { operation_id: "typed-property-update", allow_continue: true },
      "request-update-reconcile",
    );

    expect(recovered).toMatchObject({
      ok: true,
      status: "recovered_complete",
      updated_ids: ["K0001"],
    });
    expect(backend.vertices.get("K0001")?.canonical).toEqual(["after"]);
    expect(backend.vertices.get("K0001")?.origin_context).toEqual([
      "test:typed-semantic-operation",
    ]);
  });

  it("rejects destructive or raw-query escape fields", () => {
    const destructive = commitSemanticDeltaInputSchema.safeParse({
      ...semanticInput(),
      deletes: [{ id: "K1000242" }],
    });
    const rawEscape = commitSemanticDeltaInputSchema.safeParse({
      ...semanticInput(),
      query: "g.V().drop()",
    });

    expect(destructive.success).toBe(false);
    expect(rawEscape.success).toBe(false);
  });
});

function executionSuccess(data: unknown[]): ExecutionResponse {
  return {
    ok: true,
    result: { data },
    meta: {
      request_id: "executor-request",
      elapsed_ms: 1,
      result_bytes: 2,
      retry_safe: false,
    },
  };
}

describe("Gremlin semantic-operation backend", () => {
  it("maps the established control objects without inferring v1 authority", async () => {
    const invokeExecutor: ExecutorInvoker = vi.fn().mockResolvedValue(
      executionSuccess([
        {
          id: "sol:authority",
          label: "SolGraphAuthority::Operational",
          primary_store: ["neptune"],
          authority_epoch: ["epoch-live"],
          status: ["active"],
          major_version: [0],
        },
        {
          id: "sol:sync_state",
          last_semantic_revision: [863],
          last_graph_revision: [863],
          last_projection_revision: [863],
          last_control_revision: [770],
        },
        {
          id: "sol:allocators",
          next_primary_source_id: ["S1000097"],
          next_primary_claim_id: ["K1000242"],
          next_primary_concept_id: ["T1000029"],
          next_primary_node_id: ["N1000007"],
          next_primary_hole_id: ["H1000000"],
        },
        {
          id: "sol:v1:graph",
          activation_state: ["inactive"],
          semantic_authority: [false],
          foreground_read_enabled: [true],
        },
        {
          id: "sol:v1:population",
          population_state: ["partial"],
          catchup_through_semantic_revision: [830],
        },
      ]),
    );
    const backend = createGremlinSemanticBackend(invokeExecutor);

    const snapshot = await backend.readGraphState(
      { include_allocators: true, include_v1_state: true },
      "request-state",
    );

    expect(snapshot.publicState).toEqual({
      primary_store: "neptune",
      authority_epoch: "epoch-live",
      authority_status: "active",
      semantic_revision: 863,
      graph_revision: 863,
      projection_revision: 863,
      control_revision: 770,
      major_version: 0,
      allocators: snapshot.allocatorValues,
      v1: {
        activation_state: "inactive",
        semantic_authority: false,
        foreground_read_enabled: true,
        copied_through_revision: 830,
        population_state: "partial",
      },
    });
    expect(invokeExecutor).toHaveBeenCalledWith(
      expect.stringContaining("sol:authority"),
      "request-state",
    );
  });

  it("emits one guarded non-destructive transaction for a fresh operation", async () => {
    const invokeExecutor = vi
      .fn()
      .mockResolvedValue(executionSuccess([{ id: "operation:op-1" }]));
    const backend = createGremlinSemanticBackend(invokeExecutor);
    const plan: SemanticOperationPlan = {
      operationId: "op-1",
      receiptId: "operation:op-1",
      canonicalPayloadHash: "a".repeat(64),
      canonicalPayloadJson: "{}",
      authorityEpoch: "epoch-1",
      origin: { identity: "sol", actor: "N1002", context: "test" },
      createdAt: "2026-09-27T12:00:00.000Z",
      revisions: {
        before: { semantic: 10, graph: 10, projection: 10 },
        after: { semantic: 11, graph: 11, projection: 11 },
      },
      allocatorBefore: {
        next_primary_source_id: "S1000097",
        next_primary_claim_id: "K1000242",
      },
      allocatorAfter: {
        next_primary_source_id: "S1000098",
        next_primary_claim_id: "K1000242",
      },
      allocatedIds: { $source1: "S1000097" },
      creates: [
        {
          id: "S1000097",
          graphLabel: "Typed source",
          properties: {
            object_type: "SOURCE_EVIDENCE",
            major_version: 0,
            origin_identity: "sol",
            origin_actor: "N1002",
            origin_context: "test",
            authoritative_operation_id: "op-1",
            authoritative_revision: 11,
            authority_epoch: "epoch-1",
          },
        },
      ],
      updates: [],
      relationships: [],
    };

    await backend.applyNewOperation(plan, "request-write");

    expect(invokeExecutor).toHaveBeenCalledTimes(1);
    const query = invokeExecutor.mock.calls[0]?.[0] as string;
    expect(query).toContain("has('primary_store','neptune')");
    expect(query).toContain("has('last_semantic_revision',10)");
    expect(query).toContain("next_primary_source_id");
    expect(query).toContain("canonical_payload_hash");
    expect(query).toContain('g.addV("Typed source")');
    expect(query).toContain(";g.V('sol:sync_state')");
    expect(query).not.toContain(".drop(");
  });
});
