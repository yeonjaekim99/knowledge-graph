# Phase 04 — memory_record 수직 경로

- 상태: `IN_PROGRESS`
- 진행률: 4/8
- 선행 phase: Phase 03 `DONE`
- 주요 근거: ADR-002~011, ADR-013
- 선행 증거 감사: [Phase 04 baseline과 production gap](evidence-audit.md#phase-04-record)
- 종료 조건: 구조 검증, 비밀값 처리, 부분 성공, ID 매핑과 동기 투영을 포함한 기록
  application service가 공개 계약대로 원자적으로 동작함

> evidence audit의 `[x]`는 기존 증거 대조 완료다. 아래 작업의 `TODO/DONE`과 production
> 완료 체크를 대신하지 않는다.

## 작업 현황

| ID | 작업 | 상태 | Owner | 선행 작업 | 증거 |
|---|---|---|---|---|---|
| REC-001 | record 입력·출력 schema와 domain 계약 | `DONE` | `log0629` | FND-004, PRJ-009 | [PR #32](https://github.com/yeonjaekim99/knowledge-graph/pull/32), [구현 결정](../implementation/rec-001-record-contract.md) |
| REC-002 | 비밀값 pattern·entropy 탐지기 | `DONE` | `log0629` | FND-003 | [PR #36](https://github.com/yeonjaekim99/knowledge-graph/pull/36), [구현 결정](../implementation/rec-002-secret-detector.md) |
| REC-003 | raw 마스킹과 draft 부분 거부 | `DONE` | `log0629` | REC-001, REC-002 | [PR #38](https://github.com/yeonjaekim99/knowledge-graph/pull/38), [구현 결정](../implementation/rec-003-record-sanitizer.md) |
| REC-004 | write entity 해석과 모호성 처리 | `DONE` | `log0629` | REC-001, PRJ-005 | [PR #43](https://github.com/yeonjaekim99/knowledge-graph/pull/43), [구현 결정](../implementation/rec-004-write-entity-resolver.md) |
| REC-005 | draft 의미 검증·중복 제거·index mapping | `IN_PROGRESS` | `log0629` | REC-003, REC-004 | [Planning PR #44](https://github.com/yeonjaekim99/knowledge-graph/pull/44), branch `rec-005-draft-planning` |
| REC-006 | statement append·project·결과 원자성 | `TODO` | `unassigned` | REC-005, STO-007, PRJ-009 | — |
| REC-007 | raw-only·기본값·재시도 의미 | `TODO` | `unassigned` | REC-006, PRJ-008 | — |
| REC-008 | record 보안·편차·통합 회귀 suite | `TODO` | `unassigned` | REC-001~007 | — |

## 상세 체크리스트

### REC-001 — record 입력·출력 schema와 domain 계약

- 상태: `DONE`
- Owner: `log0629`
- Branch: `rec-001-record-contract`
- PR: [#32](https://github.com/yeonjaekim99/knowledge-graph/pull/32)
- 근거: ADR-002, ADR-004, ADR-013
- 선행 작업: FND-004, PRJ-009
- 결과물: MemoryRecordInput, ClaimDraft, RecordResult schema와 validator

완료 체크:

- [x] raw 1~32,768자, claims 0~100개와 모든 free-form 문자열의 well-formed Unicode scalar·배열
  상한을 검사한다.
- [x] object/object_value XOR, object 전용 kind/aliases와 relates_to label 조건을 표현한다.
- [x] 모든 object에 `additionalProperties:false`를 적용한다.
- [x] schema 오류는 사건 없는 tool error, 의미 오류는 draft별 rejected로 구분한다.
- [x] 각 입력 index에 정확히 한 result가 있고 상태 우선순위가 ADR-013과 같다.

완료 증거:

- [구현 결정](../implementation/rec-001-record-contract.md)에 four-branch ClaimDraft,
  일반/재해석 input, trim 후 Unicode 상한과 typed output/index 불변식을 고정했다.
- TDD RED는 build 뒤 아직 없는 `RecordContractError` export에서 target module load가 실패했다.
  GREEN은 `pnpm verify:rec-001`의 FND-004 7/7과 REC-001 11/11이다.
- exact-bound astral-plane emoji와 앞뒤 공백 원문 보존, 한 code point 초과·whitespace-only,
  claims 100/101과 aliases 20/21 경계를 검증했다.
- RCL-002 review 후속 RED `138c914`은 모든 free-form input의 malformed UTF-16 acceptance
  204개를 REC-001 12/13으로 재현했다. fix `02b7d10` 뒤 advertised source, Standard Schema와
  helper가 payload를 echo하지 않고 거부하며 valid astral pair를 유지해 REC-001 13/13과
  최신 `main`의 REC-003을 포함한 전체 빠른 suite 42개 파일 302/302를 통과했다.
- 목적어 XOR, object-only field, 다섯 relation/label, 재해석 pair와 ID/token pattern, trusted
  scope/metadata 금지를 모두 사건 전 schema contract 오류로 분리했다.
- accepted/rejected result branch, original input index의 전단사 coverage와
  `superseded_previous > created > reinforced` 우선순위를 검증했다.
- 전체 빠른 suite 243/243, 독립 behavior spike 25/25, roadmap audit와 production dependency
  audit 취약점 0개를 통과했다.
- 독립 peer review에서 merge-blocking 결함은 없었고 package root의 내부 status facts 노출
  Low finding은 별도 fix commit과 전체 243/243 재검증으로 닫았다. [PR #32](https://github.com/yeonjaekim99/knowledge-graph/pull/32)가
  이 상태·증거 commit을 포함해 `main`에 병합되면 REC-001의 영속적인 완료 근거가 된다.

### REC-002 — 비밀값 pattern·entropy 탐지기

- 상태: `DONE`
- Owner: `log0629`
- Branch: `rec-002-secret-detector`
- PR: [#36](https://github.com/yeonjaekim99/knowledge-graph/pull/36)
- 근거: ADR-011
- 선행 작업: FND-003
- 결과물: versioned detector registry와 탐지 결과 type

완료 체크:

- [x] AWS/GitHub/JWT 등 명시 pattern과 긴 random 문자열 entropy 검사를 분리한다.
- [x] provider token 경계는 Unicode `\b` 대신 ASCII lookaround를 쓰고 한국어 조사·문장부호
      인접 fixture로 class 판정을 검증한다.
- [x] allowlist와 커밋 SHA·hash 같은 오탐 fixture를 코드 리뷰 가능한 registry로 둔다.
- [x] 탐지 결과는 종류와 위치만 제공하고 원문 secret을 복사하지 않는다.
- [x] note, alias, kind, relation label을 포함한 모든 저장 가능 문자열을 같은 pure detector
      surface의 field context로 등록한다.
- [x] detector 내부 예외는 payload-redacted fail-closed typed error가 되고 pure domain 모듈은
      IO·writer dependency를 갖지 않는다.
- [x] detector fixture와 로그에 실제 credential을 사용하지 않는다.

완료 증거:

- [구현 결정](../implementation/rec-002-secret-detector.md)에 `secret-detector-v1`, explicit
  signature 우선순위, Unicode code-point entropy, UTF-16 slice 위치와 context-bound
  allowlist를 고정했다.
- 최초 TDD RED는 production export 부재로 target 0/1이었고, 독립 리뷰 보강 RED는
  internal punctuation과 64-hex `metadata.branch` fixture에서 8/10이었다. root review의
  exact-20 edge-symbol fixture도 wrapper trim fail-open을 10/11 RED로 재현했다. 이어
  namespaced/quoted assignment, empty-user credential URL, complete/truncated PEM masking 범위,
  marker delimiter·Unicode boundary와 actor/branch allowlist 우회를 9/13, 11/13, 12/13 RED로
  고정했다. 수정 뒤 `pnpm verify:rec-002` target 13/13과 architecture/type/build, 전체
  `pnpm test` 38개 파일 268/268을
  통과했다.
- synthetic fixture만으로 AWS/GitHub/GitLab/Google/Slack/Stripe, JWT, PEM, credential URL,
  assignment와 한국어 조사·문장부호, internal/edge punctuation segmentation, 임의 hex
  actor/branch, standalone marker+delimiter 및 19/20자·4.0-bit entropy 경계를 검증한다.
- result와 typed error에는 match/value/prefix/suffix/cause가 없고 registry/result는 freeze된다.
  application의 scan-before-write 연결, raw 마스킹과 draft 부분 거부는 REC-003에 남고
  transaction·log/MCP 전체 누출 검사는 REC-008/MCP-005에 남긴다.
- 독립 behavior spike 25/25, roadmap active 73·historical 74·evidence 67/67과 dependency
  audit 알려진 취약점 0개를 확인했다.
- 독립 review에서 발견한 entropy edge, assignment/URL/PEM interval과 marker·metadata allowlist
  결함을 모두 synthetic RED로 재현해 닫았다. 최종 재검토의 미해결 HIGH/MEDIUM은 0건이고,
  bounded 입력의 결과 수 비례 LOW 비용만 후속 부하 관찰로 남겼다. [PR #36](https://github.com/yeonjaekim99/knowledge-graph/pull/36)가
  구현·review·검증과 이 상태 증거를 함께 `main`에 고정한다.

### REC-003 — raw 마스킹과 draft 부분 거부

- 상태: `DONE`
- Owner: `log0629`
- Branch: `rec-003-record-sanitizer`
- PR: [#38](https://github.com/yeonjaekim99/knowledge-graph/pull/38)
- 근거: ADR-011, ADR-013
- 선행 작업: REC-001, REC-002
- 결과물: journal 기록 전 sanitizer와 actionable rejection note

완료 체크:

- [x] raw_text 의심 구간을 위치 기반 class marker로 마스킹하고 위치가 불명확하면 전체를
      보수적으로 가린 plan만 후속 journal/FTS 경계에 전달한다.
- [x] secret이 든 draft만 제외하고 안전한 draft와 마스킹 원문은 계속 처리한다.
- [x] note와 error가 탐지값, SQL, DB 경로 또는 주변 민감 문맥을 echo하지 않는다.
- [x] 재해석 호출은 한 draft라도 거부되면 successor 전체를 만들지 않는다.
- [x] 마스킹/거부 전후 값을 audit-safe fixture로 검증한다.

완료 증거:

- [구현 결정](../implementation/rec-003-record-sanitizer.md)은 REC-001 입력과 REC-002
  positional detector를 writer capability 없는 pure application plan으로 연결한다.
- 최초 RED는 build 성공 뒤 sanitizer export 부재로 module load가 실패했다. GREEN은 raw
  explicit/entropy 치환, 8개 draft 문자열 category, 부분/전체 거부, 재해석 전체 실패와
  malformed detector fail-closed를 포함한 target 17/17이다.
- UTF-16 astral 인접 위치와 surrogate split, 겹침·역순·범위 손상, unknown class와 extra
  payload, 앞선 hit 뒤 후속 detector exception을 synthetic 값만으로 검증한다.
- self-review에서 detector가 caller-owned 입력을 바꾸면 검사값과 승인값이 달라지는 경계를
  14/15 RED로 고정했고, detector 실행 전 raw·mode·draft·alias snapshot으로 15/15 GREEN을
  만들었다. result/finding accessor가 실행되는 경계도 15/16 RED로 고정하고 exact data
  descriptor와 dense bounded finding snapshot으로 16/16 GREEN을 만들었다. 독립 review가
  payload-bearing typed detector error 재사용을 16/17 RED로 찾았고, detector가 던진 객체를
  항상 새 고정 오류로 치환해 17/17 GREEN으로 닫았다.
- `pnpm verify:rec-003`은 architecture/type과 REC-001 11/11, REC-002 13/13, REC-003
  17/17을 통과했다. 전체 fast suite 39개 파일 285/285, PRJ-010 39/39, behavior spike
  25/25, roadmap audit 67/67과 production dependency audit 취약점 0개도 accessor hardening
  및 typed-error hardening 뒤 다시 통과했다.
- 독립 review는 위 MEDIUM 누출과 잘못된 변경 범위 설명 LOW를 찾았고 둘 다 회귀와 문서로
  닫았다. 최종 재검증에서 미해결 HIGH/MEDIUM 0건을 확인한 [PR #38](https://github.com/yeonjaekim99/knowledge-graph/pull/38)이
  구현과 검증을 `main`에 고정한다. journal/project 원자성과 전체 저장
  매체 누출 scan은 REC-006/008의 완료를 과장하지 않고 남긴다.

### REC-004 — write entity 해석과 모호성 처리

- 상태: `DONE`
- Owner: `log0629`
- Branch: `rec-004-write-entity-resolver`
- PR: [#43](https://github.com/yeonjaekim99/knowledge-graph/pull/43)
- 근거: ADR-003, ADR-008, ADR-013
- 선행 작업: REC-001, PRJ-005
- 결과물: transaction-bound draft entity resolver

완료 체크:

- [x] surface 전체 후보→canonical→exact normal name 순서로 해석한다.
- [x] 후보가 여러 개면 임의 선택하지 않고 그 draft만 actionable ambiguous로 거부한다.
- [x] 다른 scope의 ID/후보 존재를 응답에서 드러내지 않는다.
- [x] write lock 안에서 constraint 충돌 후 재조회해 동시 동일 이름을 하나로 수렴시킨다.
- [x] kind는 well-formed Unicode scalar만 adapter/worker에서 받고, 불일치와 alias homonym을
  자동 merge/split하지 않는다.
- [x] DB-global next journal seq와 REC-005 survivor finalization 뒤에만 compact occurrence ID를 확정한다.
- [x] finalized statement body와 실제 append seq가 다르면 projection 전에 전체 transaction을 닫는다.
- [x] session result의 object ID presence와 rejected field를 원본 draft와 대조하고 고정 ambiguity
  note만 새 결과에 재구성한다.
- [x] session Promise의 custom `Symbol.species` 반환 객체를 폐기하고 resolve/finalize public
  boundary는 native Promise의 검증된 동결 결과 또는 fresh fixed/canonical 오류만 반환한다.

완료 증거:

- [구현 결정](../implementation/rec-004-write-entity-resolver.md)은 기존 atomic dispatcher의
  `BEGIN IMMEDIATE` 안에 prepare→draft resolve→survivor finalize→append 단계를 두되, pre-resolution
  entity/surface/redirect stage를 append 직전 outer savepoint로 전부 rollback하도록 고정했다.
- production adapter는 PRJ-005 resolver를 재사용해 same-scope surface 전체 후보를 redirect
  terminal로 바꾼 뒤 exact normal-name 하나만 tie-break한다. 남은 ambiguity는 정렬된 안전한
  후보와 retry note로 해당 draft만 거부하며 object 실패 시 nested savepoint가 그 draft의
  subject/alias stage도 되돌린다.
- occurrence candidate는 caller 입력이 아니라 잠금 안의 DB-global next seq에서 발급한다.
  ambiguity 뒤 position을 되돌리고, REC-005가 고른 survivor subset만 outer savepoint에서 다시
  해석해 rejected/duplicate 위치를 compact한다. finalization의 exact statement body와 실제 append
  seq가 어긋나면 journal/projection 전에 fail-closed한다.
- file-backed [REC-004 integration test](../../test/integration/sqlite/rec-004-write-entity-resolver.test.mjs)는
  정상 redirect/신규 object, exact tie-break·ambiguity, 앞·뒤 draft 격리, alias homonym,
  trigger로 만든 실제 unique collision 재조회, cross-scope redaction·queue 회복과 append 없는
  commit 차단을 검증한다.
- 최초 RED는 production module 부재로 `ERR_MODULE_NOT_FOUND` 0/1이었고 구현 뒤 target은
  8/8 GREEN이었다. 독립 review 보완 RED는 finalizer export 부재 0/1이었고, 보완 뒤 REC-004
  adapter의 Proxy/accessor·session 오류 객체 누출을 독립 재검토에서 추가로 찾아 tests-only
  19개 중 6 pass/13 fail과 21개 중 18 pass/3 fail RED로 고정했다. exact descriptor snapshot과
  fresh fixed input/result error로 닫았다. 최종 독립 review에서 canonical own shape여도 원본
  SQLite error identity가 poisoned prototype·transparent Proxy getter를 유지하고 invalid runtime
  code를 통과시키는 경계를 찾아, tests-only 33개 중 28 pass/5 fail RED와 allowed code/retry
  descriptor snapshot→fresh canonical reconstruction의 33/33 GREEN으로 닫았다. 이어진
  review에서 rejected note payload와 원본 draft 대비 object/field shape 불일치 MEDIUM, kind
  lone surrogate LOW를 찾았다. tests-only `39c4a00`의 27/35 RED를 expected-draft parity·고정
  note reconstruction과 adapter/worker Unicode scalar 검사 `cb5f2ec`으로 35/35 GREEN으로
  닫았다. 그 뒤 REC-003·RCL-002·RCL-003 완료와 RCL-004·RCL-005 planning이 반영된 최신
  main에 semantic rebase했다. 이 상태의 독립 재검토가 session Promise subclass의 custom
  `Symbol.species` 객체가 public return과 settlement를 대체하는 MEDIUM 경계를 찾았다.
  tests-only `b179166`의 36/42 RED를 native async settlement bridge `68ff959`로 닫아
  42/42 GREEN을 만들었다. 관련 PRJ-005/009 포함 70/70, 전체 fast 46 files·373/373,
  RCL-001 10/10, RCL-002 15/15, RCL-003 21/21, STO-002 7/7, STO-004 4/4,
  PRJ-008 8/8, PRJ-010 39/39, spike 25/25,
  roadmap 67/67과 production audit 0건을 재확인했다. 새 독립 최종 review는 HEAD
  `2a579c0`에서 HIGH/MEDIUM/LOW 0건, focused 50/50과 위 전체 gate를 재현했다.
  [PR #43](https://github.com/yeonjaekim99/knowledge-graph/pull/43)이 구현·review·검증과
  상태 증거를 `main`에 함께 고정해 REC-004를 완료한다.

### REC-005 — draft 의미 검증·중복 제거·index mapping

- 상태: `IN_PROGRESS`
- Owner: `log0629`
- Branch: `rec-005-draft-planning`
- Planning PR: [#44](https://github.com/yeonjaekim99/knowledge-graph/pull/44)
- 근거: ADR-002, ADR-009, ADR-013
- 선행 작업: REC-003, REC-004
- 결과물: 승인 draft plan과 입력/저장 index mapping

완료 체크:

- [ ] 독립 의미 검증 후 승인 draft만 원래 입력 순서로 보존한다.
- [ ] 같은 요청의 같은 claim identity는 첫 항목 하나만 stored parsed에 넣는다.
- [ ] 뒤 중복 index는 같은 claim_id와 reinforced+병합 note를 반환한다.
- [ ] rejected/중복 입력이 stored parsed index와 후보 ID 위치를 소비하지 않는다.
- [ ] subject/object occurrence와 response input index를 fixture로 대조한다.

진행 증거 (PR/main 전이므로 상태와 체크는 `IN_PROGRESS`로 유지):

- [REC-005 구현 결정](../implementation/rec-005-record-draft-plan.md)은 REC-003 승인/rejection과
  REC-004 canonical resolution을 request-local identity로 조합하고, first survivor만 stored
  draft가 되는 두 단계 selection/finalization seam을 고정한다.
- tests-only RED `a2e58eb`은 application export 부재로 0/1 실패했다. GREEN `9cdfa39`과 gate
  `1780b33` 뒤 focused unit·file-backed SQLite target은 14/14, 관련 PRJ-003/005/006과
  REC-003/004를 포함한 `pnpm verify:rec-005`는 architecture/type/build와 116/116을 통과했다.
- 최신 `origin/main` `491f3a3`에 semantic rebase해 RCL-005 완료와 RCL-006 `IN_PROGRESS`
  planning 증거를 보존했다. 공유 export·package/test 문서에는 RCL-005 reader facet,
  REC-004 writer/finalization과 REC-005 plan이 함께 남는다. RCL-006 planning-only delta는
  source·test를 바꾸지 않았고, 전체 fast suite 53 files·423/423, PRJ-010 39/39,
  RCL-005 21/21, RCL-004 15/15, REC-004 70/70, 독립 behavior spike 25/25를 통과했다.
  roadmap active 73·historical 74·evidence 67/67·ADR 17/17·scenario 24/24·link 425와
  production dependency audit 취약점 0개도 확인했다. 동등한 REC-005 내용의 rebase 전
  HEAD `7cb7871` 독립 review는 HIGH/MEDIUM/LOW 0건이었지만 최신 main 통합 뒤 PR/main
  증거가 아직 없으므로 완료 체크와 진행률은 올리지 않는다.
- exact survivor body와 DB-global seq는 REC-004 finalizer가 확인하고, 그 뒤에만 compact
  `c{seq}.{storedIndex}`와 subject/object occurrence candidate를 만든다. duplicate는 첫 survivor의
  stored index/candidate를 공유하고 survivor/occurrence cursor를 늘리지 않는다.
- 위 claim ID는 아직 내부 candidate이며 journal append, 기존 claim redirect와 최종
  created/reinforced/superseded_previous 판정은 REC-006에 남는다. 이 branch에는 성공 event,
  projection publish 또는 commit surface가 없다.

### REC-006 — statement append·project·결과 원자성

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-001, ADR-007, ADR-009, ADR-013
- 선행 작업: REC-005, STO-007, PRJ-009
- 결과물: memory_record application service

완료 체크:

- [ ] queue 점유와 `BEGIN IMMEDIATE` 안에서 DB 의존 검증을 다시 수행한다.
- [ ] 기본값·마스킹 raw·승인 parsed를 statement 하나에 기록하고 동기 project한다.
- [ ] created/reinforced/superseded_previous를 실제 상태 전이에서 계산한다.
- [ ] journal, FTS, projection 또는 결과 계산 실패 시 모두 rollback한다.
- [ ] 성공 event_id를 반환한 시점에는 새 reader에서도 projection이 보인다.

### REC-007 — raw-only·기본값·재시도 의미

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-010, ADR-013, ADR-016, ADR-017
- 선행 작업: REC-006, PRJ-008
- 결과물: 기록 edge semantics와 client-facing guidance

완료 체크:

- [ ] `claims:[]`와 승인 draft 0개가 유효한 statement/FTS 기록을 만든다.
- [ ] provenance 기본 inferred와 provenance별 TTL 기본값이 body에 명시적으로 고정된다.
- [ ] 일반 record는 supersedes/approval을 받지 않고 재해석 pair만 별도 검증한다.
- [ ] 같은 성공 호출 재전송은 새 statement/support를 만들므로 idempotent로 표시하지 않는다.
- [ ] raw-only 만료와 재해석 후보 공급 경계를 통합 fixture로 검증한다.

### REC-008 — record 보안·편차·통합 회귀 suite

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-011, ADR-013과 behavior spike
- 선행 작업: REC-001~007
- 결과물: record black-box, 보안과 agent fixture suite

완료 체크:

- [ ] 정상, raw-only, 부분 성공, 중복, ambiguous, secret과 projection rollback case가 통과한다.
- [ ] journal body/FTS/log/error/response 어디에도 탐지 secret 평문이 없음을 스캔한다.
- [ ] 최소 20개 한국어·영어 파싱 fixture 형식과 identity 비교 harness를 준비한다.
- [ ] production S01/S02/S09/S12/S18 계열 결과가 spike oracle과 일치한다.
- [ ] 재시도와 동시 동일 entity 기록의 statement/support 수를 명시적으로 검증한다.

## Phase 종료 체크

- [ ] public schema를 만족하는 기록이 부분 성공 규칙과 함께 원자적으로 commit된다.
- [ ] 불변 journal 전에 raw secret이 마스킹되고 draft secret은 저장되지 않는다.
- [ ] 입력 index, stored parsed index와 occurrence ID 매핑이 결정적이다.
- [ ] Phase 05가 같은 target/result/domain type을 재사용해 착수할 수 있다.
