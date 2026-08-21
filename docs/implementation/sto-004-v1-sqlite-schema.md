# STO-004: bundled v1 SQLite schema

- 상태: Accepted
- 결정일: 2026-08-21
- 작업: STO-004
- Owner: `log0629`
- PR: [#16](https://github.com/yeonjaekim99/knowledge-graph/pull/16)
- 규범 근거: ADR-001, ADR-002, ADR-005, ADR-007
- 규범 관계: ADR을 대체하지 않는 implementation decision

## 기존 증거와 production gap

ADR 전체 리뷰의 `E-SQL`과 behavior spike S01은 Python SQLite에서 규범 DDL, contentless
trigram FTS, 한국어 3글자/2글자 경계, rebuild와 제약이 성립함을 확인했다. 이 결과는
선택한 Node driver로 배포되는 migration file, STO-003 checksum 이력과 실제 file-backed
실패 fixture를 구현한 증거는 아니다.

STO-004는 이 production gap만 닫는다. normalize, journal append, projection reducer,
철회·TTL을 반영한 recall query와 MCP startup 조립은 후속 작업의 책임으로 남긴다.

## 결론

첫 physical schema를 UTF-8 SQL asset 하나로 고정하고 STO-003의 managed writer migration
runner에 연결한다.

```text
src/.../migrations/001-v1-schema.sql
  → build가 byte-for-byte로 dist에 복사
  → bundled loader가 배포 asset의 exact byte를 읽음
  → STO-003이 SHA-256/history를 검증하고 BEGIN IMMEDIATE 안에서 적용
  → version 1, name v1_schema
```

SQL을 TypeScript 문자열로 다시 적지 않는다. source와 배포 asset을 별도로 직렬화하면
줄바꿈이나 escaping 차이로 checksum의 기준 byte가 모호해지기 때문이다. build script는
`copyFileSync`로 migration asset을 그대로 복사하고 loader는 `import.meta.url` 기준으로
배포 위치를 찾는다. asset을 읽을 수 없으면 path나 driver cause를 노출하지 않는
`MIGRATION_BUNDLE_INVALID`로 실패한다.

적용된 `001-v1-schema.sql`은 수정하지 않는다. schema 변경은 version 2 이상의 새 SQL
asset과 registry entry로만 추가한다.

## schema 책임과 순서

최종 v1 database의 규범 객체는 다음 소유권으로 만들어진다.

| 객체 | 생성 책임 | 규범 |
|---|---|---|
| `schema_migrations` | STO-003 runner bootstrap | ADR-001 |
| `journal`, `idx_journal_scope` | v1 migration | ADR-001 |
| `journal_fts`, `journal_ai` | v1 migration | ADR-005 |
| `statements`, `entities`, `surface_forms`, `claims`, `claim_support`와 인덱스 | v1 migration | ADR-007 |
| `id_redirects`, `idx_redirect_new` | v1 migration | ADR-002 |
| `projection_meta` | v1 migration | ADR-001 |

`schema_migrations`는 v1 SQL 안에서 중복 생성하지 않는다. STO-003 runner가 동일한
`BEGIN IMMEDIATE` transaction 안에서 ADR-001 DDL로 이 table을 먼저 bootstrap하고, 이어서
v1 SQL과 history row를 함께 commit한다. 최종 schema와 rollback 경계는 규범과 같고 두
writer path도 생기지 않는다.

v1 SQL은 `IF NOT EXISTS`를 사용하지 않는다. version 1 적용 중 같은 객체가 이미 있다면
부분 schema를 정상 상태로 오인하지 않고 migration 전체를 rollback해 startup을 막는다.

## contentless FTS와 rebuild

`journal_fts`는 `content=''`, `tokenize='trigram'`인 contentless FTS5 table이다. statement
INSERT trigger만 있으며 `rowid = journal.seq`, indexed text는 `body.raw_text`다. journal이
append-only이므로 UPDATE/DELETE trigger는 두지 않는다. FTS column을 읽으면 `NULL`이고
원문은 항상 journal에서 읽는다.

유실·손상 시 rebuild 절차는 ADR-005 순서를 그대로 사용한다.

```sql
INSERT INTO journal_fts(journal_fts) VALUES('delete-all');
INSERT INTO journal_fts(rowid, raw_text)
SELECT seq, json_extract(body, '$.raw_text')
FROM journal
WHERE kind = 'statement'
ORDER BY seq;
INSERT INTO journal_fts(journal_fts) VALUES('optimize');
```

선택한 SQLite 3.53.4와 `better-sqlite3` 13.0.3에서 한국어 연속 3 code point는 MATCH되고
2 code point query는 결과가 없는 경계를 실제 file DB로 고정한다. 철회·supersede·TTL
필터링은 FTS 자체 책임이 아니며 RCL-003의 journal/projection join이 판정한다.

## 제약과 실패 의미

DDL과 integration fixture는 다음 불변식을 DB에서도 강제한다.

- journal kind와 JSON body, statement state/provenance, surface origin, claim relation/state,
  support live, redirect kind/reason/self-redirect를 CHECK한다.
- claim의 `object_id`와 `object_value`는 정확히 하나만 존재한다.
- root entity normal name, active entity/value claim identity와 active `describes`는 partial
  unique index로 중복을 막는다. retracted/superseded history는 같은 identity를 가질 수 있다.
- claim support는 `(claim_id,event_id)`와 `(event_id,draft_index)`를 각각 유일하게 한다.
- statement는 journal event를, projection reference는 실제 entity/claim/statement를 FK로
  가리킨다. 특히 support의 event FK는 journal이 아니라 `statements(event_id)`를 가리켜
  alias/merge event가 claim 근거가 되는 것을 막는다.

실패 fixture는 managed writer transaction을 통해 실제 constraint violation과 rollback을
관찰한다. 모든 정상·실패 fixture 뒤 `PRAGMA foreign_key_check`가 빈 결과인지 확인한다.

## 대안

### TypeScript string으로 SQL embedding

배포 asset 누락 가능성은 줄지만 source file byte와 실행 byte가 달라질 수 있고 SQL review도
불편해 선택하지 않았다. build가 SQL file을 그대로 복사하고 clean archive에서 asset 존재와
동일 byte를 검증한다.

### external-content FTS

`journal.body` JSON 안의 `raw_text`를 FTS content column에 직접 대응할 수 없어 trigger와
rebuild 의미가 복잡해진다. ADR-005가 확정한 contentless table을 사용한다.

### query view까지 v1 migration에 포함

aggregate, traversal과 recall filtering은 reducer/query 의미가 확정되는 Phase 03·06의
책임이다. physical table과 FTS만 먼저 고정해 아직 구현하지 않은 의미를 schema에
선점하지 않는다.

## 범위 경계

- STO-005~006이 trusted scope와 actor/branch/session metadata를 제공한다.
- STO-007이 append-only journal API와 statement/FTS transaction을 구현한다.
- Phase 03이 이 빈 projection schema를 채우는 reducer와 full replay를 구현한다.
- RCL-003이 live statement, TTL과 safe FTS query를 결합한다.
- STO-008/REL-004가 process recovery와 다중 client 부하를 검증한다.
- MCP-001이 startup gate → connection factory → bundled migration 성공 뒤 tool을 노출한다.

따라서 S01 manifest는 normalize와 recovery owner가 남아 있어 아직 `planned`를 유지한다.

## 검증

```bash
pnpm test:sto-004
pnpm test:sto-003
pnpm verify:local
python3 docs/roadmap/validate.py
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py'
pnpm audit --prod
```

STO-004 integration test는 exact source/dist byte와 checksum, 정상 reopen, 모든 규범
table/column/index/trigger와 FK 대상, statement-only contentless FTS, 한국어 경계,
delete-all/rebuild/optimize, partial unique/XOR/CHECK/FK 실패와 `foreign_key_check`를 검증한다.

## ADR 영향 검토

- ADR-001: append-only journal, projection metadata와 migration history의 최종 DDL을 구현한다.
- ADR-002: kind가 분리된 redirect와 self-redirect 금지를 구현한다.
- ADR-005: contentless trigram FTS, statement INSERT trigger와 rebuild 경계를 구현한다.
- ADR-007: 최종 projection column, identity/cardinality index와 FK를 구현한다.

Accepted ADR의 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
