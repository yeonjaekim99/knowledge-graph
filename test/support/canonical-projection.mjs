import { createHash } from "node:crypto";

const FORMAT = "recall-projection-v1";

export class CanonicalProjectionError extends TypeError {
  constructor(code, path) {
    super(`Canonical projection rejected ${code} at ${path}`);
    this.name = "CanonicalProjectionError";
    this.code = code;
    this.path = path;
  }
}

function reject(code, path) {
  throw new CanonicalProjectionError(code, path);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringFrame(value) {
  return `s${Buffer.byteLength(value, "utf8")}:${value}`;
}

function numberText(value, path) {
  if (!Number.isFinite(value)) {
    reject("NON_JSON_VALUE", path);
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    reject("UNSAFE_NUMBER", path);
  }
  return Object.is(value, -0) ? "0" : JSON.stringify(value);
}

function ownDataEntries(value, path) {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    reject("NON_JSON_VALUE", path);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      reject("NON_JSON_VALUE", path);
    }
  }
  return keys.sort().map((key) => [key, descriptors[key].value]);
}

function encodeCanonical(value, path = "#", active = new WeakSet()) {
  if (value === null) {
    return "n0:";
  }
  if (typeof value === "string") {
    return stringFrame(value);
  }
  if (typeof value === "boolean") {
    return value ? "b1:1" : "b1:0";
  }
  if (typeof value === "number") {
    const text = numberText(value, path);
    return `d${Buffer.byteLength(text, "utf8")}:${text}`;
  }
  if (typeof value !== "object") {
    reject("NON_JSON_VALUE", path);
  }
  if (active.has(value)) {
    reject("NON_JSON_VALUE", path);
  }
  active.add(value);

  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          reject("NON_JSON_VALUE", `${path}/${index}`);
        }
      }
      const extraKeys = Reflect.ownKeys(value).filter(
        (key) => key !== "length" && !(typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key)),
      );
      if (extraKeys.length > 0) {
        reject("NON_JSON_VALUE", path);
      }
      return `a${value.length}:[${value
        .map((child, index) => encodeCanonical(child, `${path}/${index}`, active))
        .join("")}]`;
    }

    if (!isPlainObject(value)) {
      reject("NON_JSON_VALUE", path);
    }
    const entries = ownDataEntries(value, path);
    return `o${entries.length}:{${entries
      .map(
        ([key, child]) =>
          `${stringFrame(key)}${encodeCanonical(child, `${path}/${key}`, active)}`,
      )
      .join("")}}`;
  } finally {
    active.delete(value);
  }
}

function cloneJson(value, path = "#", active = new WeakSet()) {
  encodeCanonical(value, path, active);
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((child, index) => cloneJson(child, `${path}/${index}`)));
  }
  return Object.freeze(
    Object.fromEntries(
      ownDataEntries(value, path).map(([key, child]) => [
        key,
        cloneJson(child, `${path}/${key}`),
      ]),
    ),
  );
}

export function freezeJsonCopy(value) {
  return cloneJson(value);
}

function primaryKeyEncoding(row, primaryKey, path) {
  const values = primaryKey.map((column) => {
    if (!Object.hasOwn(row, column)) {
      reject("MISSING_PRIMARY_KEY", path);
    }
    const value = row[column];
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      reject("INVALID_PRIMARY_KEY", path);
    }
    return value;
  });
  return encodeCanonical(values, `${path}/primary-key`);
}

export function canonicalProjectionDump(tables) {
  if (!isPlainObject(tables)) {
    reject("INVALID_PROJECTION", "#");
  }
  const normalizedTables = [];
  let rowCount = 0;

  for (const [tableName, descriptor] of ownDataEntries(tables, "#")) {
    const tablePath = `#/tables/${tableName}`;
    if (
      !isPlainObject(descriptor) ||
      !Array.isArray(descriptor.primaryKey) ||
      descriptor.primaryKey.length === 0 ||
      new Set(descriptor.primaryKey).size !== descriptor.primaryKey.length ||
      !descriptor.primaryKey.every(
        (column) => typeof column === "string" && column.length > 0,
      ) ||
      !Array.isArray(descriptor.rows)
    ) {
      reject("INVALID_TABLE", tablePath);
    }
    const descriptorKeys = ownDataEntries(descriptor, tablePath).map(([key]) => key);
    if (descriptorKeys.join(",") !== "primaryKey,rows") {
      reject("INVALID_TABLE", tablePath);
    }

    const seenPrimaryKeys = new Set();
    const rows = descriptor.rows.map((row, index) => {
      const rowPath = `${tablePath}/rows/${index}`;
      if (!isPlainObject(row)) {
        reject("INVALID_ROW", rowPath);
      }
      const copy = freezeJsonCopy(row);
      const primaryKey = primaryKeyEncoding(copy, descriptor.primaryKey, rowPath);
      if (seenPrimaryKeys.has(primaryKey)) {
        reject("DUPLICATE_PRIMARY_KEY", rowPath);
      }
      seenPrimaryKeys.add(primaryKey);
      return { primaryKey, row: copy, rowEncoding: encodeCanonical(copy, rowPath) };
    });
    rows.sort((left, right) => {
      const byPrimaryKey = Buffer.compare(
        Buffer.from(left.primaryKey, "utf8"),
        Buffer.from(right.primaryKey, "utf8"),
      );
      if (byPrimaryKey !== 0) {
        return byPrimaryKey;
      }
      return Buffer.compare(
        Buffer.from(left.rowEncoding, "utf8"),
        Buffer.from(right.rowEncoding, "utf8"),
      );
    });
    rowCount += rows.length;
    normalizedTables.push({
      name: tableName,
      primary_key: [...descriptor.primaryKey],
      rows: rows.map(({ row }) => row),
    });
  }

  normalizedTables.sort((left, right) => Buffer.compare(
    Buffer.from(left.name, "utf8"),
    Buffer.from(right.name, "utf8"),
  ));
  const normalized = freezeJsonCopy({ format: FORMAT, tables: normalizedTables });
  const canonical = encodeCanonical(normalized);
  return freezeJsonCopy({
    format: FORMAT,
    table_count: normalizedTables.length,
    row_count: rowCount,
    canonical,
    checksum: createHash("sha256").update(canonical, "utf8").digest("hex"),
  });
}
