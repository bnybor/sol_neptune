import { z } from "zod";

export const IDENTIFIER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:/-]*$";
export const TEMPORARY_REFERENCE_PATTERN = "^\\$[A-Za-z0-9_.:-]+$";

export const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(new RegExp(IDENTIFIER_PATTERN, "u"));
export const temporaryReferenceSchema = z
  .string()
  .min(2)
  .max(65)
  .regex(new RegExp(TEMPORARY_REFERENCE_PATTERN, "u"));
export const identifierOrReferenceSchema = z.union([
  identifierSchema,
  temporaryReferenceSchema,
]);
const propertyKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_:-]*$/u);
const finiteNumber = z.number();

export const jsonScalarSchema = z.union([
  z.string().max(65_536),
  finiteNumber,
  z.boolean(),
]);
export type JsonScalar = z.infer<typeof jsonScalarSchema>;

export const semanticPropertyValueSchema = z.union([
  jsonScalarSchema,
  z.array(jsonScalarSchema).min(1).max(100),
]);
export type SemanticPropertyValue = z.infer<typeof semanticPropertyValueSchema>;

const propertyRecordSchema = z.record(propertyKey, semanticPropertyValueSchema);

const semanticCreateSchema = z
  .object({
    id: identifierSchema.optional(),
    ref: temporaryReferenceSchema.optional(),
    graph_label: z.string().min(1).max(512).optional(),
    object_type: z.string().min(1).max(128),
    label: z.string().min(1).max(512).optional(),
    canonical: z.string().max(262_144).optional(),
    decision_state: z.string().max(128).optional(),
    epistemic_class: z.string().max(128).optional(),
    sensitivity: z.string().max(128).optional(),
    source_refs: z
      .array(identifierOrReferenceSchema)
      .min(1)
      .max(100)
      .optional(),
    about_ref: identifierOrReferenceSchema.optional(),
    properties: propertyRecordSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.id === undefined) === (value.ref === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Exactly one of id or ref is required.",
      });
    }
    const propertySourceRefs = value.properties?.source_refs;
    if (propertySourceRefs !== undefined) {
      if (
        !Array.isArray(propertySourceRefs) ||
        propertySourceRefs.length === 0 ||
        !propertySourceRefs.every(
          (candidate) =>
            typeof candidate === "string" &&
            identifierOrReferenceSchema.safeParse(candidate).success,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["properties", "source_refs"],
          message:
            "properties.source_refs must be a non-empty list of semantic ids or temporary references.",
        });
      } else if (
        value.source_refs !== undefined &&
        [...propertySourceRefs].sort().join("\u0000") !==
          [...value.source_refs].sort().join("\u0000")
      ) {
        context.addIssue({
          code: "custom",
          path: ["properties", "source_refs"],
          message:
            "source_refs conflicts with properties.source_refs; supply one equivalent value.",
        });
      }
    }
    const propertyAboutRef = value.properties?.about_ref;
    if (propertyAboutRef !== undefined) {
      if (
        typeof propertyAboutRef !== "string" ||
        !identifierOrReferenceSchema.safeParse(propertyAboutRef).success
      ) {
        context.addIssue({
          code: "custom",
          path: ["properties", "about_ref"],
          message:
            "properties.about_ref must be one semantic id or temporary reference.",
        });
      } else if (
        value.about_ref !== undefined &&
        propertyAboutRef !== value.about_ref
      ) {
        context.addIssue({
          code: "custom",
          path: ["properties", "about_ref"],
          message:
            "about_ref conflicts with properties.about_ref; supply one equivalent value.",
        });
      }
    }
  });

const propertyUpdateSchema = z
  .object({
    id: identifierSchema,
    set: propertyRecordSchema.refine(
      (value) => Object.keys(value).length > 0,
      "At least one property must be set.",
    ),
    expected: propertyRecordSchema.optional(),
  })
  .strict();

const relationshipCreateSchema = z
  .object({
    id: identifierSchema.optional(),
    ref: temporaryReferenceSchema.optional(),
    out: identifierOrReferenceSchema,
    label: z.string().min(1).max(256),
    in: identifierOrReferenceSchema,
    properties: propertyRecordSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.id !== undefined && value.ref !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A relationship cannot contain both id and ref.",
      });
    }
  });

