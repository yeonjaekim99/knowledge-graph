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

RCL-001의
[`application/rcl-001-recall-snapshot-service.test.mjs`](application/rcl-001-recall-snapshot-service.test.mjs)는
request-scoped runtime을 정확히 한 번 캡처하고 application이 raw SQL/connection 대신 TEMP
유효 claim 전용 typed capability만 받는지 검증한다. 잘못된 scope/epoch는 DB를 열기 전에
payload를 보관하지 않는 typed error로 닫는다.

REC-002의 provider signature, Unicode code-point entropy, context-bound allowlist와 UTF-16
slice 위치 fixture는
[`domain/rec-002-secret-detector.test.mjs`](domain/rec-002-secret-detector.test.mjs)에 둔다.
이 fixture는 internal punctuation을 유지하는 공백 단위 entropy segmentation과 symbolic
branch/trusted Git object context 분리, pure detector 결과가 class·위치만 반환하는 경계까지
검증한다. application scan-before-write, raw 마스킹, draft 거부, journal write와 log/MCP
통합은 REC-003/MCP-005/REC-008에 남긴다.

REC-003의 [`application/rec-003-record-sanitizer.test.mjs`](application/rec-003-record-sanitizer.test.mjs)는
detector의 UTF-16 위치를 raw class marker로 치환하고 모든 draft 문자열을 ADR 순서로
검사한다. 안전한 draft의 immutable clone과 원래 input index, draft별 actionable 거부,
위치·결과 손상과 detector 예외 fail-closed, 재해석의 부분 성공 금지를 검증한다.
`application/rec-003-record-sanitizer.type-test.ts`는 이 중간 plan의 readonly/type-only package
경계를 확인한다. SQLite append/project와 public tool 응답 조립은 이 unit의 범위가 아니다.

RCL-002의 [`domain/rcl-002-query-surface.test.mjs`](domain/rcl-002-query-surface.test.mjs)는
explicit/query-derived term의 Unicode code-point 순서, distinct display phrase와
cap-before-dedupe, PRJ-002 normalize/ill-formed UTF-16 경계, canonical redirect chain·다의
surface·50+1·손상 fail-closed를 검증한다.
[`application/rcl-002-query-surface.test.mjs`](application/rcl-002-query-surface.test.mjs)와
compile fixture는 같은 정책이 RCL-001 snapshot callback의 typed `resolveSurfaceSeeds`만 쓰고
raw SQL/connection capability를 얻지 못하는지 검증한다.

RCL-003의 [`application/rcl-003-fts-query.test.mjs`](application/rcl-003-fts-query.test.mjs)는
제어 문자 제거, quote doubling, 최대 10개 OR phrase, normalize_v1 기반 Unicode 3 code point
gate와 중복 제거를 IO 없이 검증한다. `rcl-003-fts-candidates.type-test.ts`는 후속 recall 단계가
raw SQL 대신 seed/reached/raw/truncation의 좁은 snapshot capability만 소비하도록 compile
경계를 고정한다.
