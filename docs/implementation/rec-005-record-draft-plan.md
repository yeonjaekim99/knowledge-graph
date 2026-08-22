# REC-005: record draft survivor와 index mapping

- 상태: 구현·독립 review·로컬 검증 완료, PR 게시 전
- 작업 ID: `REC-005`
- 구현 branch: `rec-005-draft-planning`
- 근거: ADR-002, ADR-009, ADR-013
- 선행 구현: REC-003, REC-004, PRJ-003, PRJ-006

## Context와 소유 경계

REC-003은 schema-valid 입력을 비밀값 검사해 원래 `inputIndex`를 가진 승인 draft와 안전한
rejection으로 나눈다. REC-004는 같은 writer lock 안에서 subject/entity object를 canonical
ID로 해석하고, caller가 고른 survivor만 다시 stage해 compact occurrence ID와 정확한
statement body를 DB-global next journal seq에 묶는다. 두 작업 사이에는 다음 production gap이
남아 있었다.

- 의미상 승인된 draft와 entity ambiguity를 원래 입력 순서로 합치는 경로
- canonical claim identity 기준의 요청 내 duplicate survivor 선택
- 원래 input index, 저장 `parsed` index와 subject/object occurrence 위치의 명시적 mapping
- duplicate 결과가 첫 survivor의 내부 claim candidate를 공유한다는 증거

REC-005는 이 planning 경계만 소유한다. journal event 생성·append, projection publish,
기존 claim/redirect 조회와 최종 `created | reinforced | superseded_previous` 판정은 REC-006에
남긴다. 따라서 이 작업의 결과에는 event ID, commit receipt 또는 최종 공개 claim 상태가 없고,
SQLite 조립 함수도 append/commit capability를 받거나 노출하지 않는다.

## Decision

### 두 단계 plan

[`memory-record-draft-plan.ts`](../../src/application/memory-record-draft-plan.ts)는 adapter 없는
두 순수 경계를 제공한다.

1. `selectRecordDraftSurvivors(...)`는 REC-003의 승인/rejection과 REC-004의 첫 resolution을
   대조해 `RecordDraftSurvivorPlan`을 만든다.
2. `finalizeRecordDraftPlan(...)`은 REC-004 finalization 결과의 global seq와 compact canonical
   entity ID를 같은 plan에 결합해 내부 candidate/occurrence mapping을 만든다.

selection plan은 이 모듈이 만든 frozen object만 finalization에 사용할 수 있다. caller-owned
draft, alias, resolution과 rejection 객체를 보유하지 않고 exact enumerable data descriptor로
다시 snapshot한다. 승인 index는 strictly increasing이어야 하며 승인과 sanitizer rejection을
합친 index 집합은 정확히 `0..N-1`이다. resolution도 승인 배열과 길이·순서·index 및 entity/literal
object presence가 정확히 같아야 한다.

### 독립 의미 검증과 rejection

REC-001/003/004를 통과한 내부 값도 이 경계에서 다시 검사한다.

- subject, entity object와 alias는 trim bound와 well-formed Unicode scalar를 확인하고
  `normalize_v1`이 유효한 identity를 만들 수 있어야 한다.
- relation과 `relates_to` label은 정규 registry 규칙을 다시 적용한다.
- literal은 ADR-009의 trim + NFKC identity를 계산한다.
- kind는 Unicode bound만 확인하고 identity에서 제외한다. separator-only kind는 REC-004의
  합법 동작이므로 entity 이름 정규화 규칙을 잘못 적용하지 않는다.
- sanitizer rejection은 허용된 field/class의 고정 note만 재구성한다. 위치가 불명확한
  보수적 `class=secret`도 합법이다.
- entity ambiguity는 REC-004의 subject/object별 고정 note와 canonical numeric-order 후보
  shape가 일치할 때만 해당 draft의 rejection으로 바꾼다.

한 draft의 secret 또는 ambiguity는 그 draft만 제외한다. sanitizer가 재해석의 부분 거부를
이미 전체 실패로 막았으므로 REC-005는 불완전한 reinterpret successor를 새로 허용하지 않는다.

### canonical identity와 survivor

같은 request의 모든 draft는 같은 trusted scope transaction에 속하므로 request-local identity는
다음 tuple로 비교한다.

```text
(canonical_subject_id, relation, object_kind,
 entity이면 canonical_object_id / literal이면 trim+NFKC object_value)
```

entity display name, alias, kind와 relation label로 duplicate를 판정하지 않는다. 따라서 서로
다른 표면형도 REC-004가 같은 terminal entity ID로 해석했으면 같은 사실이고, 같은 문자열도
서로 다른 canonical entity ID로 해석됐으면 별개다. literal의 대소문자·내부 공백·문장부호는
ADR-009대로 identity 일부다.

각 identity의 첫 입력만 `storedDrafts`에 원문-preserving frozen draft로 남는다. 저장 index는
현재 survivor 수이고 원래 입력 순서를 유지한다. 뒤 duplicate outcome은 다음 고정값을 가진다.

```text
status = reinforced
storedIndex = 첫 survivor의 storedIndex
duplicateOfIndex = 첫 survivor의 inputIndex
note = "duplicate draft folded into the first stored draft"
```

