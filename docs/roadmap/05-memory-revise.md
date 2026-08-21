# Phase 05 — memory_revise 상태 변경 경로

- 상태: `TODO`
- 진행률: 0/7
- 선행 phase: Phase 04 `DONE`
- 주요 근거: ADR-001~003, ADR-007~010, ADR-013, ADR-015
- 선행 증거 감사: [Phase 05 baseline과 production gap](evidence-audit.md#phase-05-revise)
- 종료 조건: 철회·교정·병합·별칭이 모호성이나 경합을 숨기지 않고 모두 journal 사건과
  동기 projection으로 적용되며, undo와 full replay 결과가 일치함

> evidence audit의 `[x]`는 기존 증거 대조 완료다. 아래 작업의 `TODO/DONE`과 production
> 완료 체크를 대신하지 않는다.

## 작업 현황

| ID | 작업 | 상태 | Owner | 선행 작업 | 증거 |
|---|---|---|---|---|---|
| REV-001 | revise 판별 union schema와 결과 계약 | `TODO` | `unassigned` | FND-004, REC-001 | — |
| REV-002 | lock-bound target·redirect 해석 | `TODO` | `unassigned` | REV-001, REC-004 | — |
| REV-003 | claim·event retract와 cascade | `TODO` | `unassigned` | REV-002, PRJ-009 | — |
| REV-004 | correct 두 사건 원자 적용 | `TODO` | `unassigned` | REV-003, REC-006 | — |
| REV-005 | merge validation·적용·undo | `TODO` | `unassigned` | REV-002, PRJ-007 | — |
| REV-006 | alias 확인·중복·철회 | `TODO` | `unassigned` | REV-002, PRJ-007 | — |
| REV-007 | revise 경합·응답·회귀 suite | `TODO` | `unassigned` | REV-001~006 | — |

## 상세 체크리스트

### REV-001 — revise 판별 union schema와 결과 계약

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-002, ADR-013, ADR-015
- 선행 작업: FND-004, REC-001
- 결과물: MemoryReviseInput과 ReviseResult schema

완료 체크:

- [ ] retract/correct/merge/alias를 action discriminator의 엄격한 `oneOf`로 표현한다.
- [ ] correct raw_text·replacement, event cascade와 action별 필수/금지 필드를 강제한다.
- [ ] ID pattern, 문자열 상한, ClaimDraft 제한과 `additionalProperties:false`가 record와 같다.
- [ ] note, 자연어 target, merge/alias 값, correct raw/replacement 모두 같은 secret preflight를 거친다.
- [ ] applied/unchanged/ambiguous/not_found/rejected의 필수 필드 조합을 검증한다.
- [ ] scope와 actor/branch/session은 어떤 action 입력에도 없다.

### REV-002 — lock-bound target·redirect 해석

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-002, ADR-003, ADR-008, ADR-015
- 선행 작업: REV-001, REC-004
- 결과물: transaction-bound target/entity resolver와 preflight plan

완료 체크:

- [ ] schema·크기·secret만 lock 밖에서 검사하고 DB 상태는 queue+transaction 안에서 다시 읽는다.
- [ ] claim/entity ID는 redirect를 끝까지 따른 뒤 같은 scope와 종류를 검증한다.
- [ ] event는 과거의 같은 scope statement/merge/alias만 허용하고 존재 정보 누출을 막는다.
- [ ] 자연어 subject 후보 0개/복수는 not_found/ambiguous이며 사건을 쓰지 않는다.
- [ ] ambiguous 후보를 canonical claim_id와 간단한 text로 안정 정렬한다.

### REV-003 — claim·event retract와 cascade

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-001, ADR-007, ADR-009, ADR-015
- 선행 작업: REV-002, PRJ-009
- 결과물: retract command handler와 scope replay 경로

완료 체크:

- [ ] claim target은 retraction seq 이전 support만 끊고 같은 statement의 다른 claim을 유지한다.
- [ ] TTL만 만료됐어도 구조적으로 live인 support가 있으면 사건을 남긴다.
- [ ] statement 기본 cascade=true는 supersedes chain 전체, false는 exact event만 무효화한다.
- [ ] merge/alias event target은 해당 결정을 replay 입력에서 제외한다.
- [ ] 이미 의미가 없는 반복 호출만 unchanged이며 journal/projection을 바꾸지 않는다.
- [ ] body에 적용된 cascade 기본값을 명시해 미래 default 변경과 replay drift를 막는다.

### REV-004 — correct 두 사건 원자 적용

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-001, ADR-013, ADR-015
- 선행 작업: REV-003, REC-006
- 결과물: correct transaction handler

완료 체크:

- [ ] target과 replacement DB 검증 뒤 retraction과 statement를 연속 seq로 추가한다.
- [ ] replacement statement에 supersedes를 쓰지 않고 현재 created_at/provenance/ttl을 쓴다.
- [ ] correct provenance 기본값은 user_stated이며 raw_text와 replacement secret을 검사한다.
- [ ] event target은 statement만 허용하고 영향 claim 전체를 응답한다.
- [ ] 어느 append/project 단계든 실패하면 두 사건과 모든 projection을 rollback한다.

### REV-005 — merge validation·적용·undo

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-002, ADR-007~009, ADR-015
- 선행 작업: REV-002, PRJ-007
- 결과물: merge command handler와 before/after diff

완료 체크:

- [ ] keep/absorb를 ID 또는 surface에서 각각 정확히 한 canonical entity로 해석한다.
- [ ] same entity/already merged는 unchanged, 역방향·cycle·cross-scope는 안전하게 거부한다.
- [ ] event body에는 해석 완료한 entity ID와 secret-safe note만 저장한다.
- [ ] claim dedupe·describes 승자·surface origin·redirect 결과를 적용 전 diff로 계산한다.
- [ ] merge event 철회 full replay가 원래 entity/surface/claim을 복구한다.

### REV-006 — alias 확인·중복·철회

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-006~008, ADR-015
- 선행 작업: REV-002, PRJ-007
- 결과물: alias command handler

완료 체크:

- [ ] entity를 정확히 하나로 해석하고 surface 원문과 canonical entity_id를 사건에 저장한다.
- [ ] 이미 live confirmed mapping이면 unchanged, 약한 mapping이면 confirmed 사건을 추가한다.
- [ ] 같은 surface의 다른 entity mapping을 homonym으로 보존하고 자동 삭제/merge하지 않는다.
- [ ] alias event 철회 뒤 남은 name/agent_supplied origin으로 정확히 돌아간다.
- [ ] agent_supplied mapping 단독 철회 제한과 원 statement 재기록 절차를 note/문서에 안내한다.

### REV-007 — revise 경합·응답·회귀 suite

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-007, ADR-015와 behavior spike
- 선행 작업: REV-001~006
- 결과물: revise black-box/concurrency/oracle test suite

완료 체크:

- [ ] 두 claim statement의 claim/event 철회 범위 차이와 describes 복구 차이를 검증한다.
- [ ] correct event_ids가 정확히 2개이고 나머지 applied는 1개, 비적용 상태는 0개다.
- [ ] affected ID를 origin seq/숫자 suffix 순으로 안정 정렬한다.
- [ ] preflight와 lock 사이 merge/retraction 경합에서도 canonical 대상만 적용되거나 안전한 no-op다.
- [ ] S03~S08, S10, S11, S13~S17과 crash rollback이 production 결과로 통과한다.
- [ ] 모든 applied 결과를 즉시 full replay해 같은 canonical dump를 얻는다.

## Phase 종료 체크

- [ ] 네 action이 모두 append-only 사건만으로 현재 믿음을 바꾼다.
- [ ] ambiguity·not found·rejected·unchanged가 journal을 불필요하게 늘리지 않는다.
- [ ] correct 원자성과 merge/alias undo가 crash와 full replay 뒤에도 보존된다.
- [ ] 공개 MCP adapter가 안정적인 result와 actionable note를 그대로 노출할 수 있다.
