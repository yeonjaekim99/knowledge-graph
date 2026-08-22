const BASE_TIME = 1_700_000_000;

export const PRIMARY_SCOPE = Object.freeze({
  userId: "parity-user",
  projectId: "recall",
  scopeKey: "u:parity-user/p:recall",
});

export const SECONDARY_SCOPE = Object.freeze({
  userId: "other-user",
  projectId: "recall",
  scopeKey: "u:other-user/p:recall",
});

export function eventId(ordinal) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new TypeError("event ordinal must be a non-negative safe integer");
  }
  return `ev_${String(ordinal).padStart(26, "0")}`;
}

export function entityDraft(subject, relation, object, options = {}) {
  return { subject, relation, object, ...options };
}

export function literalDraft(subject, relation, objectValue, options = {}) {
  return { subject, relation, object_value: objectValue, ...options };
}

export function statementIntent({
  rawText,
  parsed,
  provenance = "user_stated",
  ttl = "permanent",
  supersedes,
}) {
  return {
    kind: "statement",
    bodyJson: JSON.stringify({
      raw_text: rawText,
      parsed,
      provenance,
      ttl,
      ...(supersedes === undefined ? {} : { supersedes }),
    }),
  };
}

export function claimRetractionIntent(claimId, note) {
  return {
    kind: "retraction",
    bodyJson: JSON.stringify({
      target: { claim_id: claimId },
      ...(note === undefined ? {} : { note }),
    }),
  };
}

export function eventRetractionIntent(targetEventId, cascade) {
  return {
    kind: "retraction",
    bodyJson: JSON.stringify({
      target: {
        event_id: targetEventId,
        ...(cascade === undefined ? {} : { cascade }),
      },
    }),
  };
}

export function mergeIntent(keep, absorb) {
  return { kind: "merge", bodyJson: JSON.stringify({ keep, absorb }) };
}

export function aliasIntent(surface, entityId) {
  return {
    kind: "alias",
    bodyJson: JSON.stringify({ surface, entity_id: entityId }),
  };
}

export function operation(events, {
  scope = PRIMARY_SCOPE,
  at = BASE_TIME,
  label,
} = {}) {
  return {
    scope: { ...scope },
    at,
    label: label ?? `operation-${at}`,
    events,
  };
}

function statement(rawText, parsed, options = {}) {
  return statementIntent({ rawText, parsed, ...options });
}

function one(event, options) {
  return operation([event], options);
}

function scenario(id, operations, projectionBoundary) {
  return { id, operations, projectionBoundary };
}

function hubDrafts(count) {
  return Array.from({ length: count }, (_, index) =>
    entityDraft("Hub", "uses", `Node ${String(index).padStart(2, "0")}`),
  );
}

