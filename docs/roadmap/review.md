# 구현 로드맵 자체 리뷰

- 리뷰일: 2026-08-23
- 대상: `docs/roadmap/`, evidence-gap audit, root README, contributor guide와 agent instruction 진입 파일
- 기준: Accepted ADR-001~017, ADR 전체 리뷰, behavior spike S01~S24
- 성격: 작성자 자체 교차 검토, PR #3~#49 누적 게시·로컬 검증, 2026-08-23 scope 재검토와
  REC-004/RCL-006 독립 review·보완·최종 재검토
- 결과: **Phase 01·02·03 종료 · REC-001~004/RCL-001~006 완료 · REC-005 진행**

## 검토 결과

| 검토 축 | 결과 | 근거 |
|---|---|---|
| 작업 구조 | 통과 | 준비 7개 + active 제품 66개, retired stable ID 1개, active heading과 현황 행 1:1 |
| 의존성 | 통과 | 00→01→02→03 이후 record/recall 병렬, revise와 MCP/release gate 순서 일치 |
| ADR coverage | 통과 | ADR-001~017 모두 구현 작업과 production 검증 작업에 연결 |
| spike coverage | 통과 | S01~S24 모두 production 회귀 소유 작업에 연결 |
| 협업 상태 모델 | 통과 | stable ID, 단일 owner, 네 상태, blocker와 PR evidence 규칙 명시 |
| 에이전트 진입 계약 | 통과 | root `AGENTS.md` 단일 원본, `CLAUDE.md` import, roadmap 선확인 규칙 |
| evidence-gap | 통과 | historical 제품 ID 67개 각각 baseline, production gate 또는 범위 제외를 1회 대조 |
| 범위 통제 | 통과 | snapshot/cache/어휘/정규화 등 측정 전 결정은 Deferred로 격리 |
| 현재 상태 정확성 | 통과 | active 제품 구현 34/66, Phase 01·02·03과 REC-001~004/RCL-001~006 `DONE`, REC-005 진행, FND-006은 registry에 retired |

## 중점 검토와 반영 사항

1. 초기 설계 문구가 아니라 Accepted ADR을 기준으로 task를 만들었다. 특히 record는 반복 시
   support가 늘어 `idempotentHint:false`이고, relation_label은 claim column이 아니라 유효
   aggregate에서 계산하며, replay는 pre-scan+reduce 두 단계다.
2. claim 철회와 statement event 철회의 `describes` 복구 차이, 재해석 root order/effective
   metadata, cascade=false undo와 payload-bound approval을 별도 완료 체크로 고정했다.
3. spike에서 나온 네 production 위험을 [추적성 표](traceability.md)에 독립 귀속했다.
   aggregate SQL alias, ASCII token 경계, occurrence index, migration reopen checksum이 구현
   중 사라지지 않는다.
4. 성능 숫자는 구현 초반의 직감으로 닫지 않는다. 대표 baseline과 10만 규모 release
   fixture를 분리하고, 3회 연속 trigger 전 snapshot/cache 도입을 금지했다.
5. 공동 작업에서는 phase별 planning PR로 ready 작업을 배정하고, 구현 PR이 체크·증거·
   roll-up을 함께 갱신하도록 해 owner 중복과 문서 후행을 줄였다.
6. root `AGENTS.md`를 공통 규칙의 단일 원본으로 두고 Claude Code는 `CLAUDE.md`의
   `@AGENTS.md` import로 같은 계약을 읽게 했다. 현재 task를 규칙 파일에 고정하지 않고
   roadmap에서 조회하게 해 진행 상태의 이중 원본을 만들지 않았다.
7. 기존 roadmap은 spike 증거가 traceability에 있어도 task 시작 관점의 잔여 gap을 바로
   보여주지 못했다. historical 제품 ID 67개를 다시 대조해 baseline 감사 `[x]`와 production
   `TODO/DONE`을 분리했고, FND-001은 선택한 driver/SDK 조합의 검증만 요구하도록 고쳤다.
8. maintainer 결정으로 FND-006 자동 CI 작업을 active 범위에서 제외했다. ID는 registry와
   evidence audit에 보존하고, 로컬 test/기여 절차는 FND-005와 FND-007이 소유하도록 했다.
9. FND-005는 자동 CI 없이도 같은 TDD 경계를 공유하도록 7개 로컬 계층, 고정 실행 문맥,
   S01~S24 이전 manifest와 canonical replay parity harness를 추가했다. 24개 target은 처음
   `planned`로 두고 후속 owner를 고정했으며, STO-008에서 완결된 S20만 `implemented`가 됐다.