duplicate 자체는 `storedDrafts`나 `survivorDraftIndexes`를 늘리지 않는다. ambiguity/secret
rejection도 마찬가지다.

### exact-body finalization과 occurrence mapping

[`record-draft-plan.ts`](../../src/adapters/sqlite/record-draft-plan.ts)의
`finalizeSqliteRecordDraftPlan(...)`은 selection plan의 original input survivor indexes와
REC-006이 조립할 survivor-only `statementBodyJson`을 REC-004
`finalizeSqliteWriteEntityDrafts(...)`에 전달한다. REC-004 worker가 다음을 먼저 보장해야만
candidate mapping이 만들어진다.

- plan의 survivor만 원래 순서로 다시 해석됨
- body의 `parsed`가 그 survivor들의 이름·kind·alias와 정확히 일치함
- finalization seq가 writer lock 안의 DB-global next journal seq임
- staged projection은 아직 outer savepoint 안이며 append 전임

그 결과로 저장 draft마다 다음 mapping을 만든다.

```text
claimCandidateId = c{expectedJournalSeq}.{storedIndex}
subject candidate = e{expectedJournalSeq}.{entityPosition++}
entity object candidate = e{expectedJournalSeq}.{entityPosition++}
literal object = occurrence 없음
canonicalId = REC-004 finalizer가 돌려준 terminal entity ID
```

duplicate outcome은 첫 survivor mapping의 같은 `claimCandidateId`를 참조한다. 이 값은 exact
body/seq에 묶인 **내부 candidate**이지 성공 응답의 canonical `claim_id`가 아니다. 기존 claim과
claim redirect, describes replacement를 적용한 실제 ID/상태는 REC-006의 동기 projector 결과가
확정한다.

### 실패와 불변성

application과 SQLite wrapper는 plain object, dense bounded array, exact key와 own enumerable
data descriptor만 받는다. Proxy reflection trap, accessor, sparse/extra key, malformed ID,
resolution/finalization parity 불일치는 payload를 보관하지 않는 새 고정 오류로 바꾼다.
sanitizer/ambiguity note도 임의 문자열을 전달하지 않고 허용된 구조에서만 재구성한다.

모든 결과, nested draft/alias, outcome과 occurrence mapping은 frozen이다. SQLite integration
fixture는 실제 `BEGIN IMMEDIATE`/SAVEPOINT에서 resolve→select→finalize 후 명시적으로 rollback해
`journal`, `entities`, `id_redirects`가 빈 상태임을 확인한다. duplicate까지 넣은 잘못된 body는
REC-004 finalizer가 transaction 전체를 닫으며 candidate plan을 만들지 않는다.

## TDD와 검증

tests-only RED `a2e58eb`은 production build 뒤 application export가 없어 module load에서
실패했다.

```text
SyntaxError: application/index.js does not provide RecordDraftPlanningError
tests 1, pass 0, fail 1
```

GREEN `9cdfa39`은 pure selection/finalization과 rollback-only SQLite 결합을 구현했다.
후속 gate `1780b33`는 compile fixture, task 전용 명령, strictly ordered 승인 index,
independent entity/alias normalization과 conservative `class=secret` 경계를 추가했다.

전용 검증은 다음과 같다.

```bash
pnpm test:rec-005
pnpm verify:rec-005
```

현재 local gate는 architecture, strict typecheck, REC-005 compile contract, build와
PRJ-003/005/006·REC-003/004·REC-005 target **116/116**을 통과한다. REC-005 focused target은
unit 11개와 file-backed SQLite 3개, 합계 **14/14**다. 최신 `origin/main` `491f3a3`에
semantic rebase해 RCL-005 완료와 RCL-006 `IN_PROGRESS` planning 증거를 보존했다. 공유
application/SQLite export, package script와 test README에는 RCL-005 reader facet,
REC-004 writer/finalization seam과 REC-005 plan이 함께 남는다. RCL-006 planning-only delta는
source·test를 바꾸지 않았고, 전체 fast suite 53 files·423/423, PRJ-010 39/39,
RCL-005 21/21, RCL-004 15/15와 REC-004 70/70을 확인했다. 독립 behavior spike 25/25,
roadmap active 73·historical 74·evidence 67/67·ADR 17/17·scenario 24/24·link 425와 production
dependency audit 취약점 0개도 통과했다. 동등한 REC-005 내용의 rebase 전 HEAD `7cb7871`
독립 review는 HIGH/MEDIUM/LOW 0건이었다. 최신 main 통합 뒤 PR/main 증거가 아직 없으므로
작업 상태는 `IN_PROGRESS`로 유지한다.

## 남은 경계

- REC-006: masked raw/default metadata와 survivor parsed를 한 statement로 append, 동기 project,
  actual canonical claim ID와 공개 status 계산, 전체 rollback
- REC-007: raw-only/default TTL/reinterpret approval와 재시도 의미
- REC-008: S03/S18 record black-box, 저장 매체·log 전체 secret scan과 parsing 편차
- PRJ-010/REC-008: 최종 S03 vertical manifest target과 spike parity