export function createAdversarialOperations(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new TypeError("adversarial seed must be a non-negative safe integer");
  }
  const operations = [];
  let nextSeq = 1;

  const add = (events, { scope = PRIMARY_SCOPE, label } = {}) => {
    const firstSeq = nextSeq;
    operations.push(
      operation(events, {
        scope,
        at: BASE_TIME + seed + operations.length * 60,
        label: label ?? `seed-${seed}-operation-${operations.length + 1}`,
      }),
    );
    nextSeq += events.length;
    return {
      firstSeq,
      ids: events.map((_, index) => eventId(firstSeq + index)),
    };
  };

  add([
    statement(`seed ${seed} service A`, [
      entityDraft(`Service A ${seed}`, "uses", `Database ${seed}`, {
        subject_kind: "service",
        subject_aliases: [`A-${seed}`],
      }),
    ]),
  ]);
  add([
    statement(`seed ${seed} service B`, [
      entityDraft(`Service B ${seed}`, "uses", `Queue ${seed}`, {
        subject_kind: "worker",
      }),
    ]),
  ]);
  add([aliasIntent(`alias-a-${seed}`, "e1.0")]);
  add([
    statement(`seed ${seed} alias follow-up`, [
      entityDraft(`alias-a-${seed}`, "uses", `Cache ${seed}`),
    ]),
  ]);
  const mergeA = add([mergeIntent("e1.0", "e2.0")]);
  add([claimRetractionIntent("c1.0", "seeded obsolete dependency")]);
  add([
    statement(`seed ${seed} mode v1`, [
      literalDraft(`Runtime ${seed}`, "describes", "v1"),
    ]),
  ]);
  add([
    claimRetractionIntent("c7.0"),
    statement(`seed ${seed} mode v2`, [
      literalDraft(`Runtime ${seed}`, "describes", "v2"),
    ]),
  ], { label: `seed-${seed}-correct-batch` });
  add([
    statement(`seed ${seed} other raw`, [], {
      provenance: "observed",
      ttl: "session",
    }),
  ], { scope: SECONDARY_SCOPE });
  add([
    statement(`seed ${seed} other graph`, [
      entityDraft(`Other Service ${seed}`, "uses", `Other DB ${seed}`),
    ]),
  ], { scope: SECONDARY_SCOPE });
  const otherAlias = add(
    [aliasIntent(`other-alias-${seed}`, "e11.0")],
    { scope: SECONDARY_SCOPE },
  );
  add([eventRetractionIntent(otherAlias.ids[0])], { scope: SECONDARY_SCOPE });
  add([eventRetractionIntent(mergeA.ids[0])]);
  add([
    statement(`seed ${seed} relates`, [
      entityDraft(`Service A ${seed}`, "relates_to", `Feature ${seed}`, {
        relation_label: "configures",
      }),
    ]),
  ]);
  add([
    statement(`seed ${seed} inferred`, [
      entityDraft(`Feature ${seed}`, "uses", `Temporary Store ${seed}`),
    ], { provenance: "inferred", ttl: "weeks" }),
  ]);
  const secondAlias = add([aliasIntent(`login-${seed}`, "e1.0")]);
  add([
    statement(`seed ${seed} second alias follow-up`, [
      entityDraft(`login-${seed}`, "uses", `Session Store ${seed}`),
    ]),
  ]);
  add([eventRetractionIntent(secondAlias.ids[0])]);
  const secondMerge = add([mergeIntent("e1.0", "e2.0")]);
  add([eventRetractionIntent(secondMerge.ids[0])]);
  add([eventRetractionIntent(eventId(10), false)], { scope: SECONDARY_SCOPE });
  const reinterpretRoot = add([
    statement(`seed ${seed} reinterpret root`, [
      literalDraft(`Config ${seed}`, "describes", "root"),
    ]),
  ]);
  const reinterpretLeaf = add([
    statement(`seed ${seed} reinterpret root`, [
      literalDraft(`Config ${seed}`, "describes", "leaf"),
    ], { supersedes: reinterpretRoot.ids[0] }),
  ]);
  add([eventRetractionIntent(reinterpretLeaf.ids[0], false)]);
  add([
    statement(`seed ${seed} reject`, [
      entityDraft(`Service A ${seed}`, "rejects", `Database ${seed}`),
    ]),
  ]);
  add([
    statement(`seed ${seed} contains`, [
      entityDraft(`Service A ${seed}`, "contains", `Module ${seed}`),
    ]),
  ]);
  add([
    statement(`seed ${seed} normalized reinforcement`, [
      entityDraft(`Service_A-${seed}`, "uses", `Database ${seed}`),
    ]),
  ]);
  add([aliasIntent(`confirmed-${seed}`, "e1.0")]);
  add([
    statement(`seed ${seed} session ttl`, [
      entityDraft(`Ephemeral ${seed}`, "uses", `Scratch ${seed}`),
    ], { ttl: "session" }),
  ]);
  add([claimRetractionIntent("c26.0")]);
  add([
    statement(`seed ${seed} other extension`, [
      entityDraft(`Other Extension ${seed}`, "uses", `Other Queue ${seed}`),
    ]),
  ], { scope: SECONDARY_SCOPE });
  const otherMerge = add(
    [mergeIntent("e11.0", "e32.0")],
    { scope: SECONDARY_SCOPE },
  );
  add([eventRetractionIntent(otherMerge.ids[0])], { scope: SECONDARY_SCOPE });
  const finalDescribe = add([
    statement(`seed ${seed} final describes`, [
      literalDraft(`Runtime ${seed}`, "describes", "v3"),
    ]),
  ]);
  add([eventRetractionIntent(finalDescribe.ids[0], false)]);

  while (operations.length < 36) {
    add([
      statement(`seed ${seed} padding ${operations.length}`, [
        entityDraft(
          `Padding ${seed}-${operations.length}`,
          "relates_to",
          `Anchor ${seed}`,
          { relation_label: "pads" },
        ),
      ]),
    ]);
  }
  if (operations.length !== 36) {
    throw new Error("adversarial fixture must contain exactly 36 operations");
  }
  return operations;
}