10. FND-007은 exact runtime·frozen install부터 roadmap/TDD/PR 인계까지 한 기여 문서로
    연결했다. test와 실험 DB는 OS 임시 경로 또는 ignore된 `/.recall/`에 격리하고,
    network filesystem·다중 writer process 및 production 경로 구현은 후속 작업과 분리했다.
11. STO-001은 실제 file DB 경로에서 local filesystem·권한을 먼저 검사하고 readonly TEMP
    query로 FTS5·trigram·JSON·`unixepoch()` readiness를 발급한다. S01 전체를 완료로
    오인하지 않도록 영구 FTS/rebuild·normalize와 WAL/connection 경계는 후속 owner에 남겼다.
12. STO-002는 synchronous driver를 writer/reader worker에 격리하고 process당 writer
    factory 하나와 FIFO `BEGIN IMMEDIATE` queue를 구현했다. 실제 5초 lock 중에도 reader와
    main event loop가 진행하며 오류에는 path·SQL·binding·driver cause가 남지 않는다.
    migration/schema와 journal/projector atomicity는 후속 owner에 남겼고, S20의 storage
    8-client 범위는 STO-008에서 완료됐다. 실제 MCP load는 REL-004에 남아 있다.
13. STO-003은 exact-byte checksum과 immutable version history를 같은 managed writer
    transaction에 두고 정상·hard-exit reopen을 검증했다. 이후 STO-004/007/008이 schema,
    journal append와 storage recovery를 닫았고 실제 MCP startup과 projector recovery는 남아 있다.
14. STO-004는 규범 v1 DDL을 별도 SQL asset으로 bundle하고 contentless trigram FTS, 한국어
    3글자/2글자 경계, rebuild와 partial unique/XOR/CHECK/FK를 실제 file DB에서 검증했다.
    append/recovery는 STO-007/008에서 닫았고 normalize, projector/recall 의미와 startup 조립은
    후속 owner에 남아 있다.
15. STO-005는 project를 immutable deployment config로 고정하고 local explicit user와 remote
    authenticated principal을 분리한 zero-argument scope provider를 구현했다. ID 누락·형식
    오류·mode 혼합은 값이나 cause를 노출하지 않고 실패하며, 실제 authentication과 tool
    lifecycle 조립은 MCP-001/006에 남겼다.
16. STO-006은 observed client name, configured Git worktree와 optional session HMAC을
    zero-argument metadata provider에 묶었다. detector-backed sanitizer를 필수 dependency로
    두고 field별 실패를 NULL로 격리했으며, 최초 full gate에서 새 test 경로가 빠진 문제도
    발견 즉시 canonical foundation layer로 옮겨 81/81에 포함했다.
17. STO-007은 신뢰 runtime snapshot과 validated event envelope만 받는 private append surface를
    만들고, guarded CTE 한 문장으로 non-empty batch와 statement/FTS를 원자적으로 기록한다.
    기존 ID가 하나라도 있으면 노출 전 batch 전체 후보를 최대 네 번 다시 만들며, 리뷰에서
    accessor 미평가와 noncanonical runtime ID 거부까지 추가해 preflight 신뢰 경계를 닫았다.
18. STO-008은 IPC barrier로 journal INSERT 전·후와 commit 뒤 hard exit를 분리하고 production
    reopen에서 migration/FK/seq/ID/FTS와 후속 append를 확인했다. 한 managed writer를 공유하는
    4 logical writer+4 WAL reader로 S20을 `implemented`로 전환했으며, projection fault point가
    남은 S24를 `planned`로 유지해 storage 증거를 전체 crash parity로 과장하지 않았다.
19. PRJ-001은 reducer 입력을 한 scope의 정렬 journal과 rules version으로 제한하고 worker가
    `BEGIN IMMEDIATE`를 보유한 채 scope projection을 원자 교체하도록 했다. meta·rules·seq 판정,
    실패 rollback, WAL reader old snapshot과 독립 canonical dump를 검증하면서 normalize·ID·
    pre-scan은 PRJ-004에서 닫았고, 증분 dispatcher와 S02/S24 전체 parity는 후속 PRJ owner에 남겼다.
20. PRJ-002는 Accepted ADR 순서의 `normalize_v1`, 별도 literal identity와 immutable relation
    registry를 domain 단일 원본으로 만들었다. C/Turkish locale process fixture, 빈 값과
    Unicode label 경계를 검증하면서 entity/claim reducer와 S01/S03 완료는 후속 owner에 남겼다.
