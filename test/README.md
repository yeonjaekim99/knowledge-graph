# Recall 로컬 테스트 계층

이 디렉터리는 Recall v1의 로컬 TDD 구조다. 기본 빠른 suite와 별도 성능 suite의 단일
기계 판독 원본은 [`test-layers.json`](test-layers.json)이며, 자동 CI workflow는 사용하지
않는다.

## 계층

| 계층 | 책임 | 금지 경계 |
|---|---|---|
| `foundation` | architecture, runtime, schema와 test infrastructure 자체 | 제품 상태 의미 구현 |
| `unit` | IO 없는 domain/application 정책 | SQLite, process, MCP transport |
| `integration/sqlite` | 실제 임시 DB file, migration, WAL, transaction | in-memory DB로 file 의미 대체 |
| `integration/projection` | journal prefix, 증분 적용과 독립 full replay parity | spike 구현 import·복사 |
| `contract/mcp` | 실제 SDK catalog/schema/structuredContent와 protocol | application fake만으로 transport 통과 주장 |
| `e2e/process` | child process, hard exit, reopen, 동시 client | 같은 process exception으로 crash 대체 |
| `performance` | 대표 10만 규모 p50/p95와 query plan | 기본 빠른 suite에 포함하지 않음 |

로컬 명령은 다음과 같다.

| 명령 | 범위 |
|---|---|
| `pnpm test` | performance를 제외한 빠른 전체 suite |
| `pnpm test:foundation` | foundation 계약 |
| `pnpm test:unit` | unit |
| `pnpm test:integration` | SQLite + projection integration |
| `pnpm test:contract` | MCP contract |
| `pnpm test:e2e` | process e2e |
| `pnpm test:performance` | 명시적 performance |
| `pnpm test:prj-001` | scope full replay와 canonical projection 계약 |
| `pnpm test:prj-002` | 정규화·리터럴 identity·relation registry와 locale fixture |
| `pnpm test:prj-003` | occurrence ID·canonical 선택·redirect와 rules dry-run |
| `pnpm test:prj-004` | 사건 효력 pre-scan·supersedes·retraction과 effective stream |
| `pnpm test:prj-005` | entity anchor·surface 해석·kind 선택과 ambiguity fixture |
| `pnpm test:prj-006` | claim/support·카디널리티·철회와 structural 시각 |
| `pnpm test:prj-007` | merge·alias·claim rewrite와 decision undo |
| `pnpm test:prj-008` | effective TTL과 실제 SQLite aggregate·scope/invariant |
| `pnpm test:prj-009` | 증분 dispatcher·full replay·atomic publish·commit gate |
| `pnpm test:prj-010` | S01~S24 projection prefix, S23 288-prefix metamorphic, S24 process crash |
| `pnpm test:rec-001` | record input/draft/result schema, Unicode scalar·trim bounds와 result index 계약 |
| `pnpm verify:rec-001` | architecture/type/build, FND-004 회귀와 REC-001 target |
| `pnpm test:rcl-001` | recall input/result 계약, request snapshot과 scope/fixed-now TEMP aggregate |
| `pnpm test:rec-002` | versioned secret signature·entropy·allowlist와 safe positional result |
| `pnpm test:rec-003` | record raw 마스킹, draft 부분 거부와 재해석 전체 실패 경계 |
| `pnpm verify:rec-003` | architecture/type과 REC-001~003 계약·탐지·sanitizer 회귀 |
| `pnpm test:rcl-002` | ordered display query term, canonical scoped surface seed와 50+1/read-only fixture |
| `pnpm typecheck:rcl-002` | RCL-002 typed seed port와 raw SQL 비노출 compile fixture |
| `pnpm verify:rcl-002` | RCL-002 architecture/type/build와 focused target |
| `pnpm test:rcl-003` | safe quoted FTS와 graph/raw candidate 변환·21/20·read-only fixture |
| `pnpm verify:rcl-003` | architecture/type/build와 RCL-003 unit·SQLite target |
| `pnpm verify:local` | architecture, type, build와 빠른 전체 suite |

## TDD 순서

