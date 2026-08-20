# ADR-007: 재생 규칙과 사건별 처리 순서

- 상태: Accepted
- 결정일: 2026-08-20
- 소유 영역: 초기 설계 3.1, 3.3, 9장 재생 동기/비동기 항목
- 선행 ADR: ADR-001, ADR-002, ADR-003, ADR-004
- Supersedes: 초기 설계 3.1의 불완전한 claim_support DDL

## Context

재생은 현재 상태를 복원하는 핵심 알고리즘이다. 단순히 사건을 한 번 순방향 적용하면
나중의 retraction이 앞선 merge/alias를 무효화할 때 이미 적용한 구조 변경을 되돌리기
어렵다. 또한 statement 하나의 여러 draft 중 어떤 draft가 claim을 지원하는지 저장하지
않으면 최신 relation_label 집계와 ID를 정확히 재구성할 수 없다.

쓰기 직후 조회가 옛 상태를 보는 것을 허용할지, 모든 사건에 전체 재생을 적용할지도
확정해야 한다.

## Decision

### 투영 스키마

다음 테이블은 모두 projector 소유의 파생물이다. `statements.created_at`,
`provenance`, `expires_at`과 `order_seq`는 재해석 승계를 반영한 **effective 값**이다.

```sql
CREATE TABLE statements (
  event_id    TEXT PRIMARY KEY REFERENCES journal(id),
  scope_key   TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('live','retracted','superseded')),
  order_seq   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  provenance  TEXT NOT NULL
    CHECK (provenance IN ('user_stated','observed','inferred')),
  expires_at  INTEGER
);

CREATE INDEX idx_statements_live
  ON statements(scope_key) WHERE state = 'live';

CREATE TABLE entities (
  id          TEXT PRIMARY KEY,
  scope_key   TEXT NOT NULL,
  name        TEXT NOT NULL,
  normal_name TEXT NOT NULL,
  kind        TEXT,
  merged_into TEXT REFERENCES entities(id),
  origin_seq  INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_entities_normal
  ON entities(scope_key, normal_name) WHERE merged_into IS NULL;

CREATE TABLE surface_forms (
  scope_key    TEXT NOT NULL,
  surface_norm TEXT NOT NULL,
  entity_id    TEXT NOT NULL REFERENCES entities(id),
  origin       TEXT NOT NULL
    CHECK (origin IN ('name','agent_supplied','confirmed')),
  PRIMARY KEY (scope_key, surface_norm, entity_id)
);

CREATE INDEX idx_surface_lookup
  ON surface_forms(scope_key, surface_norm);

CREATE TABLE claims (
  id             TEXT PRIMARY KEY,
  scope_key      TEXT NOT NULL,
  subject_id     TEXT NOT NULL REFERENCES entities(id),
  relation       TEXT NOT NULL
    CHECK (relation IN ('uses','rejects','contains','describes','relates_to')),
  object_id      TEXT REFERENCES entities(id),
  object_value   TEXT,
  state          TEXT NOT NULL
    CHECK (state IN ('active','superseded','retracted')),
  origin_seq     INTEGER NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  CHECK ((object_id IS NULL) <> (object_value IS NULL))
);

CREATE UNIQUE INDEX idx_claim_identity_entity_active
  ON claims(scope_key, subject_id, relation, object_id)
  WHERE state='active' AND object_id IS NOT NULL;

CREATE UNIQUE INDEX idx_claim_identity_value_active
  ON claims(scope_key, subject_id, relation, object_value)
  WHERE state='active' AND object_value IS NOT NULL;

CREATE TABLE claim_support (
  claim_id    TEXT NOT NULL REFERENCES claims(id),
  event_id    TEXT NOT NULL REFERENCES statements(event_id),
  draft_index INTEGER NOT NULL,
  live        INTEGER NOT NULL DEFAULT 1 CHECK (live IN (0,1)),
  expires_at  INTEGER,
  PRIMARY KEY (claim_id, event_id),
  UNIQUE (event_id, draft_index)
);

CREATE INDEX idx_support_event ON claim_support(event_id);

CREATE INDEX idx_claims_subject
  ON claims(subject_id, relation) WHERE state='active';

CREATE INDEX idx_claims_object
  ON claims(object_id, relation)
  WHERE state='active' AND object_id IS NOT NULL;

CREATE UNIQUE INDEX idx_claims_describes_single
  ON claims(scope_key, subject_id)
  WHERE state='active' AND relation='describes';
```

