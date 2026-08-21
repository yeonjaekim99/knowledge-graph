# ADR·spike 추적성

이 표는 설계 결정과 spike 증거가 어느 production 작업에서 구현되고 어느 후속 작업에서
검증되는지 보여준다. “spike 통과”는 production gate를 면제하지 않는다. 구현 PR은 자신이
닫는 작업 ID에서 이 표를 따라 관련 ADR Validation을 다시 확인해야 한다.

작업별로 이미 재사용할 수 있는 증거와 실제로 남은 범위는
[evidence-gap audit](evidence-audit.md)에 분리돼 있다. 이 표의 scenario 연결을 신규 작업으로
반복하지 말고, 해당 audit 행의 production gap만 구현 범위로 삼는다.

## ADR → 구현 → production 검증

| ADR | 주요 구현 작업 | production 검증·운영 작업 |
|---|---|---|
| ADR-001 | FND-002, STO-007, PRJ-001, PRJ-009 | PRJ-010, REL-002, REL-004, REL-007 |
| ADR-002 | FND-003, STO-007, PRJ-003, PRJ-007 | PRJ-010, REV-007, REL-007 |
| ADR-003 | FND-003, STO-005, STO-006, MCP-006 | RCL-008, MCP-007, REL-005 |
| ADR-004 | PRJ-002, REC-001, MCP-004 | PRJ-010, MCP-008, REL-006 |
| ADR-005 | STO-001, STO-002, STO-004, RCL-003 | STO-008, RCL-009, REL-003, REL-004 |
| ADR-006 | PRJ-002, PRJ-005, RCL-002 | PRJ-010, RCL-008, REL-006, REL-007 |
| ADR-007 | STO-004, PRJ-004, PRJ-006, PRJ-009 | PRJ-010, REV-007, REL-007 |
| ADR-008 | PRJ-005, PRJ-007, REC-004, REV-005, REV-006 | PRJ-010, REV-007, REL-006 |
| ADR-009 | PRJ-006, PRJ-007, REC-005, REV-003, REV-004 | PRJ-010, REV-007 |
| ADR-010 | FND-003, PRJ-008, RCL-001, RCL-006 | RCL-008, REL-003, REL-006 |
| ADR-011 | REC-002, REC-003, MCP-005 | REC-008, MCP-007, REL-005 |
| ADR-012 | RCL-002~007 | RCL-008, RCL-009, REL-003 |
| ADR-013 | FND-004, REC-001~008 | REC-008, MCP-003, MCP-008, REL-008 |
| ADR-014 | FND-004, RCL-001~008 | RCL-008, MCP-003, MCP-007 |
| ADR-015 | FND-004, REV-001~007 | REV-007, MCP-007, MCP-008 |
| ADR-016 | FND-004, MCP-002~006 | MCP-007, MCP-008, REL-010 |
| ADR-017 | FND-003, PRJ-001, PRJ-004, PRJ-009, REC-007, REL-007, REL-008 | PRJ-010, REL-002, REL-008, REL-010 |

ADR-016은 behavior spike에서 의도적으로 실행하지 않은 유일한 transport 결정이다.
MCP-002~008이 catalog, schema, annotation, description, Inspector와 agent fixture를 별도
production gate로 닫는다.

## 공통 production test 기반

[FND-005 테스트 전략](../implementation/fnd-005-test-strategy.md)과
[`adr-production-scenarios.json`](../../test/manifests/adr-production-scenarios.json)은 아래
S01~S24 각각에 유일한 production target, test 계층과 이 표의 전체 owner 작업을 고정한다.
foundation drift test가 source matrix checksum, ADR·task 연결과 target 상태를 검사한다.
현재 target은 모두 `planned`이며, 실제 동작과 black-box test는 각 행의 구현·검증 작업이
같은 PR에서 추가한다. 공통 harness가 있다는 사실은 개별 production gate의 완료 증거를
대신하지 않는다.

## Spike scenario → production 회귀