1. roadmap에서 owner와 선행 작업을 확인하고 대상 계층에 관찰 가능한 실패 test를 쓴다.
2. 대상 계층 명령으로 기대한 이유의 RED를 확인한다.
3. 그 test를 통과시키는 최소 production 변경을 만든다.
4. 대상 계층을 다시 GREEN으로 만든 뒤 `pnpm test`로 빠른 전체 회귀를 실행한다.
5. 성능 소유 작업만 fixture 생성 시간을 제외하고 `pnpm test:performance`를 별도로 실행한다.

RED는 잘못된 import나 fixture 오류가 아니라 아직 없는 제품 동작 때문에 실패해야 한다.
PR에는 RED 원인과 최종 GREEN 명령을 남긴다. test는 production public/application seam을
black-box로 사용하며 [`spikes/adr-behavior`](../spikes/adr-behavior/README.md)를 import하거나
제품 구조로 복사하지 않는다.

## 결정적 실행

로컬 runner는 child Node process에 `TZ=UTC`, `LANG=C`, `LC_ALL=C`, 고정 seed·clock과
명시적 `en-US` locale을 주입한다. test가 다른 시간이 필요하면 ambient clock을 읽지 말고
[`deterministic-test-context.mjs`](support/deterministic-test-context.mjs)의 offset을 쓴다.
실패 재현 정보는 scenario ID, seed, prefix, clock, timezone과 locale만 포함하며 event
payload, secret, 절대 DB 경로를 포함하지 않는다.

## ADR scenario 이전

[`adr-production-scenarios.json`](manifests/adr-production-scenarios.json)은 S01~S24 각각의
후속 black-box test 경로, 계층과 roadmap owner를 고정한다. `planned`는 production test가
아직 없다는 뜻이다. 실제 소유 작업은 먼저 target test를 RED로 만들고 구현한 뒤 같은
PR에서 `implemented`로 바꾼다. source matrix checksum이나 ADR/task 연결 drift는 foundation
test가 거부한다.

증분/full replay parity는 공통 harness만 제공한다. 실제 journal, SQLite projection과
reducer는 PRJ 작업에서 별도로 구현하며 Python spike는 독립 oracle로 남는다.

PRJ-001은 production SQLite에서 reducer의 scope·seq·rules 입력, 한 writer transaction의
scope 교체, meta replay 판정과 canonical dump를 구현했다. 아직 사건별 reducer와 증분
dispatcher가 없으므로 S02/S24 target은 `planned`이며 PRJ-009/010에서만 전환한다.

PRJ-002는 domain의 `normalize_v1`, literal identity와 immutable relation registry를
구현하고 C/Turkish locale process fixture로 결정성을 확인했다. 아직 entity/claim reducer가
이 primitive를 소비하지 않으므로 S01/S03 target은 `planned`이며 PRJ-005/006/010에서만
전환한다.

PRJ-003은 저장된 draft occurrence 후보 ID, numeric canonical 선택, scope/kind가 고정된
redirect 압축과 rules 변경 dry-run을 domain unit fixture로 구현했다. 실제 event reducer와
SQLite publish가 아직 없으므로 S03/S07/S23/S24 target은 후속 owner가 production 경로에
연결하고 prefix parity를 검증할 때까지 기존 상태를 유지한다.

PRJ-004는 한 scope journal의 event retraction과 supersedes graph를 pre-scan해 live leaf
payload를 root order에 놓고 실제 occurrence ID·recorded 시각을 보존한다. S14/S15의 이
부분은 domain unit fixture로 검증하지만 claim/support·describes reducer와 SQLite prefix
parity가 남아 있으므로 두 scenario target은 `planned`를 유지한다.

PRJ-005는 모든 실제 statement의 entity anchor를 유지하면서 live statement만 surface와
kind에 기여시키고, redirected surface 전체 canonicalization·exact-name tie-break·ambiguity를
순수 reducer fixture로 검증한다. 실제 merge/alias 사건, record preflight, claim rewrite와
SQLite prefix parity가 남아 있어 S08/S21 target은 `planned`를 유지한다.

PRJ-006/007은 claim/support 구조 상태와 merge·alias rewrite를 순수 reducer로 검증한다.
PRJ-008은 그 structural output에 effective expiry를 붙이는 domain fixture와 실제 file SQLite의
공통 aggregate SQL fixture를 함께 둔다. PRJ-009는 이 reducer를 atomic dispatcher/publish와
연결했다. S09~S11/S19의 public recall target은 RCL owner가 끝낼 때까지
`planned`를 유지한다.

