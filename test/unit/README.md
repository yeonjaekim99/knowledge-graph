# Unit tests

IO 없는 domain/application test만 둔다. 공통 규칙은 [`../README.md`](../README.md)를 따른다.

PRJ-003의 occurrence candidate, canonical 선택, redirect registry와 rules dry-run fixture는
[`domain/prj-003-occurrence-redirects.test.mjs`](domain/prj-003-occurrence-redirects.test.mjs)에
둔다. 이 fixture는 실제 SQLite projection이나 사건 reducer 완료를 주장하지 않는다.

PRJ-004의 event retraction, supersedes graph, effective metadata/order와 actual occurrence
anchor fixture는
[`domain/prj-004-event-pre-scan.test.mjs`](domain/prj-004-event-pre-scan.test.mjs)에 둔다.
12,000단계 cycle/cascade fixture는 stack 안전성만 확인하며 release 성능 판정은 별도
performance 계층이 소유한다. 이 fixture도 entity/claim reducer나 SQLite publish 완료를
주장하지 않는다.

PRJ-005의 모든 statement occurrence anchor, live entity/surface/kind reduce, 다의 surface
해석과 철회 범위 fixture는
[`domain/prj-005-entity-surface-kind.test.mjs`](domain/prj-005-entity-surface-kind.test.mjs)에
둔다. confirmed origin은 resolver primitive까지 검증하며 실제 alias/merge event와 claim
rewrite, SQLite publish 완료를 주장하지 않는다.

PRJ-006/007의 structural claim/support와 merge·alias 결과에 PRJ-008 effective expiry를 붙이는
fixture는 [`domain/prj-008-ttl-validity.test.mjs`](domain/prj-008-ttl-validity.test.mjs)에 둔다.
raw-only, reinterpret, merge support, 기본 TTL, freeze·결정성과 redacted failure를 검증하되
aggregate SQL과 실제 DB read-only는 SQLite integration 계층이 소유한다.

REC-001의 `application/rec-001-record-contract.type-test.ts`는 JSON Schema에서 추론한 record
DTO가 relation enum, trusted input과 accepted/rejected result branch drift를 compile 단계에서
거부하는지 확인한다. 비판별 XOR와 재해석 pair의 최종 판정은 runtime contract fixture가
소유한다.