const supersessionSchema = z
  .object({
    newer: identifierOrReferenceSchema,
    older: identifierOrReferenceSchema,
  })
  .strict();

export const getGraphStateInputSchema = z
  .object({
    include_allocators: z.boolean().default(true),
    include_v1_state: z.boolean().default(false),
  })
  .strict();
export type GetGraphStateInput = z.infer<typeof getGraphStateInputSchema>;

export const commitSemanticDeltaInputSchema = z
  .object({
    operation_id: identifierSchema.max(128),
    authority_epoch: z.string().min(1).max(256),
    expected: z
      .object({
        semantic_revision: z.number().int().nonnegative(),
        graph_revision: z.number().int().nonnegative().optional(),
        projection_revision: z.number().int().nonnegative().optional(),
      })
      .strict(),
    origin: z
      .object({
        identity: z.string().min(1).max(128),
        actor: z.string().min(1).max(128),
        context: z.string().min(1).max(512),
      })
      .strict(),
    major_version: z.literal(0).default(0),
    creates: z.array(semanticCreateSchema).max(100).default([]),
    property_updates: z.array(propertyUpdateSchema).max(100).default([]),
    relationships: z.array(relationshipCreateSchema).max(200).default([]),
    supersessions: z.array(supersessionSchema).max(100).default([]),
    revision_effect: z
      .object({
        semantic: z.boolean().default(true),
        graph: z.boolean().default(true),
        projection: z.boolean().default(true),
      })
      .strict()
      .default({ semantic: true, graph: true, projection: true }),
  })
  .strict()
  .superRefine((value, context) => {
    const mutationCount =
      value.creates.length +
      value.property_updates.length +
      value.relationships.length +
      value.supersessions.length;
    if (mutationCount === 0) {
      context.addIssue({
        code: "custom",
        message: "A semantic delta must contain at least one bounded mutation.",
      });
    }
    if (!value.revision_effect.semantic) {
      context.addIssue({
        code: "custom",
        message:
          "Initial major-version-0 semantic commits must advance the semantic revision.",
      });
    }
  });
export type CommitSemanticDeltaInput = z.infer<
  typeof commitSemanticDeltaInputSchema
>;

export const reconcileOperationInputSchema = z
  .object({
    operation_id: identifierSchema.max(128),
    authority_epoch: z.string().min(1).max(256).optional(),
    allow_continue: z.boolean().default(true),
  })
  .strict();
export type ReconcileOperationInput = z.infer<
  typeof reconcileOperationInputSchema
>;

export type GraphState = {
  primary_store: "neptune";
  authority_epoch: string;
  authority_status: string;
  semantic_revision: number;
  graph_revision: number;
  projection_revision: number;
  control_revision?: number;
  major_version: number;
  allocators?: Record<string, string>;
  v1?: {
    activation_state?: string;
    semantic_authority?: boolean;
    foreground_read_enabled?: boolean;
    copied_through_revision?: number;
    population_state?: string;
  };
};

export const semanticErrorCodes = [
  "VALIDATION_ERROR",
  "NEPTUNE_UNAVAILABLE",
  "AUTHORITY_EPOCH_MISMATCH",
  "REVISION_CONFLICT",
  "OPERATION_ID_PAYLOAD_CONFLICT",
  "ID_ALLOCATION_CONFLICT",
  "REFERENCE_NOT_FOUND",
  "REFERENCE_TYPE_MISMATCH",
  "TEMP_REF_UNRESOLVED",
  "TARGET_ALREADY_EXISTS_CONFLICT",
  "RELATIONSHIP_CONFLICT",
  "WRITER_SCOPE_DENIED",
  "VERIFY_FAILED",
  "RECOVERY_NEEDED",
  "MANUAL_REPAIR_REQUIRED",
  "INTERNAL_ERROR",
] as const;
export type SemanticErrorCode = (typeof semanticErrorCodes)[number];

export type SemanticError = {
  ok: false;
  error: {
    code: SemanticErrorCode;
    message: string;
    retry_safe: boolean;
    details?: Record<string, unknown>;
  };
};

export type SemanticRevisionSet = {
  semantic: number;
  graph: number;
  projection: number;
};

