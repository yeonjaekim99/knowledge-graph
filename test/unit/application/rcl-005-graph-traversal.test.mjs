import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RecallGraphTraversalError,
  traverseRecallGraph,
} from "../../../dist/application/recall-graph-traversal.js";
import { RecallReadError } from "../../../dist/application/ports/recall-read-port.js";

const NOW = 1_700_100_000;

function claim(
  claimId,
  subjectId,
  subjectName,
  objectId,
  objectName,
  overrides = {},
) {
  return Object.freeze({
    claimId,
    subjectId,
    subjectName,
    objectId,
    objectName,
    supportCount: 1,
    strongestRank: 2,
    lastSeenAt: NOW,
    originSeq: Number(/^c([0-9]+)\./u.exec(claimId)?.[1] ?? 1),
    ...overrides,
  });
}

function neighborhood(entityId, entityName, links = [], incidents = []) {
  return Object.freeze({
    entity: Object.freeze({ entityId, entityName }),
    links: Object.freeze(links),
    incidents: Object.freeze(incidents),
  });
}

function link(reference, fromId, toId) {
  return Object.freeze({ ...reference, fromId, toId });
}

function sourceFrom(entries, reads = []) {
  const byId = new Map(entries);
  return Object.freeze({
    listValidClaimAggregates: async () => Object.freeze([]),
    resolveSurfaceSeeds: async (terms) =>
      Object.freeze({ terms, seeds: Object.freeze([]), truncated: false }),
    async readTraversalNeighborhood(entityId) {
      reads.push(entityId);
      const result = byId.get(entityId);
      if (result === undefined) {
        throw new Error("fixture is missing a traversal neighborhood");
      }
      return result;
    },
  });
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    assertDeepFrozen(child);
  }
}

function smuggledTraversalError(code, marker) {
  const error = new RecallGraphTraversalError(code);
  error.name = `Smuggled${marker}`;
  error.message = `smuggled-message-${marker}`;
  error.cause = { token: marker };
  error.prefix = marker;
  error.suffix = marker;
  error.secret = marker;
  return error;
}

function assertFreshTraversalError(error, injected, code, marker) {
  const expected = new RecallGraphTraversalError(code);
  assert.ok(error instanceof RecallGraphTraversalError);
  assert.notStrictEqual(error, injected);
  assert.equal(error.code, code);
  assert.equal(error.name, expected.name);
  assert.equal(error.message, expected.message);
  assert.deepEqual(Reflect.ownKeys(error).sort(), Reflect.ownKeys(expected).sort());
  assert.equal("cause" in error, false);
  assert.equal("prefix" in error, false);
  assert.equal("suffix" in error, false);
  assert.equal("secret" in error, false);
  assert.doesNotMatch(error.message, new RegExp(marker, "u"));
  assert.equal(JSON.stringify(error), JSON.stringify(expected));
  return true;
}

function smuggledSourceError(kind, marker) {
  const error =
    kind === "read"
      ? new RecallReadError("INVALID_RECALL_TRAVERSAL_STATE")
      : new Error(`ordinary-${marker}`);
  error.name = `Smuggled${marker}`;
  error.message = `smuggled-message-${marker}`;
  error.cause = { token: marker };
  error.prefix = marker;
  error.suffix = marker;
  error.secret = marker;
  return error;
}

function traversalRequest() {
  return {
    entry: "surface",
    depth: 1,
    seeds: [{ entityId: "e1.0", display: "safe" }],
  };
}