21. PRJ-003은 저장된 parsed index와 subject→entity object occurrence 위치에서 후보 ID를
    계산하고 numeric earliest와 explicit merge keep을 분리했다. redirect를 최종 target으로
    압축하면서 source/target scope·kind, self/dangling/cycle과 32-hop을 fail-closed로 검증하고,
    many-to-one 계획과 one-to-many 전체 배포 차단을 쓰기 없는 dry-run으로 고정했다. 실제
    event pre-scan은 PRJ-004에서 닫았고 entity/claim reducer, DB publish와 S03/S07/S23/S24
    parity는 후속 owner에 남겼다.
22. PRJ-004는 event retraction과 supersedes graph를 projection write 전에 검증하고 모든
    statement occurrence anchor를 보존하면서 live reinterpret leaf를 root order/effective
    metadata에 놓는다. spike 대조 리뷰에서 중간 `cascade:false` split과 재귀 stack 소진을
    추가 RED로 발견해 direct-child leaf·반복형 traversal로 수정했다. S14/S15의 claim/support,
    describes와 SQLite prefix parity는 완료로 올리지 않고 PRJ-006/009/010에 유지했다.
23. PRJ-005는 모든 actual statement occurrence의 parsed identity anchor를 보존하고 live
    effective statement만 surface/kind에 기여시키는 순수 reducer를 추가했다. 모든 surface
    candidate를 redirect terminal로 해석한 뒤 exact normal-name 하나만 tie-break로 허용하고,
    남은 ambiguity는 임의 선택 없이 fail closed한다. confirmed origin과 후속 entity 해석은
    primitive까지 검증했지만 실제 alias event·철회와 record/revise/SQLite parity가 남아
    S08/S21은 `planned`를 유지했다.
24. PRJ-006은 모든 actual draft에 claim/support anchor를 만들고 canonical entity를 포함한
    identity의 numeric-earliest ID를 상태와 무관하게 재사용한다. `describes` 선 supersede,
    claim cutoff와 event 철회 복원, backdated reinterpret와 effective first/last seen을 독립
    fixture로 고정했다. TTL aggregate·merge/alias·SQLite prefix parity는 PRJ-007~010에 남겨
    structural reducer 통과를 전체 projection 완료로 과장하지 않았다.
25. PRJ-007은 final-ID 사후 치환이 merge 전 상태 전이를 훼손하는 반례를 근거로 statement,
    claim 철회, merge와 alias를 같은 의미 stream에서 줄인다. explicit keep과 numeric claim
    survivor, surface origin·support dedupe와 describes 승자를 보존하고 decision event 철회 뒤
    후속 statement까지 처음부터 사건이 없었던 결과로 복원한다. 리뷰에서 철회된 duplicate의
    activation 오염과 merge 방향 no-op/cycle을 추가 RED로 고쳤다. TTL aggregate·SQLite publish와
    full prefix parity는 PRJ-008~010에 남겨 S07/S08/S17/S21을 성급히 완료로 올리지 않았다.
26. PRJ-008은 effective createdAt에서 TTL을 계산해 raw-only를 포함한 모든 statement와
    support에 같은 expiry를 투영한다. 하나의 valid-support CTE에서 diagnostic view와
    scope/fixed-now TEMP query를 만들고 count·strongest·last_seen·latest label·expiry·contested를
    같은 집합에 묶었다. 리뷰에서 cross-scope support 손상과 exact expiry 경계를 추가해
    aggregate fail-closed, invariant 탐지와 영구 DB read-only를 확인했다. 실제 publish와
    full prefix/public recall은 PRJ-009/010·RCL에 남겨 S09~S11/S19/S23을 완료로 올리지 않았다.
27. PRJ-009는 PRJ-004~008을 canonical snapshot reducer로 조립하고 안전 suffix는 증분 row
    publish, supersedes/event retraction과 meta·rules·invariant drift는 scope replay로 분기했다.
    worker가 journal·FTS·projection·meta를 하나의 `BEGIN IMMEDIATE`에서 commit하며 active
    support, describes, expiry, redirect, FK와 last_seq를 gate한다. 리뷰에서 multi-event projection
    실패 rollback, ID collision, 기존·신규 reader와 다른 scope 보존을 추가했다. 전체 S01~S24
    prefix/metamorphic/process crash parity는 PRJ-010에 남겨 Phase 03 종료를 성급히 선언하지 않았다.