export type CommitSemanticDeltaResult = {
  ok: true;
  operation_id: string;
  status: "complete" | "already_complete" | "recovered_complete";
  authority_epoch: string;
  revisions: {
    before: SemanticRevisionSet;
    after: SemanticRevisionSet;
  };
  allocated_ids: Record<string, string>;
  created_ids: string[];
  updated_ids: string[];
  relationship_ids: string[];
  verification: {
    verified: true;
    mismatch_count: 0;
  };
};

export type SemanticOperationResult = CommitSemanticDeltaResult | SemanticError;

export const getGraphStateInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    include_allocators: { type: "boolean", default: true },
    include_v1_state: { type: "boolean", default: false },
  },
} as const;

const scalarJsonSchema = {
  anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
} as const;

const propertyValueJsonSchema = {
  anyOf: [
    scalarJsonSchema,
    { type: "array", minItems: 1, maxItems: 100, items: scalarJsonSchema },
  ],
} as const;

const propertiesJsonSchema = {
  type: "object",
  propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_:-]{0,127}$" },
  additionalProperties: propertyValueJsonSchema,
} as const;

const identifierJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: IDENTIFIER_PATTERN,
} as const;

const temporaryReferenceJsonSchema = {
  type: "string",
  minLength: 2,
  maxLength: 65,
  pattern: TEMPORARY_REFERENCE_PATTERN,
} as const;

const identifierOrReferenceJsonSchema = {
  anyOf: [identifierJsonSchema, temporaryReferenceJsonSchema],
} as const;

export const commitSemanticDeltaInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id", "authority_epoch", "expected", "origin"],
  properties: {
    operation_id: { ...identifierJsonSchema, maxLength: 128 },
    authority_epoch: { type: "string", minLength: 1, maxLength: 256 },
    expected: {
      type: "object",
      additionalProperties: false,
      required: ["semantic_revision"],
      properties: {
        semantic_revision: { type: "integer", minimum: 0 },
        graph_revision: { type: "integer", minimum: 0 },
        projection_revision: { type: "integer", minimum: 0 },
      },
    },
    origin: {
      type: "object",
      additionalProperties: false,
      required: ["identity", "actor", "context"],
      properties: {
        identity: { type: "string", minLength: 1, maxLength: 128 },
        actor: { type: "string", minLength: 1, maxLength: 128 },
        context: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
    major_version: { type: "integer", enum: [0], default: 0 },
    creates: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["object_type"],
        properties: {
          id: identifierJsonSchema,
          ref: temporaryReferenceJsonSchema,
          graph_label: { type: "string", minLength: 1, maxLength: 512 },
          object_type: { type: "string", minLength: 1, maxLength: 128 },
          label: { type: "string", minLength: 1, maxLength: 512 },
          canonical: { type: "string", maxLength: 262144 },
          decision_state: { type: "string", maxLength: 128 },
          epistemic_class: { type: "string", maxLength: 128 },
          sensitivity: { type: "string", maxLength: 128 },
          source_refs: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: identifierOrReferenceJsonSchema,
          },
          about_ref: identifierOrReferenceJsonSchema,
          properties: propertiesJsonSchema,
        },
      },
    },
    property_updates: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "set"],
        properties: {
          id: identifierJsonSchema,
          set: propertiesJsonSchema,
          expected: propertiesJsonSchema,
        },
      },
    },
    relationships: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["out", "label", "in"],
        properties: {
          id: identifierJsonSchema,
          ref: temporaryReferenceJsonSchema,
          out: identifierOrReferenceJsonSchema,
          label: { type: "string", minLength: 1, maxLength: 256 },
          in: identifierOrReferenceJsonSchema,
          properties: propertiesJsonSchema,
        },
      },
    },
    supersessions: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["newer", "older"],
        properties: {
          newer: identifierOrReferenceJsonSchema,
          older: identifierOrReferenceJsonSchema,
        },
      },
    },
    revision_effect: {
      type: "object",
      additionalProperties: false,
      properties: {
        semantic: { type: "boolean", default: true },
        graph: { type: "boolean", default: true },
        projection: { type: "boolean", default: true },
      },
    },
  },
} as const;

export const reconcileOperationInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation_id"],
  properties: {
    operation_id: { ...identifierJsonSchema, maxLength: 128 },
    authority_epoch: { type: "string", minLength: 1, maxLength: 256 },
    allow_continue: { type: "boolean", default: true },
  },
} as const;

export const semanticOperationOutputJsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
} as const;
