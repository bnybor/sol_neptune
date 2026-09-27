import {
  classifyGremlin,
  validateGremlinForTool,
} from "../src/mcp/gremlin-safety.js";

describe("Gremlin safety classification", () => {
  it.each([
    "g.V().count()",
    "g.V().limit(10).elementMap()",
    "g.E().range(0, 25).project('id','label').by(id()).by(label())",
    "g.V().hasLabel('person').has('age',gt(21)).values('name').limit(5)",
    "g.V('v1').properties('name').value()",
    "g.V().where(__.out('knows').count().is(gt(0))).limit(10)",
    "g.V().has('literal', 'drop().addV()').properties('name').value()",
    "g.V() /* addV('ignored') */ .limit(1) // .drop()\n.count()",
  ])("accepts a normal read traversal: %s", (query) => {
    expect(classifyGremlin(query)).toBe("read");
    expect(validateGremlinForTool(query, "read")).toEqual({
      ok: true,
      classification: "read",
    });
  });

  it.each([
    "g.addV('person').property(T.id,'v1').property('name','Ada')",
    "g.V('v1').property(single,'name','Ada')",
    "g.V('v1').addE('knows').to(__.V('v2')).property('since',2024)",
    "g.mergeV([(T.id):'v1',(T.label):'person']).option(Merge.onMatch,[name:'Ada'])",
    "g.mergeE([(T.id):'e1',(Merge.outV):'v1',(Merge.inV):'v2',(T.label):'knows'])",
  ])(
    "accepts an add or update traversal only in the write tool: %s",
    (query) => {
      expect(classifyGremlin(query)).toBe("write");
      expect(validateGremlinForTool(query, "write")).toEqual({
        ok: true,
        classification: "write",
      });
      expect(validateGremlinForTool(query, "read")).toMatchObject({
        ok: false,
        reason: "tool_mismatch",
        classification: "write",
      });
    },
  );

  it.each([
    "g.V('v1').drop().iterate()",
    "g.E('e1').drop().iterate()",
    "g.V('v1').properties('obsolete').drop().iterate()",
  ])("accepts a removal traversal only in the delete tool: %s", (query) => {
    expect(classifyGremlin(query)).toBe("delete");
    expect(validateGremlinForTool(query, "delete")).toEqual({
      ok: true,
      classification: "delete",
    });
    expect(validateGremlinForTool(query, "write")).toMatchObject({
      ok: false,
      reason: "tool_mismatch",
      classification: "delete",
    });
  });

  it.each([
    "g.V().coalesce(__.values('name'),__.addV('person'))",
    "g.V().sideEffect(__.addE('knows').to(__.V('v2'))).limit(1)",
    "g.V().optional(__.properties('obsolete').drop())",
  ])("detects nested mutation steps: %s", (query) => {
    expect(validateGremlinForTool(query, "read")).toMatchObject({
      ok: false,
      reason: "tool_mismatch",
    });
  });

  it.each([
    "g.V(); g.addV('person')",
    "x = g.V(); x.property('name','Ada')",
    "g.V().sideEffect { it.get().remove() }",
    "g.'addV'('person')",
    "g.\"${'add' + 'V'}\"('person')",
    "g['addV']('person')",
    "g.invokeMethod('addV',['person'])",
    "g.V().unknownFutureStep()",
    "g.V().has('name','unterminated)",
    "g.V().limit(1",
    "notATraversal()",
  ])("denies unsupported or dynamically dispatched Groovy: %s", (query) => {
    expect(classifyGremlin(query)).toBeUndefined();
    expect(validateGremlinForTool(query, "read")).toEqual({
      ok: false,
      reason: "unsupported_syntax",
    });
    expect(validateGremlinForTool(query, "write")).toEqual({
      ok: false,
      reason: "unsupported_syntax",
    });
    expect(validateGremlinForTool(query, "delete")).toEqual({
      ok: false,
      reason: "unsupported_syntax",
    });
  });

  it("requires each mutation tool to receive its corresponding mutation class", () => {
    expect(validateGremlinForTool("g.V().limit(1)", "write")).toMatchObject({
      ok: false,
      reason: "tool_mismatch",
      classification: "read",
    });
    expect(validateGremlinForTool("g.V().limit(1)", "delete")).toMatchObject({
      ok: false,
      reason: "tool_mismatch",
      classification: "read",
    });
    expect(validateGremlinForTool("g.addV('person')", "delete")).toMatchObject({
      ok: false,
      reason: "tool_mismatch",
      classification: "write",
    });
    expect(
      validateGremlinForTool(
        "g.V('v1').property('name','Ada').sideEffect(__.properties('obsolete').drop())",
        "write",
      ),
    ).toMatchObject({
      ok: false,
      reason: "tool_mismatch",
      classification: "delete",
    });
  });
});