test("incoming traversal and literal collection preserve alias, FTS, overview path, and real hops", async () => {
  const contains = claim("c1.0", "e1.0", "리포", "e2.0", "인증 시스템");
  const uses = claim("c2.0", "e2.0", "인증 시스템", "e3.0", "서버 세션", {
    supportCount: 2,
    strongestRank: 3,
  });
  const literal = claim(
    "c3.0",
    "e2.0",
    "인증 시스템",
    null,
    null,
    { strongestRank: 3 },
  );
  const command = claim(
    "c4.0",
    "e4.0",
    "인증 테스트 명령",
    null,
    null,
    { strongestRank: 3 },
  );
  const source = sourceFrom([
    [
      "e1.0",
      neighborhood(
        "e1.0",
        "리포",
        [link(contains, "e1.0", "e2.0")],
        [contains],
      ),
    ],
    [
      "e2.0",
      neighborhood(
        "e2.0",
        "인증 시스템",
        [
          link(uses, "e2.0", "e3.0"),
          link(contains, "e2.0", "e1.0"),
        ],
        [uses, literal, contains],
      ),
    ],
    [
      "e3.0",
      neighborhood(
        "e3.0",
        "서버 세션",
        [link(uses, "e3.0", "e2.0")],
        [uses],
      ),
    ],
    ["e4.0", neighborhood("e4.0", "인증 테스트 명령", [], [command])],
  ]);

  const incoming = await traverseRecallGraph(source, {
    entry: "surface",
    depth: 2,
    seeds: [{ entityId: "e3.0", display: "세션 저장소" }],
  });
  const byClaim = new Map(incoming.reached.map((item) => [item.claimId, item]));
  assert.deepEqual(byClaim.get("c2.0"), {
    claimId: "c2.0",
    depth: 0,
    seedOrder: 0,
    anchorId: "e3.0",
    path: "세션 저장소 → 서버 세션 → 인증 시스템",
    hops: 1,
  });
  assert.deepEqual(byClaim.get("c1.0"), {
    claimId: "c1.0",
    depth: 1,
    seedOrder: 0,
    anchorId: "e2.0",
    path: "세션 저장소 → 서버 세션 → 인증 시스템 → 리포",
    hops: 2,
  });
  assert.deepEqual(byClaim.get("c3.0"), {
    claimId: "c3.0",
    depth: 1,
    seedOrder: 0,
    anchorId: "e2.0",
    path: "세션 저장소 → 서버 세션 → 인증 시스템",
    hops: 1,
  });
  assert.deepEqual(incoming.truncation, { links: false, incidents: false });

  const fts = await traverseRecallGraph(source, {
    entry: "fts",
    depth: 1,
    seeds: [{ entityId: "e4.0", display: "인증 명령" }],
  });
  assert.equal(fts.reached[0].path, "인증 명령 (FTS) → 인증 테스트 명령");
  assert.equal(fts.reached[0].hops, 0);

  const overview = await traverseRecallGraph(source, {
    entry: "overview",
    seeds: [{ entityId: "e4.0", display: "ignored" }],
  });
  assert.equal(overview.reached[0].path, "인증 테스트 명령");
  assert.equal(overview.reached[0].hops, 0);
  assertDeepFrozen(incoming);
  assertDeepFrozen(fts);
  assertDeepFrozen(overview);
});

test("a long surface identical to the canonical name is displayed once before truncation", async () => {
  const canonicalName = "가".repeat(81);
  const literal = claim("c1.0", "e1.0", canonicalName, null, null);
  const result = await traverseRecallGraph(
    sourceFrom([
      ["e1.0", neighborhood("e1.0", canonicalName, [], [literal])],
    ]),
    {
      entry: "surface",
      depth: 1,
      seeds: [{ entityId: "e1.0", display: canonicalName }],
    },
  );

  assert.equal(result.reached[0].path, canonicalName);
  assert.equal(result.reached[0].hops, 0);
});

test("a long FTS display reserves its marker inside the eighty-code-point budget", async () => {
  const display = "가".repeat(81);
  const literal = claim("c1.0", "e1.0", "canonical", null, null);
  const result = await traverseRecallGraph(
    sourceFrom([
      ["e1.0", neighborhood("e1.0", "canonical", [], [literal])],
    ]),
    {
      entry: "fts",
      depth: 1,
      seeds: [{ entityId: "e1.0", display }],
    },
  );
  const expectedDisplay = `${"가".repeat(73)}… (FTS)`;

  assert.equal([...expectedDisplay].length, 80);
  assert.equal(result.reached[0].path, `${expectedDisplay} → canonical`);
  assert.equal(result.reached[0].hops, 0);
});