28. PRJ-010은 journal로 환원 가능한 S01~S24의 98 operation prefix를 실제 SQLite dispatcher와
    독립 full production reducer로 대조하고, S23 8×36 prefix와 batch/scope/time/undo
    metamorphic 관계를 고정했다. 별도 child process를 8개 transaction 지점에서 `SIGKILL`해
    reopen old/complete-new 원자성과 후속 write를 검증했다. manifest는 이 작업이 완결한
    S23/S24만 `implemented`로 전환하고 S01~S22 공개 수직 경로는 REC/REV/RCL에 남겼다.
29. REC-001은 FND-004의 frozen source와 SDK validator를 재사용해 record/ClaimDraft/result
    계약을 네 목적어·relation branch와 일반/재해석 input branch로 고정했다. trim 후 Unicode
    bounds는 원문을 바꾸지 않는 schema pattern과 독립 code-point 방어 검증으로 대조하고,
    trusted scope/metadata 입력, XOR·label·pair 오류를 draft `rejected`가 아닌 whole-request
    contract error로 분리했다. result는 accepted/rejected branch와 입력 index 전단사,
    `superseded_previous > created > reinforced` 우선순위를 검증하되 detector/entity/dedupe,
    journal/project와 MCP wiring은 REC-002~008/MCP owner에 남겼다. 독립 peer review의 package
    root Low finding도 별도 fix commit으로 닫고 전체 243/243을 재검증한 [PR #32](https://github.com/yeonjaekim99/knowledge-graph/pull/32)를 완료 증거로 고정했다.
30. RCL-001은 search/overview와 RecallResult의 닫힌 Draft 2020-12 schema를 실제 SDK validator와
    inferred type에 연결하고 trusted scope/evaluationNow를 한 번 캡처하는 typed application
    read capability를 만들었다. STO-002 reader worker의 한 `BEGIN DEFERRED` 안에서 PRJ-008 source를
    scope/fixed-now TEMP aggregate로 materialize하고 모든 column을 명시적으로 alias했다. 리뷰에서
    concurrent WAL commit 중 claims join도 이전 snapshot을 유지하는 fixture, callback 실패 cleanup,
    손상 ID fail-closed, trimmed Unicode 4,096자와 hops 상한, journal/projection/FTS dump·외부
    data_version 불변을 추가했다. term/FTS, traversal/ranking/Answer와 S09/S10/S19 public
    golden은 RCL-002~008에 남겼다. 독립 리뷰에서 depth 3 frontier incident의 반대 entity를
    path에 덧붙이면 `hops=4`가 된다는 ADR-012 경계를 확인해 output 상한을 4로 정정하고 5를
    거부하는 contract 회귀를 추가했다. MCP SDK가 Standard Schema를 직접 소비할 때 AJV default
    annotation이 값을 채우지 않는 경계도 merge review에서 확인해, direct validate와 helper를
    같은 canonical default 경로로 묶고 overview에는 불필요한 depth가 생기지 않게 고정했다.
    매 recall 뒤 닫힌 reader가 factory Set에 남는 강참조도 제거하되 worker close 완료 전에는
    ownership을 유지하고, 반복 reader close와 factory close가 같은 종료 Promise를 기다리게 했다.
    advertised query schema의 raw `maxLength`와 runtime 선-trim 의미도 독립 SDK compile 회귀로
    발견해 padding을 제외한 Unicode 4,096자 경계를 schema source 자체에 표현했다. 최종 독립
    review와 255/255 통합 회귀에서 미해결 finding이 없었고 [PR #34](https://github.com/yeonjaekim99/knowledge-graph/pull/34)를
    완료 증거로 고정했다.
31. REC-002는 `secret-detector-v1`의 explicit provider registry와 Unicode code-point entropy를
    분리하고 ASCII lookaround로 한국어 조사·문장부호 인접 class를 보존한다. UUID/ULID와
    commit·checksum·build false positive는 field/context와 모양에 묶고, local Git object
    확인은 pure domain 밖의 trusted seam으로 남겼다. result는 UTF-16 slice 위치와 class만
    freeze하며 주입된 detector 예외도 payload/cause 없는 typed failure로 닫는다. 이 증거는
    IO·writer dependency가 없는 pure detector까지만 닫고, application scan-before-write와
    raw 마스킹·draft 부분 거부는 REC-003, transaction·log/DB/FTS scan은 REC-008과 MCP-005에
    남겼다. 공식 provider prefix 확장 corpus도 REL-005에 남겼다. root·독립 review에서는 exact-20 token의
    양끝 기호를 제거해 놓치던 fail-open, quoted/namespaced assignment, empty-user credential
    URL, complete/truncated PEM masking 범위, marker delimiter·Unicode boundary와 actor/branch
    allowlist 우회를 tests-only RED로 고정했다. trimmed allowlist를 보존하면서 원래 run을
    보수적으로 재평가하고, masking consumer가 interval만으로 전체 credential을 제거할 수 있게
    signature 범위를 닫았다. 최종 268/268 회귀와 미해결 HIGH/MEDIUM 0건을 확인한
    [PR #36](https://github.com/yeonjaekim99/knowledge-graph/pull/36)을 완료 증거로 고정해
    제품 roll-up을 27/66으로 올렸다.
32. REC-003은 REC-001의 schema-valid 입력과 REC-002의 class/UTF-16 위치만 받는 detector를
    writer 없는 pure application 경계에서 연결한다. raw hit는 뒤에서 앞으로 class marker로
    치환하고 위치·순서·Unicode 경계가 손상되면 원문 전체를 가린다. 모든 draft 저장 문자열을
    끝까지 검사해 detector 장애를 숨기지 않으며, 안전 draft는 immutable clone과 원래 input
    index로 전달하고 hit draft만 actionable rejected로 분리한다. detector 호출 전 raw·mode와
    draft/alias를 snapshot해 주입 구현이 caller-owned 값을 바꿔도 검사값과 plan이 갈리지 않는다.
    detector result와 finding도 exact data descriptor로만 snapshot해 accessor를 실행하지 않는다.
    독립 review에서 같은 typed error 객체에 message·cause·임의 payload를 붙여 던지면 그대로
    재throw되는 누출을 확인했고, detector 예외는 종류와 무관하게 새 고정 오류로 치환하도록
    16/17 RED에서 17/17 GREEN으로 닫았다.
    재해석은 raw-only만 예외로
    허용하고 한 draft라도 거부되면 successor plan 전체를 만들지 않는다. journal/FTS append,
    duplicate/stored index·occurrence와 projection 원자성 및 전체 log/DB leak scan은 REC-005~008에
    남겨 unit sanitizer 증거를 수직 경로 완료로 과장하지 않는다. 최종 독립 재검증과
    285/285 회귀를 통과한 [PR #38](https://github.com/yeonjaekim99/knowledge-graph/pull/38)을 완료 증거로 고정해 제품 roll-up을 28/66으로 올렸다.
33. RCL-002는 명시 terms 또는 query 전체·문자/숫자 run을 원문 표시형과 source order로
    보존한 뒤 cap을 적용하고, surface 단계에서만 `(surface_norm, entity_id)`와 canonical
    entity를 first-occurrence로 정리한다. 이 순서로 같은 normalize 결과의 구두점·NFKC
    phrase를 FTS에 넘길 수 있고 반복 후보가 cap 밖 seed를 끌어오는 refill도 막는다. 같은
    RCL-001 snapshot 안에서 scope-local polysemy, redirect terminal과 50+1 절단을 읽기
    전용으로 해석한다. 독립 review에서 발견한 표시 후보 소실·cap 순서와 malformed UTF-16
    SQLite 변환을 tests-only RED로 고정하고, recall과 record의 모든 자유 문자열을 Unicode
    scalar 경계로 맞췄다. 최신 main 재베이스 뒤 302/302 전체 회귀와 미해결 finding 0건을
    확인한 [PR #39](https://github.com/yeonjaekim99/knowledge-graph/pull/39)을 완료 증거로
    고정해 제품 roll-up을 29/66으로 올렸다.
34. RCL-003은 실제 표시 term을 bound FTS phrase literal로만 전달하고 eligible graph/raw
    statement를 정렬한 뒤 21개까지 읽어 20개만 결과로 쓴다. truncation sentinel까지 최대
    2,100 support를 전부 decode·검증해 missing/out-of-range 손상을 숨기지 않으며,
    live·unexpired valid graph의 endpoint와 원 claim을 seed/reached로 고정한다. parsed=[]만
    raw로 허용하고 죽은 parsed 원문과 같은 raw_text graph 중복은 우회 반환하지 않는다.
    독립 review에서 eligible cap, 실제 code-point gate, Proxy·typed-error smuggling과 21번째
    sentinel 누락을 tests-only RED로 닫았고 RCL-002의 distinct display `term.text` handoff를
    semantic rebase에서 보존했다. 최종 323/323 회귀와 독립 review HIGH/MEDIUM/LOW 0건을
    확인한 [PR #41](https://github.com/yeonjaekim99/knowledge-graph/pull/41)을 완료 증거로
    고정해 제품 roll-up을 30/66으로 올렸다.
35. REC-004는 PRJ-005의 surface 전체 후보→redirect terminal→exact-name resolver를 기존
    PRJ-009 managed writer transaction의 append 전 단계에 연결했다. draft별 nested savepoint는
    object ambiguity가 그 draft의 subject/alias stage를 남기지 않게 하고, outer savepoint는
    해석용 projection INSERT를 journal append 전에 전부 되돌린다. constraint collision 뒤
    same-scope 재조회, cross-scope redaction, kind·alias homonym 보존과 append 없는 commit 차단을
    file-backed fixture로 검증했다. 독립 review에서 scope-local seq/caller candidate와
    rejected·duplicate occurrence position, kind validator와 ambiguity result boundary를 찾아
    worker-owned DB-global seq와 REC-005 survivor finalization, exact body/actual seq binding으로
    보완했다. dedupe survivor 선택·stored index는 REC-005, public record 조립은 REC-006에
    남긴다. 재검토에서 input/result Proxy·accessor와 fake session이 payload-bearing 오류 객체를
    그대로 내보내는 경계를 찾아 descriptor-only snapshot, fresh input/result error와 canonical
    SQLite error 의미 보존으로 닫았다. 최종 독립 review에서 canonical own shape의 poisoned
    prototype·transparent Proxy가 원본 identity로 재노출되고 invalid runtime code도 통과하는
    경계를 찾아 tests-only 33개 중 28 pass/5 fail RED로 고정했다. allowed code/retry descriptor만
    읽어 fresh canonical error를 재구성하고 `SQLITE_BUSY` retry metadata를 보존해 33/33 GREEN으로
    닫았다. 이어진 review는 임의 rejected note payload, 원본 draft와 다른 object ID presence·
    rejected field를 허용하는 MEDIUM 경계와 kind lone surrogate를 허용하는 LOW를 찾았다.
    tests-only `39c4a00`으로 27/35 RED를 고정하고 expected-draft parity, subject/object별 고정
    note 재구성과 adapter/worker Unicode scalar 검사 `cb5f2ec`으로 35/35 GREEN을 만들었다.
    최신 main semantic rebase 뒤 독립 재검토는 session Promise subclass의 custom
    `Symbol.species` 반환 객체가 public resolver의 Promise와 settlement를 대체하는 MEDIUM을
    찾았다. tests-only `b179166`으로 36/42 RED를 고정하고, native async settlement bridge
    `68ff959`가 species 반환 객체를 폐기하며 성공 결과를 검증·동결하고 실패를 fresh fixed 또는
    fresh canonical SQLite error로 변환해 42/42 GREEN을 만들었다. 새 독립 최종 review는
    HIGH/MEDIUM/LOW 0건과 focused 50/50을 재현했다.
    REC-003·RCL-002·RCL-003 완료와 RCL-004·RCL-005 planning이 반영된 최신 main의
    script·evidence와 RCL-001/RCL-002/RCL-003 snapshot 공존을 함께 검증했다.
    [PR #43](https://github.com/yeonjaekim99/knowledge-graph/pull/43)이 구현·review·전체 회귀와
    상태 증거를 함께 고정해 제품 roll-up을 31/66으로 올렸다.
36. RCL-004는 RCL-001의 같은 scope/now snapshot에 typed overview facet을 추가해 유효 incident
    수·최근성·숫자 entity ID 순으로 10+1 entity seed를 고르고, parsed=[] raw-only 후보를
    limit+1로 읽되 같은 원문의 유효 graph가 있으면 억제한다. 독립 review에서 sync·Promise·hostile
    thenable 오류가 payload-bearing 원 객체를 유지하는 MEDIUM을 찾아 13/15 RED로 고정했고,
    guarded invocation/await와 fresh fixed error로 15/15 GREEN을 만들었다. REC-004 병합 뒤 최신
    main semantic rebase에서 writer/reader worker seam과 REC-005 planning을 함께 보존했고,
    post-rebase 독립 최종 review HIGH/MEDIUM/LOW 0건 및 전체 388/388을 확인했다.
    [PR #45](https://github.com/yeonjaekim99/knowledge-graph/pull/45)이 구현·검증·상태 증거를
    `main`에 고정해 제품 roll-up을 32/66으로 올렸다.
37. RCL-005는 같은 snapshot의 TEMP valid aggregate에서 양방향 entity link와 literal 포함
    incident를 분리해 읽고, depth 1~3 BFS·31→30 fanout·canonical one-visit·multi-seed
    parent/path를 결정적으로 조립한다. 독립 review에서 cycle endpoint, Proxy/accessor/error
    redaction, 81-code-point 표시, stateful input snapshot, incident⊆link와 긴 FTS suffix 경계를
    tests-only RED로 고정해 모두 닫았다. RCL-004와 semantic rebase한 최종 상태에서 focused
    21/21, 전체 409/409와 독립 review HIGH/MEDIUM/LOW 0건을 재현했다.
    [PR #46](https://github.com/yeonjaekim99/knowledge-graph/pull/46)이 구현·검증·상태 증거를
    `main`에 고정해 제품 roll-up을 33/66으로 올렸다.
38. RCL-006은 RCL-005 reached와 같은 TEMP aggregate를 bound parameter로 읽어 정확한 SQL
    score·전체 tie-break·limit+1을 계산하고, 유효 반대 관계에만 contested를 붙이며 유효
    support의 label fallback과 canonical brief를 만든다. 독립 review의 non-canonical literal,
    relation-contested, lifecycle error, source accessor MEDIUM 4건을 11/20 RED에서 20/20 GREEN으로
    닫았고, remediation HEAD 독립 재리뷰는 HIGH/MEDIUM/LOW 0건과 전체 429/429를 재현했다.
    [PR #49](https://github.com/yeonjaekim99/knowledge-graph/pull/49)가 구현·검증·상태 증거를
    `main`에 고정해 제품 roll-up을 34/66으로 올린다.

## 의도적으로 남은 상태

- [PR #3](https://github.com/yeonjaekim99/knowledge-graph/pull/3)으로 roadmap을 `main`에
  게시했고 [PR #4](https://github.com/yeonjaekim99/knowledge-graph/pull/4)에서 agent
  instruction 계약과 기계 검증을 추가했다. [PR #5](https://github.com/yeonjaekim99/knowledge-graph/pull/5)는
  그 계약이 선행 증거를 실제로 재사용하도록 roadmap 표현과 검증기를 보강해 Phase 00을
  7/7로 종료했다.
- FND-001의 production 언어/runtime/SQLite driver/MCP SDK 선택은 구현 결정이다. 이
  로드맵 리뷰가 특정 stack을 선결정하지 않는다.
- 미착수 제품 task owner는 실제 planning 전까지 `unassigned`다. 시작·완료된 작업만
  planning/구현 PR에서 확정한 owner를 기록한다.
- Phase 01은 6/6, Phase 02는 8/8, Phase 03은 10/10으로 종료됐다. REC-001~REC-003과
  RCL-001~RCL-003은 각각 [PR #32](https://github.com/yeonjaekim99/knowledge-graph/pull/32),
  [PR #36](https://github.com/yeonjaekim99/knowledge-graph/pull/36),
  [PR #38](https://github.com/yeonjaekim99/knowledge-graph/pull/38),
  [PR #34](https://github.com/yeonjaekim99/knowledge-graph/pull/34),
  [PR #39](https://github.com/yeonjaekim99/knowledge-graph/pull/39),
  [PR #41](https://github.com/yeonjaekim99/knowledge-graph/pull/41)로 완료했고, REC-004는
  [PR #43](https://github.com/yeonjaekim99/knowledge-graph/pull/43)으로 완료했다.
  RCL-004는 [PR #45](https://github.com/yeonjaekim99/knowledge-graph/pull/45), RCL-005는
  [PR #46](https://github.com/yeonjaekim99/knowledge-graph/pull/46), RCL-006은
  [PR #49](https://github.com/yeonjaekim99/knowledge-graph/pull/49)로 완료했고 REC-005는
  격리 branch에서 진행한다. RCL-007은 다음 dependency-ready planning 대상이다.
- 후속 peer review에서 새 문제가 발견되면 기존 ID 의미를 바꾸지 않고 roadmap 수정 PR로
  반영한다.

## 이번 자체 검증 결과

| 검증 | 결과 |
|---|---|
| `python3 docs/roadmap/validate.py` | PASS — phase 9, active task 73, historical task 74, retired 1, evidence audit 67/67, cycle 0 |
| 추적성 검사 | PASS — ADR 17/17, spike scenario 24/24 |
| Markdown link·공백·conflict marker 검사 | PASS — 오류 0 |
| REC-004 보완·관련 projection·전체 로컬 gate | PASS — REC-004 42/42, 관련 PRJ-005/009 포함 target 70/70, architecture/type/build와 전체 fast 46 files·373/373; Promise species 보완 뒤 새 독립 최종 review HIGH/MEDIUM/LOW 0건과 focused 50/50 |
| 기존 main 깨끗한 source baseline | PASS — `pnpm 11.22.0` frozen lockfile 설치, 당시 전체 local gate 232/232와 roadmap audit 재현 |
| RCL-001 branch gate | PASS — RCL-001 10/10, STO-002 7/7, PRJ-008 8/8, PRJ-010 39/39, 전체 255/255와 architecture/type/build; 독립 review 미해결 finding 0개 |
| REC-004 교차 gate | PASS — RCL-001 10/10, RCL-002 15/15, RCL-003 21/21, STO-002 7/7, STO-004 4/4, PRJ-008 8/8, PRJ-010 39/39; Proxy/accessor·connection-error identity·result parity/note·kind scalar·Promise species finding을 닫고 독립 최종 review를 통과 |
| dependency audit | PASS — production 알려진 취약점 0개 |
| behavior spike 전체 회귀 | PASS — 25/25 |
| REC-002 branch gate | PASS — architecture/type/build, target 13/13와 전체 빠른 suite 38개 파일 268/268; 독립 review 미해결 HIGH/MEDIUM 0건 |
| REC-003 branch gate | PASS — architecture/type, REC-001 11/11·REC-002 13/13·REC-003 17/17, 전체 fast 39개 파일 285/285, PRJ-010 39/39, spike 25/25, roadmap audit와 dependency audit 0; mutable input 14/15·accessor result 15/16·typed detector error 16/17 RED를 닫았고 독립 review finding HIGH 0/MEDIUM 0 |
| RCL-002 branch gate | PASS — architecture/type/build, RCL-002 15/15·REC-001 13/13·REC-002 13/13·REC-003 17/17·RCL-001 10/10, 전체 fast 42개 파일 302/302, PRJ-010 39/39, spike 25/25, roadmap audit와 dependency audit 0; 독립 review 미해결 HIGH/MEDIUM/LOW 0 |
| RCL-003 branch gate | PASS — architecture/type/build, RCL-003 21/21·RCL-002 15/15·RCL-001 10/10·STO-002 7/7·STO-004 4/4·PRJ-008 8/8, 전체 fast 44개 파일 323/323, PRJ-010 39/39, spike 25/25, roadmap audit와 dependency audit 0; 2,100 support·21 candidate probe 및 독립 review 미해결 HIGH/MEDIUM/LOW 0 |
| RCL-004 branch gate | PASS — 최신 main `25eeb72` 위 semantic rebase, RCL-004 15/15·REC-004 focused 50/50을 포함한 verify 70/70·RCL-001 10/10·RCL-002 15/15·RCL-003 21/21·STO-002 7/7·STO-004 4/4·PRJ-008 8/8, 전체 fast 48개 파일 388/388, PRJ-010 39/39, spike 25/25, roadmap audit와 dependency audit 0; REC-004 writer resolver·REC-005 planning 보존, 독립 최종 review HIGH/MEDIUM/LOW 0건 |
| RCL-005 branch gate | PASS — 최신 main `51523f3` 위 semantic rebase, RCL-005 21/21·RCL-004 15/15·REC-004 70/70·RCL-001/002/003 10/10·15/15·21/21, 전체 fast 51개 파일 409/409, PRJ-010 39/39, spike 25/25, roadmap audit와 dependency audit 0; 독립 최종 review HIGH/MEDIUM/LOW 0건 |
| RCL-006 branch gate | PASS — RCL-006 20/20·RCL-001~005 10/10·15/15·21/21·15/15·21/21·REC-004 70/70, 전체 fast 53개 파일 429/429, PRJ-010 39/39, spike 25/25, roadmap audit와 dependency audit 0; 독립 재리뷰 HIGH/MEDIUM/LOW 0건 |
| 변경 범위 | PASS — 기존 REC-004 writer와 RCL-001~005 snapshot/surface/FTS/overview/traversal seam에 aggregate-backed ranking·brief를 병존시키고, record write·public Answer/detail/payload budget·MCP handler·자동 CI 변경은 포함하지 않음 |

## 게시 전 재현 검사

다음 검사를 roadmap PR에서 다시 실행한다.

```bash
git diff --check origin/main...HEAD
python3 docs/roadmap/validate.py
```

두 번째 검사는 모든 roadmap 변경 PR에서 필수 로컬 gate로 실행하고 결과를 PR에 남긴다.
