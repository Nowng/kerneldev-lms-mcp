/**
 * jsonSchemaToZod — converts a JSON Schema object (as emitted by the Python
 * MCP server's tool input schemas) into a Zod schema and a ZodRawShape
 * (Record<string, ZodType>) suitable for use with @lmstudio/sdk's `tool()`
 * function.
 *
 * This enables the LM Studio plugin to expose rich, validated parameter
 * schemas (autocompletion + validation) while the actual tool logic runs
 * in the Python MCP server.
 *
 * Supported JSON Schema features:
 *   - primitive types: string, number, integer, boolean
 *   - enum → z.enum()
 *   - default values → .default()
 *   - minimum / maximum → .min() / .max()
 *   - object with properties + required → z.object()
 *   - array with items → z.array()
 *   - additionalProperties → z.record()
 *   - type as array (e.g. ["string", "null"]) → z.union([..., z.null()])
 *
 * Any unsupported or malformed schema falls back to z.any() so the wrapper
 * never crashes due to an unfamiliar schema construct.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface JsonSchemaToZodResult {
  /** A full Zod schema. */
  schema: z.ZodTypeAny;
  /** A ZodRawShape (Record<string, ZodType>) for @lmstudio/sdk tool(). */
  shape: Record<string, z.ZodTypeAny>;
  /** Human-readable description of the schema. */
  description: string;
}

function isTypeArray(schema: Record<string, unknown>): schema is Record<string, unknown> & { type: (string | Record<string, unknown>)[] } {
  return Array.isArray(schema.type);
}

/** Convert a Zod type to a human-readable type name. */
function zodTypeName(zod: z.ZodTypeAny): string {
  const def = (zod as any)._def;
  if (def && def.typeName) {
    return def.typeName.toLowerCase().replace("_", " ");
  }
  return "any";
}

/** Convert a JSON Schema to a Zod schema (recursive). */
function jsonSchemaToZodSchema(schema: Record<string, unknown>): z.ZodTypeAny {
  const type = schema.type as string;

  // Union types: ["string", "null"] → z.union([...])
  if (isTypeArray(schema)) {
    const members: z.ZodTypeAny[] = schema.type.map((t: unknown) => {
      if (typeof t === "string") {
        return jsonSchemaToZodSchema({ type: t });
      }
      if (typeof t === "object" && t !== null) {
        return jsonSchemaToZodSchema(t as Record<string, unknown>);
      }
      return z.any();
    });
    if (members.length === 1) {
      let zod: z.ZodTypeAny = members[0];
      if (schema.default !== undefined) {
        zod = zod.default(schema.default);
      }
      return zod;
    }
    let zod: z.ZodTypeAny = z.union(members as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    if (schema.default !== undefined) {
      zod = zod.default(schema.default);
    }
    return zod;
  }

  // string
  if (type === "string") {
    let zod: z.ZodTypeAny = z.string();
    if (schema.enum && Array.isArray(schema.enum)) {
      zod = z.enum(schema.enum as [string, ...string[]]);
    }
    if (schema.default !== undefined) {
      zod = zod.default(schema.default as string);
    }
    return zod;
  }

  // number / integer
  if (type === "number" || type === "integer") {
    let zod: z.ZodNumber = type === "integer" ? z.number().int() : z.number();
    if (schema.minimum !== undefined) {
      zod = zod.min(schema.minimum as number);
    }
    if (schema.maximum !== undefined) {
      zod = zod.max(schema.maximum as number);
    }
    let result: z.ZodTypeAny = zod;
    if (schema.default !== undefined) {
      result = result.default(schema.default as number);
    }
    return result;
  }

  // boolean
  if (type === "boolean") {
    let zod: z.ZodTypeAny = z.boolean();
    if (schema.default !== undefined) {
      zod = zod.default(schema.default as boolean);
    }
    return zod;
  }

  // array
  if (type === "array") {
    const itemsSchema = schema.items as Record<string, unknown> | undefined;
    let zod: z.ZodTypeAny = z.array(itemsSchema ? jsonSchemaToZodSchema(itemsSchema) : z.any());
    if (schema.default !== undefined) {
      zod = zod.default(schema.default as unknown[]);
    }
    return zod;
  }

  // object
  if (type === "object") {
    const properties = (schema.properties as Record<string, unknown>) || {};
    const required = (schema.required as string[]) || [];
    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [name, propSchema] of Object.entries(properties)) {
      const zodType = jsonSchemaToZodSchema(propSchema as Record<string, unknown>);
      shape[name] = required.includes(name) ? zodType : zodType.optional();
    }

    let zod: z.ZodTypeAny = z.object(shape);

    const additionalProps = schema.additionalProperties;
    if (additionalProps && typeof additionalProps === "object" && !Array.isArray(additionalProps)) {
      const additionalSchema = additionalProps as Record<string, unknown>;
      if (additionalSchema.type) {
        const catchallSchema =
          additionalSchema.type === "string" || additionalSchema.type === "null"
            ? z.union([z.string(), z.null()])
            : jsonSchemaToZodSchema(additionalSchema);
        zod = (zod as z.ZodObject<z.ZodRawShape>).catchall(catchallSchema) as z.ZodTypeAny;
      }
    }

    if (schema.default !== undefined && typeof schema.default === "object") {
      zod = zod.default(schema.default as Record<string, unknown>);
    }

    return zod;
  }

  // Fallback
  return z.any();
}

