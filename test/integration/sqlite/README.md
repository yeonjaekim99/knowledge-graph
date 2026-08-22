# SQLite integration tests

실제 임시 SQLite file, migration, WAL과 transaction을 검증한다. 공통 규칙은
[`../../README.md`](../../README.md)를 따른다.

STO-002의 [`sto-002-connection-factory.test.mjs`](sto-002-connection-factory.test.mjs)는
개별 reader close가 완료되면 factory ownership에서 제거되고, 반복 close와 동시 factory
close가 같은 in-flight worker 종료를 기다리는 lifecycle도 검증한다.

PRJ-008의 [`prj-008-claim-aggregate.test.mjs`](prj-008-claim-aggregate.test.mjs)는 공통
valid-support source가 diagnostic view와 scope/fixed-now TEMP aggregate에서 같은 결과를
내는지 검증한다. expiry·label·contested 경계, cross-scope corruption invariant와 TEMP 조회
전후 영구 row/data version 불변만 소유하며 실제 recall transaction은 RCL-001에 남긴다.

RCL-001의 [`rcl-001-recall-snapshot.test.mjs`](rcl-001-recall-snapshot.test.mjs)는 worker-backed
readonly WAL connection 하나에서 `BEGIN DEFERRED`와 scope/fixed-now
`TEMP recall_claim_agg`의 생성·소비·정리를 한 요청 경계로 묶는다. 동시 writer commit 전후의
고정 snapshot, explicit aggregate alias, 두 scope 격리, exact expiry, callback 실패 cleanup,
journal/projection/FTS dump와 외부 `data_version` 불변 및 손상 row의 payload-redacted 거부를
검증한다.

RCL-002의 [`rcl-002-query-surface.test.mjs`](rcl-002-query-surface.test.mjs)는 같은 reader
transaction에서 parameterized scope/surface exact lookup과 필요한 entity/redirect closure만
읽어 canonical seed를 만드는지 검증한다. 다의 surface, 다른 scope 동명 row 제외, chain,
51→50 절단, concurrent WAL commit 전후 snapshot, persistent dump/`data_version` 불변과 cycle
오류 cleanup을 포함한다.
