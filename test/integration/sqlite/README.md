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
같은 normalized lookup을 가진 distinct display term의 first-pair dedupe, 51→50 절단,
concurrent WAL commit 전후 snapshot, persistent dump/`data_version` 불변과 cycle 오류 cleanup을
포함한다.

RCL-003의 [`rcl-003-fts-fallback.test.mjs`](rcl-003-fts-fallback.test.mjs)는 같은 snapshot에서
bound quoted phrase로 STO-004 contentless FTS를 검색하고 current-scope live/unexpired statement
중 graph/raw eligible 21개를 읽어 20개만 변환하는지 검증한다. operator·quote·control·한국어·emoji,
combining/compatibility code-point 경계, entity/literal
endpoint seed와 reached pin, raw TTL/state와 죽은 parsed claim 비부활, 동일 raw graph duplicate,
NFKC-equivalent 별도 phrase와 정확한 matched term, suppressed raw/dead parsed cap 비소비, 저장
원문의 앞뒤 공백 보존, 반복 order, WAL snapshot, 영구 dump/data_version 및 Proxy/accessor를
포함한 payload-redacted corruption을 포함한다. same-scope live·unexpired aggregate support의
invalid draft index는 fail closed하고 dead·expired·cross-scope 대조군은 정상적으로 제외하며,
typed Proxy error identity와 임의 payload도 adapter 밖으로 전달하지 않는다. bounded 21개 모두의
support를 검증하므로 used parsed candidate의 support 누락과 malformed 21번째 sentinel은 실패하고,
정상 sentinel은 truncation 확인에만 쓰이며 앞 20개 결과에는 들어가지 않는다.

REC-004의
[`rec-004-write-entity-resolver.test.mjs`](rec-004-write-entity-resolver.test.mjs)는 managed
writer가 `BEGIN IMMEDIATE`를 보유한 동안 surface 전체 후보→redirect terminal→exact
normal-name 순서로 entity를 해석하는지 검증한다. ambiguity는 nested draft savepoint만
되돌리고, scope 밖 후보는 노출하지 않으며, `INSERT OR IGNORE` 충돌 뒤 재조회로 수렴한다.
해석용 provisional entity/surface/redirect는 append 전에 outer savepoint로 전부 되돌려
journal 없는 projection-only commit 경로가 생기지 않게 한다.

[`rec-004-write-entity-finalization.test.mjs`](rec-004-write-entity-finalization.test.mjs)는 다른
scope의 journal까지 포함한 DB-global AUTOINCREMENT 다음 seq, ambiguity·REC-005 survivor 제거 뒤
compact occurrence ID, exact finalization/append body와 actual seq binding을 검증한다. kind의 독립
trim→NFKC→lowercase 경계, ambiguity candidate의 중복·numeric order·shape와
`sqlite_sequence` drift도 payload를 노출하지 않고 fail-closed하는지 확인한다. input/result
Proxy·accessor와 session call/rejection/thenable은 원본 message·cause·prefix·suffix를 버린 새
고정 error가 된다. Promise subclass/custom `Symbol.species`가 만든 반환 객체도 public
resolve/finalize Promise로 노출하지 않고 native async settlement bridge에서 폐기하며, 성공은
검증·동결하고 settlement 실패는 새 고정 오류로 바꾼다. factory 의미를 가진 오류도 원본
identity·poisoned prototype·transparent Proxy를 재사용하지 않고 allowed code/retry own
descriptor에서 fresh canonical `SqliteConnectionError`로 복원하며, invalid code를 거부하고
`SQLITE_BUSY` retry metadata를 유지하는지도 고정한다.