`id_redirects`와 `projection_meta`는 각각 ADR-002와 ADR-001의 DDL을 사용한다.
`origin_seq`는 claim ID를 처음 발급한 journal seq이며 effective created_at과 다르다.
`first_seen_at`/`last_seen_at`은 UTC epoch 초의 유효 역사 시각이다.
claim_support의 event FK는 support가 statement 사건에서만 생긴다는 규칙을 DB에서도
강제한다.

### 전체 재생의 두 단계

전체 재생은 하나의 `BEGIN IMMEDIATE` 트랜잭션에서 scope 단위로 수행한다.

#### 1단계: 효력 계산

저널을 검증하며 다음 집합을 먼저 계산한다.

- event-level retraction이 가리키는 statement/merge/alias event ID. statement의
  `cascade=true`는 그 시점까지 존재하는 supersedes chain 전체로 확장한다.
- retraction되지 않은 statement의 supersedes edge
- 각 statement의 최종 `live`, `retracted`, `superseded` 상태
- 재해석 statement의 effective order_seq/created_at/provenance/ttl
- 모든 parsed occurrence의 실제 event seq 기반 entity/claim candidate ID registry

retraction 사건은 자신보다 작은 seq의 사건만 가리킬 수 있고 다른 retraction 사건을
가리킬 수 없다. 이 제약으로 “철회의 철회” 재귀를 금지한다. retracted statement는
superseded보다 우선해 `retracted` 상태가 된다. 활성 superseder가 철회되면 그 대상
statement는 `cascade=false`이고 다른 활성 superseder가 없는 경우에만 다시 `live`가
된다. cascade=true면 chain 구성원 모두 retracted다.

일반 statement의 order_seq는 자기 journal seq다. supersedes chain의 모든 statement는
최초 root statement의 seq를 order_seq로 갖는다. active leaf가 있으면 **leaf의 parsed
payload와 leaf 실제 seq에서 유도한 candidate ID를 root order_seq 위치에 놓는다.** root와
중간 statement payload는 의미 stream에 넣지 않는다. 이렇게 ID는 새 해석 사건에
고정하면서도 오래된 재해석이 그 뒤의 결정·철회를 최신 write처럼 덮지 못하게 한다.

#### 2단계: 결정적 reduce

scope의 투영 행을 FK 순서에 맞춰 비운 뒤 1단계의 candidate registry를 만들고 의미
event stream을 순서대로 적용한다. live statement leaf는 order_seq, retraction/merge/alias는
실제 journal seq에 놓는다. 같은 root에는 live leaf가 최대 하나이고 다른 사건의 실제
seq와 root seq가 같을 수 없으므로 순서가 하나로 정해진다.

- 모든 statement는 실제 event seq 기준 ID anchor 보존을 위해 candidate를 등록하고
  support 행을 만든다. statement가 의미 stream의 live leaf가 아니면 support의
  `live=0`으로 시작하며 entity/claim ID anchor 외의 카디널리티·활성화 side effect는
  적용하지 않는다.
- statement의 effective TTL을 `statements.expires_at`에 투영하고 각 support의
  `expires_at`에도 같은 값을 복사한다. parsed=[]도 statement expiry를 가지므로 raw
  recall이 TTL을 우회하지 않는다.
- 1단계에서 retracted인 merge와 alias 사건은 적용하지 않는다.
- claim-level retraction은 대상 claim에서 `statement.order_seq < retraction.seq`인
  support의 `live`를 0으로 만든다. 따라서 나중에 append된 과거 statement 재해석도 이미
  그 뒤에 있었던 철회를 우회하지 않는다. retraction보다 큰 order_seq의 새 일반
  statement가 같은 사실을 진술하면 그 support는 live다.
- event-level statement retraction은 pre-scan에서 선택한 exact event 또는 supersedes
  chain의 모든 support를 0으로 만든다.