| Scenario | 핵심 동작 | 구현 작업 | production 검증 작업 |
|---|---|---|---|
| S01 | SQLite capability·normalize·FTS rebuild | STO-001, STO-004, PRJ-002 | STO-008, PRJ-010 |
| S02 | append/project rollback·반복 replay | STO-007, PRJ-001, PRJ-009 | PRJ-010, REL-007 |
| S03 | occurrence ID·요청 dedupe·강화 | PRJ-003, PRJ-006, REC-005 | REC-008, PRJ-010 |
| S04 | describes와 두 철회 범위 | PRJ-006, REV-003 | REV-007, PRJ-010 |
| S05 | claim/statement 철회 범위 | REV-003 | REV-007 |
| S06 | correct 연속 두 사건·rollback | REV-004 | REV-007, REL-004 |
| S07 | merge·support dedupe·redirect·undo | PRJ-007, REV-005 | REV-007, PRJ-010 |
| S08 | alias 확인·origin 복원 | PRJ-005, PRJ-007, REV-006 | REV-007, PRJ-010 |
| S09 | scope aggregate·ID 비노출 | STO-005, REV-002, RCL-001 | REV-007, RCL-008 |
| S10 | TTL aggregate·label fallback·contested | PRJ-008, RCL-006 | RCL-008 |
| S11 | raw TTL과 parsed claim 부활 방지 | REC-007, RCL-003 | RCL-008 |
| S12 | 양방향 traversal·literal·path | RCL-005, RCL-006 | RCL-008 |
| S13 | hub fanout 절단 신호 | RCL-005, RCL-007 | RCL-008, REL-003 |
| S14 | reinterpret metadata/order·철회 cutoff | PRJ-004, REC-007, REL-008 | PRJ-010, REL-008 |
| S15 | backdated reinterpret 우선순위·undo | PRJ-004, PRJ-006, REV-003 | PRJ-010, REL-008 |
| S16 | payload-bound approval·stale·expiry | FND-003, REC-007, REL-008 | REL-008 |
| S17 | merge describes 구조 순서 | PRJ-007, REV-005 | PRJ-010, REV-007 |
| S18 | secret mask·부분 거부·revise fail-closed | REC-002, REC-003, REC-005, REV-001 | REC-008, REV-007, REL-005 |
| S19 | overview 결정성·read-only | RCL-004 | RCL-008 |
| S20 | serialized writer·WAL reader | STO-002 | STO-008, REL-004 |
| S21 | confirmed alias의 후속 entity 해석 | PRJ-005, REC-004, REV-006 | PRJ-010, REV-007 |
| S22 | invalid surface에서 FTS/raw overview fallback | RCL-003, RCL-004 | RCL-008 |
| S23 | adversarial prefix·metamorphic invariant | PRJ-009 | PRJ-010, REL-007 |
| S24 | process crash·reopen 원자성 | STO-007, PRJ-009 | STO-008, PRJ-010, REL-004 |

## Spike에서 발견한 production 위험의 귀속

| 발견 사항 | 소유 작업 | 닫히는 증거 |
|---|---|---|
| aggregate/claim의 동명 SQL column 충돌 | RCL-001 | explicit alias fixture, RCL-008 golden |
| Unicode `\b`가 provider token+한국어 조사를 놓침 | REC-002 | ASCII lookaround corpus, REC-008/REL-005 scan |
| 기존 entity occurrence도 ID 위치를 소비 | PRJ-003, REC-005 | occurrence/index mapping fixture, PRJ-010 |
| schema bootstrap reopen 시 checksum 검증 필요 | STO-003 | 정상·crash reopen, STO-008 |

## 최종 양방향 audit

REL-010은 다음 두 방향을 모두 확인한다.

- ADR/Scenario → 최소 하나의 구현 작업과 production 검증 증거가 존재한다.
- `DONE` 제품 작업 → 관련 ADR, test·로컬 검증과 병합 PR 증거가 존재한다.

새 ADR 또는 scenario가 생기면 같은 PR에서 이 표와 해당 phase 작업을 함께 갱신한다.