export function createProjectionScenarioCatalog() {
  const scenarios = [
    scenario("S01", [
      one(statement("인증 서버가 DB를 사용한다", [
        entityDraft("Ａuth_Server", "uses", "Primary-DB", {
          subject_aliases: ["인증 서버"],
        }),
      ]), { at: BASE_TIME + 1 }),
      one(statement("auth server reinforces db", [
        entityDraft("auth server", "uses", "primary db"),
      ]), { at: BASE_TIME + 2 }),
    ], "normalize, surface and statement FTS input"),
    scenario("S02", [
      one(statement("atomic root", [entityDraft("Atomic", "uses", "Store")]), {
        at: BASE_TIME + 10,
      }),
      one(aliasIntent("atomic-alias", "e1.0"), { at: BASE_TIME + 11 }),
      one(eventRetractionIntent(eventId(2)), { at: BASE_TIME + 12 }),
    ], "append, rollback-safe replay and deterministic rebuild"),
    scenario("S03", [
      one(statement("first reinforcement", [
        entityDraft("Worker", "uses", "Queue"),
      ]), { at: BASE_TIME + 20 }),
      one(statement("second reinforcement", [
        entityDraft("worker", "uses", "queue"),
      ]), { at: BASE_TIME + 21 }),
    ], "occurrence anchors, redirects and claim reinforcement"),
    scenario("S04", [
      one(statement("mode v1", [literalDraft("Mode", "describes", "v1")]), {
        at: BASE_TIME + 30,
      }),
      one(statement("mode v2", [literalDraft("Mode", "describes", "v2")]), {
        at: BASE_TIME + 31,
      }),
      one(claimRetractionIntent("c2.0"), { at: BASE_TIME + 32 }),
      one(eventRetractionIntent(eventId(2), false), { at: BASE_TIME + 33 }),
    ], "describes structural replacement and both retraction effects"),
    scenario("S05", [
      one(statement("two facts", [
        entityDraft("Gateway", "uses", "Database"),
        entityDraft("Gateway", "contains", "Router"),
      ]), { at: BASE_TIME + 40 }),
      one(claimRetractionIntent("c1.0"), { at: BASE_TIME + 41 }),
      one(eventRetractionIntent(eventId(1), false), { at: BASE_TIME + 42 }),
    ], "claim and statement retraction scopes"),
    scenario("S06", [
      one(statement("runtime v1", [
        literalDraft("Runtime", "describes", "v1"),
      ]), { at: BASE_TIME + 50 }),
      operation([
        claimRetractionIntent("c1.0"),
        statement("runtime v2", [literalDraft("Runtime", "describes", "v2")]),
      ], { at: BASE_TIME + 51, label: "correct-two-event-batch" }),
    ], "correct as two consecutive atomic journal events"),
    scenario("S07", [
      one(statement("서비스 A", [entityDraft("서비스 A", "uses", "DB")]), {
        at: BASE_TIME + 60,
      }),
      one(statement("service B", [entityDraft("service-a", "uses", "Queue")]), {
        at: BASE_TIME + 61,
      }),
      one(mergeIntent("e1.0", "e2.0"), { at: BASE_TIME + 62 }),
      one(eventRetractionIntent(eventId(3)), { at: BASE_TIME + 63 }),
    ], "merge rewrite, support dedupe, redirect and undo"),
    scenario("S08", [
      one(statement("auth entity", [entityDraft("Auth", "uses", "Session")]), {
        at: BASE_TIME + 70,
      }),
      one(aliasIntent("로그인", "e1.0"), { at: BASE_TIME + 71 }),
      one(eventRetractionIntent(eventId(2)), { at: BASE_TIME + 72 }),
    ], "confirmed alias origin and decision undo"),
    scenario("S09", [
      one(statement("primary scope", [entityDraft("Shared", "uses", "A")]), {
        at: BASE_TIME + 80,
      }),
      one(statement("secondary scope", [entityDraft("Shared", "uses", "B")]), {
        scope: SECONDARY_SCOPE,
        at: BASE_TIME + 81,
      }),
      one(claimRetractionIntent("c1.0"), { at: BASE_TIME + 82 }),
    ], "scope-bound IDs, supports and aggregate inputs"),
    scenario("S10", [
      one(statement("temporary guess", [entityDraft("Auth", "uses", "JWT")], {
        provenance: "inferred",
        ttl: "weeks",
      }), { at: BASE_TIME + 90 }),
      one(statement("observed reinforcement", [entityDraft("Auth", "uses", "JWT")], {
        provenance: "observed",
        ttl: "permanent",
      }), { at: BASE_TIME + 91 }),
      one(statement("explicit rejection", [entityDraft("Auth", "rejects", "JWT")]), {
        at: BASE_TIME + 92,
      }),
    ], "TTL supports and contested aggregate inputs"),
    scenario("S11", [
      one(statement("raw only memory", [], { ttl: "session" }), {
        at: BASE_TIME + 100,
      }),
      one(statement("parsed memory", [entityDraft("Raw", "uses", "Graph")]), {
        at: BASE_TIME + 101,
      }),
      one(claimRetractionIntent("c2.0"), { at: BASE_TIME + 102 }),
    ], "raw statement lifetime and parsed claim non-resurrection"),
    scenario("S12", [
      one(statement("auth uses session", [entityDraft("Auth", "uses", "Session")]), {
        at: BASE_TIME + 110,
      }),
      one(statement("session contains token", [
        entityDraft("Session", "contains", "Token"),
      ]), { at: BASE_TIME + 111 }),
      one(statement("auth test command", [
        literalDraft("Auth Test", "describes", "pnpm test"),
      ]), { at: BASE_TIME + 112 }),
    ], "bidirectional graph links and literal collection input"),
    scenario("S13", [
      one(statement("hub fanout", hubDrafts(31)), { at: BASE_TIME + 120 }),
    ], "hub projection with more than the initial fanout cap"),
    scenario("S14", [
      one(statement("root interpretation", [
        literalDraft("Config", "describes", "root"),
      ], { provenance: "observed", ttl: "weeks" }), { at: BASE_TIME + 130 }),
      one(claimRetractionIntent("c1.0"), { at: BASE_TIME + 131 }),
      one(statement("root interpretation", [
        literalDraft("Config", "describes", "successor"),
      ], {
        provenance: "observed",
        ttl: "weeks",
        supersedes: eventId(1),
      }), { at: BASE_TIME + 132 }),
    ], "reinterpret metadata order and earlier claim retraction cutoff"),
    scenario("S15", [
      one(statement("root describes", [literalDraft("Mode", "describes", "root")]), {
        at: BASE_TIME + 140,
      }),
      one(statement("later describes", [literalDraft("Mode", "describes", "later")]), {
        at: BASE_TIME + 141,
      }),
      one(statement("root describes", [
        literalDraft("Mode", "describes", "reinterpreted"),
      ], { supersedes: eventId(1) }), { at: BASE_TIME + 142 }),
      one(eventRetractionIntent(eventId(3), false), { at: BASE_TIME + 143 }),
    ], "backdated reinterpret ordering and successor undo"),
    scenario("S16", [
      one(statement("approval root", [
        entityDraft("Approval", "relates_to", "Draft", {
          relation_label: "requires approval for",
        }),
      ], { provenance: "inferred", ttl: "weeks" }), { at: BASE_TIME + 150 }),
      one(statement("approval root", [
        entityDraft("Approval", "relates_to", "Bound Draft", {
          relation_label: "requires approval for",
        }),
      ], {
        provenance: "inferred",
        ttl: "weeks",
        supersedes: eventId(1),
      }), { at: BASE_TIME + 151 }),
    ], "projection effect after a separately validated approval"),
    scenario("S17", [
      one(statement("service A mode", [
        literalDraft("서비스 A", "describes", "one"),
      ]), { at: BASE_TIME + 160 }),
      one(statement("service B mode", [
        literalDraft("service-a", "describes", "two"),
      ]), { at: BASE_TIME + 161 }),
      one(mergeIntent("e1.0", "e2.0"), { at: BASE_TIME + 162 }),
    ], "merge with competing describes and structural ordering"),
    scenario("S18", [
      one(statement("token [REDACTED] and safe claim", [
        entityDraft("Security Review", "contains", "Safe Finding"),
      ]), { at: BASE_TIME + 170 }),
    ], "already-masked raw text and accepted partial projection input"),
    scenario("S19", [
      one(statement("overview auth", [entityDraft("Auth", "uses", "Session")]), {
        at: BASE_TIME + 180,
      }),
      one(statement("overview worker", [entityDraft("Worker", "uses", "Queue")]), {
        at: BASE_TIME + 181,
      }),
      one(statement("overview config", [literalDraft("Config", "describes", "v1")]), {
        at: BASE_TIME + 182,
      }),
    ], "deterministic overview source projection"),
    scenario("S20", [
      one(statement("writer A", [entityDraft("Concurrent", "uses", "A")]), {
        at: BASE_TIME + 190,
      }),
      one(statement("writer B", [entityDraft("Concurrent", "uses", "B")]), {
        scope: SECONDARY_SCOPE,
        at: BASE_TIME + 191,
      }),
    ], "serialized writes and scope-safe WAL reader projection"),
    scenario("S21", [
      one(statement("auth root", [entityDraft("Auth Service", "uses", "DB")]), {
        at: BASE_TIME + 200,
      }),
      one(aliasIntent("로그인", "e1.0"), { at: BASE_TIME + 201 }),
      one(statement("alias follow-up", [entityDraft("로그인", "uses", "Cache")]), {
        at: BASE_TIME + 202,
      }),
    ], "confirmed alias resolves a later statement"),
    scenario("S22", [
      one(statement("surface source", [
        entityDraft("Search Entry", "uses", "Graph", {
          subject_aliases: ["검색"],
        }),
      ]), { at: BASE_TIME + 210 }),
      one(claimRetractionIntent("c1.0"), { at: BASE_TIME + 211 }),
      one(statement("fallback raw text", [], { ttl: "permanent" }), {
        at: BASE_TIME + 212,
      }),
    ], "surface without a live claim and raw FTS source"),
    scenario("S23", createAdversarialOperations(23),
      "seeded state transitions and metamorphic projection invariants"),
    scenario("S24", [
      one(statement("crash baseline v1", [
        literalDraft("Crash Value", "describes", "v1"),
      ]), { at: BASE_TIME + 230 }),
      one(statement("crash candidate v2", [
        literalDraft("Crash Value", "describes", "v2"),
      ]), { at: BASE_TIME + 231 }),
    ], "old-or-complete-new process crash recovery projection"),
  ];

  if (
    scenarios.length !== 24 ||
    scenarios.some((entry, index) => entry.id !== `S${String(index + 1).padStart(2, "0")}`)
  ) {
    throw new Error("projection scenario catalog must contain S01 through S24 exactly once");
  }
  return scenarios;
}

export { BASE_TIME };
