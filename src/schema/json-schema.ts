import type { FromSchema, JSONSchema } from "json-schema-to-ts";

export const JSON_SCHEMA_DIALECT_2020_12: "https://json-schema.org/draft/2020-12/schema" =
  "https://json-schema.org/draft/2020-12/schema";

type JsonSchemaObject = Exclude<JSONSchema, boolean>;

export type NormativeJsonSchema = JsonSchemaObject &
  Readonly<{
    $schema: typeof JSON_SCHEMA_DIALECT_2020_12;
  }>;

export type InferJsonSchema<Schema extends JSONSchema> = FromSchema<Schema>;

export type JsonSchemaDefinitionErrorCode =
  | "INVALID_SCHEMA_KEYWORD"
  | "NON_JSON_VALUE"
  | "OPEN_OBJECT_SCHEMA"
  | "UNSUPPORTED_DIALECT";

export class JsonSchemaDefinitionError extends Error {
  readonly code: JsonSchemaDefinitionErrorCode;
  readonly schemaPath: string;

  constructor(
    code: JsonSchemaDefinitionErrorCode,
    schemaPath: string,
    message: string,
  ) {
    super(`${schemaPath}: ${message}`);
    this.name = "JsonSchemaDefinitionError";
    this.code = code;
    this.schemaPath = schemaPath;
  }
}

export interface DefinedJsonSchema<Schema extends NormativeJsonSchema> {
  readonly schema: Schema;
  readonly canonical: string;
}