- merge와 alias의 구체 처리 규칙은 ADR-008을 따른다.
- describes 강화·대체와 claim 상태 결정은 ADR-009를 따른다.
- reduce가 끝나면 support와 statement state를 기준으로 active claim에 live support가
  있는지, active describes가 하나뿐인지와 last_seen_at을 검증·정합화한다. 이 단계는
  앞선 `describes` 대체의 `superseded` 상태를 support만 보고 되돌리지 않는다.
  claim 철회는 대체 사건의 과거 side effect를 취소하지 않고, event 철회만 1단계에서
  그 statement 전체를 제외하기 때문이다. 정확한 상태 전이는 ADR-009를 따른다.
  relation_label은 ADR-010이 유효 support에서 읽을 때 계산한다.

이 두 단계 때문에 뒤에 있는 retraction이 앞의 merge를 “계속 진행하면서 취소”하는
모호함이 없다. 전체 재생 시작 전에 해당 merge가 비활성임을 안다.

### 증분 적용과 전체 재생 선택

| 새 사건/변경 | 처리 |
|---|---|
| 일반 statement | 증분 reduce |
| supersedes statement | scope 전체 재생 |
| claim_id retraction | 증분 reduce |
| event_id retraction | scope 전체 재생 |
| 새 merge | 증분 reduce |
| 새 alias | 증분 reduce |
| rules_version 변경 | 영향 scope 전체 재생 |
| 투영 무결성/last_seq 불일치 | scope 전체 재생 |

두 경로는 같은 reducer 함수와 동일한 정렬/동일성 규칙을 사용한다. 증분 결과와 전체
재생 결과가 다르면 구현 버그다.

### 동기 일관성

v1의 모든 write tool은 journal append와 위 투영 처리를 같은 트랜잭션에서 동기 수행한
뒤 반환한다. full replay가 필요한 revise는 더 느릴 수 있지만 성공 응답 뒤 read-your-
writes를 보장한다. 비동기 projector는 도입하지 않는다.

## Alternatives

### 순방향 한 번만 재생하며 즉시 undo

merge가 이미 facts와 surface를 합친 뒤 이를 정확히 분리하는 역연산이 복잡하고 새
규칙에서도 보장하기 어렵다. event 효력을 pre-pass로 계산한다.

### 모든 사건을 항상 전체 재생

정확하지만 평범한 record의 비용이 journal 크기에 비례한다. 안전한 사건은 증분
적용하고 과거 의미를 바꾸는 사건만 전체 재생한다.

### 비동기 projector와 stale read 허용

지연은 낮지만 revise 성공 직후 이전 기억을 답할 수 있다. v1의 정확성 목표와 맞지
않는다.

### claim_support에 draft_index를 저장하지 않음

statement 하나의 여러 draft를 역으로 찾기 위해 JSON 전체를 추측해야 하고
relation_label 집계가 모호하다. 저장된 parsed index를 투영에 명시한다.

## Consequences

- merge/alias 철회가 전체 재생 후 정확히 재현된다.
- event-level retraction은 scope journal 크기에 비례하는 쓰기 지연을 일으킨다.
- 투영 스키마는 journal보다 자주 바뀔 수 있으며 마이그레이션 후 재생하면 된다.
- write transaction이 길어질 수 있으므로 busy 오류와 성능 metric이 필요하다.
- reducer는 모든 정렬과 tie-break를 명시적으로 구현해야 한다.

## Validation

- 각 사건 prefix를 증분 적용한 결과와 같은 prefix 전체 재생 결과가 같아야 한다.
- merge/alias event를 뒤에서 철회한 fixture가 처음부터 그 event가 없었던 것과 같은
  현재 투영을 만들어야 한다. journal history 자체는 달라야 한다.
- active superseder를 cascade=false로 철회하면 원 statement가 live로 복구되고, 기본
  cascade=true 철회에서는 chain 전체가 retracted여야 한다.
- A→B describes 뒤 B claim만 철회하면 A는 superseded로 남고, B statement event를
  철회하면 A가 active로 복구돼야 한다.
- order_seq 1의 statement, seq 2의 claim 철회, seq 3의 reinterpret successor fixture에서
  successor support도 철회 상태여야 한다.
- event-level retraction이 retraction이나 미래 event를 가리키면 INSERT 전에 거부해야 한다.
- DDL 적용 후 `PRAGMA foreign_key_check`가 빈 결과여야 한다.

## References

- 초기 설계 3.1, 3.3, 9장 재생 시점 항목
- ADR-001, ADR-002, ADR-008, ADR-009, ADR-017