test("traversal input branch and exact keys use one descriptor snapshot", async () => {
  const reads = new Map();
  const input = new Proxy(
    { entry: "overview", seeds: [] },
    {
      getOwnPropertyDescriptor(target, property) {
        const count = (reads.get(property) ?? 0) + 1;
        reads.set(property, count);
        if (count > 1) {
          throw new Error("do-not-resnapshot-rcl-005-input");
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    },
  );

  const result = await traverseRecallGraph(sourceFrom([]), input);

  assert.deepEqual(result.parents, []);
  assert.deepEqual(result.reached, []);
  assert.deepEqual(result.truncation, { links: false, incidents: false });
  assert.deepEqual([...reads.entries()], [["entry", 1], ["seeds", 1]]);
});

test("an entity-object incident omitted from the same root links fails closed", async () => {
  const omitted = claim("c1.0", "e1.0", "root", "e2.0", "hidden");

  await assert.rejects(
    traverseRecallGraph(
      sourceFrom([
        ["e1.0", neighborhood("e1.0", "root", [], [omitted])],
      ]),
      {
        entry: "surface",
        depth: 1,
        seeds: [{ entityId: "e1.0", display: "root" }],
      },
    ),
    (error) => {
      const expected = new RecallGraphTraversalError("INVALID_TRAVERSAL_STATE");
      assert.ok(error instanceof RecallGraphTraversalError);
      assert.equal(error.code, expected.code);
      assert.equal(error.name, expected.name);
      assert.equal(error.message, expected.message);
      assert.deepEqual(Reflect.ownKeys(error).sort(), Reflect.ownKeys(expected).sort());
      return true;
    },
  );
});

test("depth three never stops early and an unvisited entity-object endpoint can produce four hops", async () => {
  const c1 = claim("c1.0", "e1.0", "A", "e2.0", "B");
  const c2 = claim("c2.0", "e2.0", "B", "e3.0", "C");
  const c3 = claim("c3.0", "e3.0", "C", "e4.0", "D");
  const literal = claim("c4.0", "e4.0", "D", null, null);
  const frontierEdge = claim("c5.0", "e4.0", "D", "e5.0", "E");
  const backEdge = claim("c6.0", "e4.0", "D", "e2.0", "B");
  const entries = [
    ["e1.0", neighborhood("e1.0", "A", [link(c1, "e1.0", "e2.0")], [c1])],
    [
      "e2.0",
      neighborhood(
        "e2.0",
        "B",
        [link(c1, "e2.0", "e1.0"), link(c2, "e2.0", "e3.0")],
        [c1, c2],
      ),
    ],
    [
      "e3.0",
      neighborhood(
        "e3.0",
        "C",
        [link(c2, "e3.0", "e2.0"), link(c3, "e3.0", "e4.0")],
        [c2, c3],
      ),
    ],
    [
      "e4.0",
      neighborhood(
        "e4.0",
        "D",
        [
          link(c3, "e4.0", "e3.0"),
          link(frontierEdge, "e4.0", "e5.0"),
          link(backEdge, "e4.0", "e2.0"),
        ],
        [c3, literal, frontierEdge, backEdge],
      ),
    ],
  ];
  const reads = [];
  const result = await traverseRecallGraph(sourceFrom(entries, reads), {
    entry: "surface",
    depth: 3,
    seeds: [{ entityId: "e1.0", display: "A" }],
  });

  assert.deepEqual(reads, ["e1.0", "e2.0", "e3.0", "e4.0"]);
  const byClaim = new Map(result.reached.map((item) => [item.claimId, item]));
  assert.deepEqual(byClaim.get("c4.0"), {
    claimId: "c4.0",
    depth: 3,
    seedOrder: 0,
    anchorId: "e4.0",
    path: "A → B → C → D",
    hops: 3,
  });
  assert.equal(byClaim.get("c5.0").path, "A → B → C → D → E");
  assert.equal(byClaim.get("c5.0").hops, 4);
  assert.equal(byClaim.get("c6.0").path, "A → B → C → D → B");
  assert.equal(byClaim.get("c6.0").hops, 4);
});

test("multi-seed BFS keeps canonical one-visit and earliest seed then numeric edge order", async () => {
  const firstEdge = claim("c2.2", "e1.0", "seed-0", "e2.0", "left", {
    originSeq: 2,
  });
  const secondEdge = claim("c2.10", "e1.0", "seed-0", "e3.0", "right", {
    originSeq: 2,
  });
  const leftToJoin = claim("c3.0", "e2.0", "left", "e5.0", "join");
  const rightToJoin = claim("c4.0", "e3.0", "right", "e5.0", "join");
  const lateSeed = claim("c5.0", "e4.0", "seed-1", "e5.0", "join");
  const cycle = claim("c6.0", "e5.0", "join", "e1.0", "seed-0");
  const joinedLiteral = claim("c7.0", "e5.0", "join", null, null);
  const source = sourceFrom([
    [
      "e1.0",
      neighborhood(
        "e1.0",
        "seed-0",
        [
          link(firstEdge, "e1.0", "e2.0"),
          link(secondEdge, "e1.0", "e3.0"),
          link(cycle, "e1.0", "e5.0"),
        ],
        [firstEdge, secondEdge, cycle],
      ),
    ],
    [
      "e4.0",
      neighborhood(
        "e4.0",
        "seed-1",
        [link(lateSeed, "e4.0", "e5.0")],
        [lateSeed],
      ),
    ],
    [
      "e2.0",
      neighborhood(
        "e2.0",
        "left",
        [link(firstEdge, "e2.0", "e1.0"), link(leftToJoin, "e2.0", "e5.0")],
        [firstEdge, leftToJoin],
      ),
    ],
    [
      "e3.0",
      neighborhood(
        "e3.0",
        "right",
        [link(secondEdge, "e3.0", "e1.0"), link(rightToJoin, "e3.0", "e5.0")],
        [secondEdge, rightToJoin],
      ),
    ],
    [
      "e5.0",
      neighborhood(
        "e5.0",
        "join",
        [
          link(leftToJoin, "e5.0", "e2.0"),
          link(rightToJoin, "e5.0", "e3.0"),
          link(lateSeed, "e5.0", "e4.0"),
          link(cycle, "e5.0", "e1.0"),
        ],
        [leftToJoin, rightToJoin, lateSeed, cycle, joinedLiteral],
      ),
    ],
  ]);

  const first = await traverseRecallGraph(source, {
    entry: "surface",
    depth: 2,
    seeds: [
      { entityId: "e1.0", display: "zero" },
      { entityId: "e4.0", display: "one" },
    ],
  });
  const second = await traverseRecallGraph(source, {
    entry: "surface",
    depth: 2,
    seeds: [
      { entityId: "e1.0", display: "zero" },
      { entityId: "e4.0", display: "one" },
    ],
  });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const joinParent = first.parents.find(({ entityId }) => entityId === "e5.0");
  assert.deepEqual(joinParent, {
    entityId: "e5.0",
    entityName: "join",
    parentId: "e1.0",
    viaClaimId: "c6.0",
    depth: 1,
    seedOrder: 0,
  });
  assert.equal(first.parents.filter(({ entityId }) => entityId === "e5.0").length, 1);
  const joined = first.reached.find(({ claimId }) => claimId === "c7.0");
  assert.equal(joined.seedOrder, 0);
  assert.equal(joined.anchorId, "e5.0");
});

test("link and incident caps read thirty-one, use thirty, and preserve the truncation reasons", async () => {
  const references = Array.from({ length: 31 }, (_, index) =>
    claim(
      `c${index + 1}.0`,
      "e1.0",
      "hub",
      `e${index + 2}.0`,
      `node-${index}`,
      { supportCount: 31 - index },
    ));
  const entries = [
    [
      "e1.0",
      neighborhood(
        "e1.0",
        "hub",
        references.map((reference) =>
          link(reference, "e1.0", reference.objectId)),
        references,
      ),
    ],
    ...references.slice(0, 30).map((reference) => [
      reference.objectId,
      neighborhood(
        reference.objectId,
        reference.objectName,
        [link(reference, reference.objectId, "e1.0")],
        [reference],
      ),
    ]),
  ];

  const result = await traverseRecallGraph(sourceFrom(entries), {
    entry: "surface",
    depth: 1,
    seeds: [{ entityId: "e1.0", display: "hub" }],
  });
  assert.equal(result.reached.length, 30);
  assert.equal(result.parents.length, 31);
  assert.equal(result.reached.some(({ claimId }) => claimId === "c31.0"), false);
  assert.equal(result.parents.some(({ entityId }) => entityId === "e32.0"), false);
  assert.deepEqual(result.truncation, { links: true, incidents: true });
});

test("invalid input and malformed neighborhoods fail closed without retaining payloads", async () => {
  await assert.rejects(
    traverseRecallGraph(sourceFrom([]), {
      entry: "surface",
      depth: 0,
      seeds: [{ entityId: "e1.0", display: "secret-depth" }],
    }),
    (error) => {
      assert.ok(error instanceof RecallGraphTraversalError);
      assert.equal(error.code, "INVALID_TRAVERSAL_INPUT");
      assert.equal(error.message.includes("secret-depth"), false);
      assert.equal("cause" in error, false);
      return true;
    },
  );

  const secret = "secret-neighborhood-payload";
  const source = sourceFrom([
    [
      "e1.0",
      {
        ...neighborhood("e1.0", "safe", [], []),
        attackerField: secret,
      },
    ],
  ]);
  await assert.rejects(
    traverseRecallGraph(source, {
      entry: "surface",
      depth: 1,
      seeds: [{ entityId: "e1.0", display: "safe" }],
    }),
    (error) => {
      assert.ok(error instanceof RecallGraphTraversalError);
      assert.equal(error.code, "INVALID_TRAVERSAL_STATE");
      assert.equal(error.message.includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );
});

test("typed traversal failures from the source are replaced by a fresh fixed state error", async () => {
  const marker = "do-not-smuggle-rcl-005-source-rejection";
  const injected = smuggledTraversalError("INVALID_TRAVERSAL_STATE", marker);
  const source = Object.freeze({
    listValidClaimAggregates: async () => Object.freeze([]),
    resolveSurfaceSeeds: async (terms) =>
      Object.freeze({ terms, seeds: Object.freeze([]), truncated: false }),
    async readTraversalNeighborhood() {
      throw injected;
    },
  });

  await assert.rejects(
    traverseRecallGraph(source, {
      entry: "surface",
      depth: 1,
      seeds: [{ entityId: "e1.0", display: "safe" }],
    }),
    (error) =>
      assertFreshTraversalError(
        error,
        injected,
        "INVALID_TRAVERSAL_STATE",
        marker,
      ),
  );
});

for (const boundary of [
  "property-getter",
  "proxy-get",
  "method-invocation",
  "promise-settlement",
  "thenable-assimilation",
]) {
  test(`source ${boundary} failures become fresh fixed traversal state errors`, async () => {
    const marker = `do-not-smuggle-rcl-005-source-${boundary}`;
    const injected = smuggledSourceError(
      boundary === "proxy-get" || boundary === "promise-settlement"
        ? "read"
        : "ordinary",
      marker,
    );
    const base = {
      listValidClaimAggregates: async () => Object.freeze([]),
      resolveSurfaceSeeds: async (terms) =>
        Object.freeze({ terms, seeds: Object.freeze([]), truncated: false }),
    };
    let source;
    if (boundary === "property-getter") {
      source = { ...base };
      Object.defineProperty(source, "readTraversalNeighborhood", {
        enumerable: true,
        get() {
          throw injected;
        },
      });
    } else if (boundary === "proxy-get") {
      source = new Proxy(
        { ...base, readTraversalNeighborhood() {} },
        {
          get(target, property, receiver) {
            if (property === "readTraversalNeighborhood") {
              throw injected;
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );
    } else if (boundary === "method-invocation") {
      source = {
        ...base,
        readTraversalNeighborhood() {
          throw injected;
        },
      };
    } else if (boundary === "promise-settlement") {
      source = {
        ...base,
        readTraversalNeighborhood() {
          return Promise.reject(injected);
        },
      };
    } else {
      source = {
        ...base,
        readTraversalNeighborhood() {
          return Object.defineProperty({}, "then", {
            get() {
              throw injected;
            },
          });
        },
      };
    }

    await assert.rejects(
      traverseRecallGraph(source, traversalRequest()),
      (error) =>
        assertFreshTraversalError(
          error,
          injected,
          "INVALID_TRAVERSAL_STATE",
          marker,
        ),
    );
  });
}

test("input and neighborhood traps are descriptor-only and become fresh fixed errors", async () => {
  const inputMarker = "do-not-smuggle-rcl-005-input-proxy";
  const injectedInput = smuggledTraversalError(
    "INVALID_TRAVERSAL_INPUT",
    inputMarker,
  );
  const trappedInput = new Proxy(
    {
      entry: "surface",
      depth: 1,
      seeds: [{ entityId: "e1.0", display: "safe" }],
    },
    {
      getPrototypeOf() {
        throw injectedInput;
      },
    },
  );
  await assert.rejects(
    traverseRecallGraph(sourceFrom([]), trappedInput),
    (error) =>
      assertFreshTraversalError(
        error,
        injectedInput,
        "INVALID_TRAVERSAL_INPUT",
        inputMarker,
      ),
  );

  let accessorRead = false;
  for (const boundary of ["envelope", "accessor", "array", "row"]) {
    const marker = `do-not-smuggle-rcl-005-neighborhood-${boundary}`;
    const injected = smuggledTraversalError(
      "INVALID_TRAVERSAL_STATE",
      marker,
    );
    let state;
    if (boundary === "envelope") {
      state = new Proxy(neighborhood("e1.0", "safe", [], []), {
        getPrototypeOf() {
          throw injected;
        },
      });
    } else if (boundary === "accessor") {
      const entity = { entityId: "e1.0" };
      Object.defineProperty(entity, "entityName", {
        enumerable: true,
        get() {
          accessorRead = true;
          throw injected;
        },
      });
      state = { entity, links: [], incidents: [] };
    } else if (boundary === "array") {
      state = {
        entity: { entityId: "e1.0", entityName: "safe" },
        links: new Proxy([], {
          getOwnPropertyDescriptor() {
            throw injected;
          },
        }),
        incidents: [],
      };
    } else {
      const reference = claim("c1.0", "e1.0", "safe", null, null);
      state = {
        entity: { entityId: "e1.0", entityName: "safe" },
        links: [],
        incidents: [
          new Proxy(reference, {
            ownKeys() {
              throw injected;
            },
          }),
        ],
      };
    }

    await assert.rejects(
      traverseRecallGraph(sourceFrom([["e1.0", state]]), {
        entry: "surface",
        depth: 1,
        seeds: [{ entityId: "e1.0", display: "safe" }],
      }),
      (error) =>
        assertFreshTraversalError(
          error,
          injected,
          "INVALID_TRAVERSAL_STATE",
          marker,
        ),
      boundary,
    );
  }
  assert.equal(accessorRead, false);
});