PRJ-010은 S01~S24의 journal-reducible 이력을 실제 dispatcher에 누적하고 각
operation prefix를 별도 full production reducer와 canonical byte로 비교한다. S23의
288 prefix·metamorphic과 S24의 8개 hard-exit/reopen target은 `implemented`다.
Record/Revise/Recall 출력을 요구하는 S01~S22의 나머지 vertical target은 각 owner가
완결할 때까지 `planned`를 유지한다.

REC-001은 FND-004의 frozen Draft 2020-12 source와 SDK validator를 재사용해 record input,
독립 ClaimDraft와 typed result를 검증한다. contract fixture는 trim 후 Unicode code-point
경계와 모든 free-form input의 well-formed scalar 조건, 목적어 XOR, 재해석 pair, trusted
metadata 금지와 input/result index coverage를 검증하며 secret 탐지, DB 해석과 journal write
완료를 주장하지 않는다.

RCL-001은 실제 MCP SDK validator가 search/overview 입력과 RecallResult 닫힌 union을 같은
Draft 2020-12 source에서 검증하는 contract fixture, trusted runtime snapshot을 정확히 한 번
소비하는 application fixture, 실제 WAL reader의 deferred transaction·TEMP aggregate를 검증하는
SQLite fixture를 추가했다. term/FTS/overview/traversal/ranking/Answer 조합은 후속 RCL 작업의
소유이므로 S09/S10/S19 manifest는 아직 `planned`다.

REC-002는 [`unit/domain/rec-002-secret-detector.test.mjs`](unit/domain/rec-002-secret-detector.test.mjs)에서
IO 없는 versioned signature/entropy detector를 검증한다. fixture는 실제 credential이 아닌
형식 전용 synthetic 값만 사용하고, 결과·typed error가 탐지 문자열을 보유하지 않는지
검사한다. internal punctuation entropy segmentation, 임의 64-hex branch와 verified local Git
object context 분리도 여기서 고정한다. application scan-before-write, 마스킹, draft 부분 거부와
transaction rollback은 REC-003 이후 수직 경로가 소유하므로 이 unit suite가 S18 production
target 완료를 주장하지 않는다.

REC-003은 [`unit/application/rec-003-record-sanitizer.test.mjs`](unit/application/rec-003-record-sanitizer.test.mjs)에서
REC-001 입력과 REC-002 위치 결과를 연결한다. raw hit의 class 치환, 위치 불명확 시 전체
마스킹, 모든 ClaimDraft 저장 문자열의 독립 거부, 원래 input index 보존과 재해석 전체
실패를 IO 없는 application 경계에서 검증한다. 실제 journal/FTS write와 projection rollback,
metadata/revise 및 공개 MCP log 누출 검사는 REC-006/008, REV와 MCP-005가 소유한다.

RCL-002는 PRJ-002의 normalize와 PRJ-003/007 canonical redirect primitive를 재사용해 explicit
term 또는 query 전체+Unicode 문자/숫자 run을 deterministic seed로 바꾼다. domain fixture는
code-point 순서, 같은 norm의 distinct display phrase, cap-before-dedupe, ill-formed UTF-16,
redirect corruption과 50+1을, application/compile fixture는
RCL-001 typed capability와 raw SQL 비노출을, 실제 SQLite fixture는 scope·snapshot·read-only를
검증한다. FTS/BFS/Answer가 아직 없으므로 S09/S21 public scenario status는 바꾸지 않는다.

RCL-003은 user candidate를 최대 10개 quoted phrase literal로 만들고 제어 문자 제거·trim 뒤
실제 phrase 3 code point 미만을 actionable skip으로 분리하는 application fixture, 실제
contentless trigram FTS와
RCL-001 TEMP aggregate를 같은 snapshot에서 읽는 SQLite fixture를 추가했다. NFKC-equivalent
display phrase의 별도 MATCH와 정확한 matched term, graph support의 subject/object seed와
depth-0 reached pin, parsed=[] raw-only, 죽은 parsed history 비부활, 동일 raw valid graph 우선,
저장 원문 공백 보존, ineligible row가 cap을 소비하지 않는 eligible 21/20 절단과 persistent
dump/data_version 불변을 검증한다. 최종 Answer와 overview가 아직 없으므로 S11/S22 manifest는
`planned`다.