const SINGLE_SCHEMA_KEYWORDS: readonly string[] = Object.freeze([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

const SCHEMA_ARRAY_KEYWORDS: readonly string[] = Object.freeze([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);

const SCHEMA_MAP_KEYWORDS: readonly string[] = Object.freeze([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPath(path: string, key: string): string {
  return `${path}/${pointerSegment(key)}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function normalizeJsonValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new JsonSchemaDefinitionError(
        "NON_JSON_VALUE",
        path,
        "schema numbers must be finite",
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (typeof value !== "object") {
    throw new JsonSchemaDefinitionError(
      "NON_JSON_VALUE",
      path,
      "schema values must be JSON values",
    );
  }

  if (ancestors.has(value)) {
    throw new JsonSchemaDefinitionError(
      "NON_JSON_VALUE",
      path,
      "schema values must not be cyclic",
    );
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        normalizeJsonValue(item, childPath(path, String(index)), ancestors),
      );
    }

    if (!isPlainRecord(value)) {
      throw new JsonSchemaDefinitionError(
        "NON_JSON_VALUE",
        path,
        "schema objects must be plain JSON objects",
      );
    }

    const ownKeys = Reflect.ownKeys(value);
    const symbolKey = ownKeys.find(
      (key): key is symbol => typeof key === "symbol",
    );
    if (symbolKey !== undefined) {
      throw new JsonSchemaDefinitionError(
        "NON_JSON_VALUE",
        path,
        "schema objects must not contain symbol keys",
      );
    }

    const entries: Array<[string, unknown]> = [];
    for (const key of (ownKeys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        throw new JsonSchemaDefinitionError(
          "NON_JSON_VALUE",
          childPath(path, key),
          "schema properties must be enumerable data properties",
        );
      }
      entries.push([
        key,
        normalizeJsonValue(
          descriptor.value,
          childPath(path, key),
          ancestors,
        ),
      ]);
    }
    return Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}

function assertNonNegativeIntegerBound(
  schema: Record<string, unknown>,
  minimumKey: string,
  maximumKey: string,
  path: string,
): void {
  const minimum = schema[minimumKey];
  const maximum = schema[maximumKey];
  for (const [key, value] of [
    [minimumKey, minimum],
    [maximumKey, maximum],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || (value as number) < 0)
    ) {
      throw new JsonSchemaDefinitionError(
        "INVALID_SCHEMA_KEYWORD",
        childPath(path, key),
        `${key} must be a non-negative safe integer`,
      );
    }
  }
  if (
    typeof minimum === "number" &&
    typeof maximum === "number" &&
    minimum > maximum
  ) {
    throw new JsonSchemaDefinitionError(
      "INVALID_SCHEMA_KEYWORD",
      path,
      `${minimumKey} must not exceed ${maximumKey}`,
    );
  }
}

function assertSchemaNode(value: unknown, path: string): void {
  if (typeof value === "boolean") {
    return;
  }
  if (!isPlainRecord(value)) {
    throw new JsonSchemaDefinitionError(
      "INVALID_SCHEMA_KEYWORD",
      path,
      "schema node must be an object or boolean",
    );
  }

  if (
    value["$schema"] !== undefined &&
    value["$schema"] !== JSON_SCHEMA_DIALECT_2020_12
  ) {
    throw new JsonSchemaDefinitionError(
      "UNSUPPORTED_DIALECT",
      childPath(path, "$schema"),
      "only JSON Schema Draft 2020-12 is supported",
    );
  }

  const declaredTypes = Array.isArray(value["type"])
    ? value["type"]
    : [value["type"]];
  if (
    declaredTypes.includes("object") &&
    value["additionalProperties"] !== false
  ) {
    throw new JsonSchemaDefinitionError(
      "OPEN_OBJECT_SCHEMA",
      path,
      "every schema declaring type object must set additionalProperties to false",
    );
  }

  assertNonNegativeIntegerBound(value, "minLength", "maxLength", path);
  assertNonNegativeIntegerBound(value, "minItems", "maxItems", path);
  assertNonNegativeIntegerBound(value, "minProperties", "maxProperties", path);

  if (value["oneOf"] !== undefined) {
    if (!Array.isArray(value["oneOf"]) || value["oneOf"].length < 2) {
      throw new JsonSchemaDefinitionError(
        "INVALID_SCHEMA_KEYWORD",
        childPath(path, "oneOf"),
        "oneOf must contain at least two schema branches",
      );
    }
  }

  for (const key of SINGLE_SCHEMA_KEYWORDS) {
    const child = value[key];
    if (child === undefined) {
      continue;
    }
    if (key === "items" && Array.isArray(child)) {
      child.forEach((item, index) =>
        assertSchemaNode(item, childPath(childPath(path, key), String(index))),
      );
    } else {
      assertSchemaNode(child, childPath(path, key));
    }
  }

  for (const key of SCHEMA_ARRAY_KEYWORDS) {
    const children = value[key];
    if (children === undefined) {
      continue;
    }
    if (!Array.isArray(children)) {
      throw new JsonSchemaDefinitionError(
        "INVALID_SCHEMA_KEYWORD",
        childPath(path, key),
        `${key} must be an array of schemas`,
      );
    }
    children.forEach((child, index) =>
      assertSchemaNode(child, childPath(childPath(path, key), String(index))),
    );
  }

  for (const key of SCHEMA_MAP_KEYWORDS) {
    const children = value[key];
    if (children === undefined) {
      continue;
    }
    if (!isPlainRecord(children)) {
      throw new JsonSchemaDefinitionError(
        "INVALID_SCHEMA_KEYWORD",
        childPath(path, key),
        `${key} must be an object containing schemas`,
      );
    }
    for (const [childKey, child] of Object.entries(children)) {
      assertSchemaNode(child, childPath(childPath(path, key), childKey));
    }
  }

  if (value["dependencies"] !== undefined) {
    if (!isPlainRecord(value["dependencies"])) {
      throw new JsonSchemaDefinitionError(
        "INVALID_SCHEMA_KEYWORD",
        childPath(path, "dependencies"),
        "dependencies must be an object",
      );
    }
    for (const [key, dependency] of Object.entries(value["dependencies"])) {
      if (!Array.isArray(dependency)) {
        assertSchemaNode(
          dependency,
          childPath(childPath(path, "dependencies"), key),
        );
      }
    }
  }
}

function assertRootSchema(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new JsonSchemaDefinitionError(
      "INVALID_SCHEMA_KEYWORD",
      "#",
      "the normative root schema must use the object form",
    );
  }
  if (value["$schema"] !== JSON_SCHEMA_DIALECT_2020_12) {
    throw new JsonSchemaDefinitionError(
      "UNSUPPORTED_DIALECT",
      "#/$schema",
      "the normative root schema must declare JSON Schema Draft 2020-12",
    );
  }
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  Object.freeze(value);
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalStringify(value[key])}`,
      )
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new JsonSchemaDefinitionError(
      "NON_JSON_VALUE",
      "#",
      "schema values must be serializable JSON values",
    );
  }
  return serialized;
}

export function defineJsonSchema<const Schema extends NormativeJsonSchema>(
  source: Schema,
): DefinedJsonSchema<Schema> {
  const normalized = normalizeJsonValue(
    source,
    "#",
    new WeakSet<object>(),
  ) as Schema;
  assertRootSchema(normalized);
  assertSchemaNode(normalized, "#");
  const canonical = canonicalStringify(normalized);
  deepFreeze(normalized);
  return Object.freeze({ schema: normalized, canonical });
}

export function serializeJsonSchema<Schema extends NormativeJsonSchema>(
  definition: DefinedJsonSchema<Schema>,
): string {
  return definition.canonical;
}