/** Build a human-readable description of an object schema's properties. */
function describeObjectSchema(schema: Record<string, unknown>): string {
  const properties = (schema.properties as Record<string, unknown>) || {};
  const required = (schema.required as string[]) || [];
  const parts: string[] = [];

  for (const [name, propSchema] of Object.entries(properties)) {
    const prop = propSchema as Record<string, unknown>;
    const typeName = prop.type ? String(prop.type) : "any";
    const requiredMark = required.includes(name) ? "" : " (optional)";
    const desc = prop.description ? ` — ${prop.description}` : "";
    parts.push(`  ${name}${requiredMark}: ${typeName}${desc}`);
  }

  return `Object with properties:${parts.length > 0 ? "\n" + parts.join("\n") : " (none)"}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a JSON Schema (as emitted by the Python MCP server) into a result
 * object containing a Zod schema, a ZodRawShape, and a description.
 */
export function jsonSchemaToZodFull(
  schema: Record<string, unknown> | undefined,
): JsonSchemaToZodResult {
  if (!schema || schema.type === undefined) {
    return {
      schema: z.any(),
      shape: {},
      description: "Any arguments accepted.",
    };
  }

  try {
    if (schema.type === "object") {
      const properties = (schema.properties as Record<string, unknown>) || {};
      const required = (schema.required as string[]) || [];
      const shape: Record<string, z.ZodTypeAny> = {};

      for (const [name, propSchema] of Object.entries(properties)) {
        const zodType = jsonSchemaToZodSchema(propSchema as Record<string, unknown>);
        shape[name] = required.includes(name) ? zodType : zodType.optional();
      }

      let schemaObj: z.ZodTypeAny = z.object(shape);

      const additionalProps = schema.additionalProperties;
      if (additionalProps && typeof additionalProps === "object" && !Array.isArray(additionalProps)) {
        const additionalSchema = additionalProps as Record<string, unknown>;
        if (additionalSchema.type) {
          const catchallSchema =
            additionalSchema.type === "string" || additionalSchema.type === "null"
              ? z.union([z.string(), z.null()])
              : jsonSchemaToZodSchema(additionalSchema);
          schemaObj = (schemaObj as z.ZodObject<z.ZodRawShape>).catchall(catchallSchema) as z.ZodTypeAny;
        }
      }

      if (schema.default !== undefined && typeof schema.default === "object") {
        schemaObj = schemaObj.default(schema.default as Record<string, unknown>);
      }

      return {
        schema: schemaObj,
        shape,
        description: describeObjectSchema(schema),
      };
    }

    // Non-object schemas (unions, etc.) — wrap in a single "value" field.
    const zodType = jsonSchemaToZodSchema(schema);
    return {
      schema: zodType,
      shape: {},
      description: `A ${String(schema.type)} value.${schema.description ? " " + schema.description : ""}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.warn(`[jsonSchemaToZod] Failed to convert schema: ${message}`);
    return {
      schema: z.any(),
      shape: {},
      description: "Any arguments accepted.",
    };
  }
}

/**
 * Convert a JSON Schema to a Zod schema (shorthand for jsonSchemaToZodFull).
 */
export function jsonSchemaToZod(schema: Record<string, unknown> | undefined): z.ZodTypeAny {
  return jsonSchemaToZodFull(schema).schema;
}
