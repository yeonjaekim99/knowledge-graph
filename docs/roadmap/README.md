# Recall 구현 로드맵

> 기준일: 2026-08-22
> 범위: Recall v1 production 구현
> 현재 상태: **Phase 02 진행 중 · STO-008 구현 중**

이 디렉터리는 [Accepted ADR](../adr/README.md)을 팀이 실행할 수 있는 작업 순서와
체크리스트로 바꾼다. ADR은 **왜와 무엇을**, 이 로드맵은 **순서·담당·완료 증거를**
소유한다. 내용이 충돌하면 ADR이 우선하며, 구현 편의를 이유로 로드맵에서 ADR 의미를
바꾸지 않는다.

## 현재 현황

| 구분 | 완료 | 전체 | 판정 |
|---|---:|---:|---|
| 구현 준비 | 7 | 7 | 완료 |
| 제품 구현 | 13 | 66 | 진행 중 |
| 전체 | 20 | 73 | Phase 02 구현 중 |

진행률은 수동 퍼센트가 아니라 `DONE 작업 수 / 전체 작업 수`로만 표시한다. 상세 문서의
작업 상태와 증거가 원본이며 이 표는 각 PR에서 함께 갱신하는 roll-up이다.

[Evidence-gap audit](evidence-audit.md)의 `[x]`는 제품 작업별 선행 증거 대조가 끝났다는
뜻이며 제품 작업 진행률에는 포함하지 않는다. 제품 `DONE`은 production 결과물과 해당
phase의 완료 체크·PR 증거가 있을 때만 계산한다.

## 단계와 의존성

```text
00 Readiness → 01 Foundation → 02 Storage → 03 Projection ─┬→ 04 Record → 05 Revise ─┐
                                                            └→ 06 Recall ─────────────┼→ 07 MCP → 08 Release
```

Phase 04와 06은 Phase 03 종료 후 병렬 진행할 수 있다. Phase 05는 `memory_record`의
검증·결과 타입을 재사용하므로 Phase 04에 의존한다. 공개 MCP 통합은 세 application
service가 모두 준비된 뒤 시작한다.

| Phase | 문서 | 상태 | 완료/전체 | 진입 조건 | 핵심 결과 |
|---:|---|---|---:|---|---|
| 00 | [구현 준비](00-readiness.md) | `DONE` | 7/7 | 없음 | ADR·spike·로드맵·작업 계약·증거 gap 합의 |
| 01 | [개발 기반](01-foundation.md) | `DONE` | 6/6 | Phase 00 `DONE` | 기술 선택, 모듈 경계, 로컬 검증 기반 |
| 02 | [SQLite·저널](02-storage.md) | `IN_PROGRESS` | 7/8 | Phase 01 `DONE` | migration, scope, writer, journal |
| 03 | [투영·재생](03-projection.md) | `TODO` | 0/10 | Phase 02 `DONE` | 증분/전체 replay parity |
| 04 | [`memory_record`](04-memory-record.md) | `TODO` | 0/8 | Phase 03 `DONE` | 안전한 기록 수직 경로 |
| 05 | [`memory_revise`](05-memory-revise.md) | `TODO` | 0/7 | Phase 04 `DONE` | 철회·교정·병합·별칭 |
| 06 | [`memory_recall`](06-memory-recall.md) | `TODO` | 0/9 | Phase 03 `DONE` | FTS·그래프·랭킹·응답 |
| 07 | [MCP 통합](07-mcp-integration.md) | `TODO` | 0/8 | Phase 04~06 `DONE` | 공개 tool 계약과 client 검증 |
| 08 | [강화·릴리스](08-hardening-release.md) | `TODO` | 0/10 | Phase 07 `DONE` | 성능·보안·운영 release gate |

측정 조건이 충족되기 전 구현하면 안 되는 최적화와 범위 확장은
[Deferred 결정 목록](deferred-decisions.md)에 분리한다.

## 상태 모델

작업 상태는 다음 네 값만 사용한다.

| 상태 | 의미 |
|---|---|
| `TODO` | 선행 조건을 기다리거나 아직 착수하지 않음 |
| `IN_PROGRESS` | 담당자가 정해졌고 구현 PR 또는 명시적인 작업 branch가 존재함 |
| `BLOCKED` | 외부 결정·권한·환경 문제로 진행할 수 없으며 blocker가 기록됨 |
| `DONE` | 모든 완료 체크, 리뷰, 검증과 main 병합이 끝나 증거 링크가 있음 |

`BLOCKED`는 단순 미착수나 난이도를 뜻하지 않는다. 반드시 상세 작업 아래에 blocker
발생일, 막힌 이유, 필요한 결정과 해제 책임자를 적는다.

## 진행 현황 갱신 규칙

1. 구현 PR을 시작할 때 담당 phase의 작업 상태를 `IN_PROGRESS`로 바꾸고 owner와 PR을
   기록한다.
2. 하나의 작업에는 최종 책임자 한 명만 둔다. 공동 작업자는 PR과 비고에 기록한다.
3. 같은 PR에서 완료 체크박스, 작업 상태, 증거와 이 문서의 roll-up을 함께 갱신한다.
4. `DONE` 증거에는 최소 PR 링크와 재현 가능한 로컬 검증 명령·결과가 있어야 한다.
5. 체크박스 일부만 끝났으면 상태를 `DONE`으로 바꾸지 않는다.
6. 후속 작업이 생기면 기존 ID의 의미를 바꾸지 않고 해당 phase의 다음 번호를 발급한다.
7. 작업 삭제 대신 `CANCELLED`를 새 상태로 만들지 않는다. 필요 없어졌다면 ADR/결정
   근거와 함께 [`retired-tasks.json`](retired-tasks.json)에 영구 tombstone을 남기고,
   active 표·의존성·완료율에서 제외하는 별도 roadmap PR을 리뷰한다. retired ID는 다시
   active 작업이나 새 의미에 사용하지 않는다.

GitHub Issue와 PR은 실행 기록이고, 이 저장소의 roadmap이 전체 상태의 단일 현황판이다.
GitHub Project를 쓰더라도 이 문서의 상태를 대체하지 않는다.

## 공동 작업 운영 리듬

1. phase 진입 시 선행 작업이 `DONE`인 항목만 골라 planning PR에서 owner를 배정하고
   `IN_PROGRESS`로 바꾼다. 여러 작업을 한 번에 배정해도 각 작업에는 owner 한 명만 둔다.
2. GitHub Issue와 PR 제목에 안정적인 ID를 넣는다. 예: `[PRJ-003] occurrence ID 구현`.
3. 구현 PR은 원칙적으로 작업 하나를 닫는다. 강하게 결합된 여러 작업을 한 PR에 넣으면
   설명에 포함 ID와 각각의 완료 증거를 나눈다.
4. 작업 중 새 범위가 보이면 원래 ID 의미를 키우지 않는다. 후속 ID를 만들거나 ADR
   변경 절차를 따른다.
5. 막히면 다음 상태 정리 주기를 기다리지 않고 blocker 정보와 필요한 결정을 roadmap에
   올린다. 다른 작업자가 이어받을 수 있도록 마지막 정상 검증 결과도 남긴다.
6. 구현 PR 병합 때 작업 체크·증거·상태와 상위 진행률을 함께 갱신한다. phase 마지막
   작업은 Phase 종료 체크와 다음 phase 진입 조건도 리뷰한다.

planning PR은 owner 선점 충돌을 막는 상태 동기화 지점이다. 실제 토론과 세부 실행 로그는
Issue/PR에 두고, roadmap에는 현재 판정과 영속적인 증거만 남긴다.

## 로드맵 검증

문서를 갱신한 PR은 다음 구조 검사를 로컬에서 실행하고 결과를 PR에 남긴다.

```bash
python3 docs/roadmap/validate.py
```

검사는 active/retired 작업 수와 안정적인 ID, 현황/상세 상태 일치, owner와 체크박스,
retired dependency와 의존성 cycle, 문서 링크, ADR 17개·scenario 24개 추적성, historical
제품 ID 67개(66 active + 1 retired)의 evidence-gap 감사와 상위 진행률을 함께 확인한다.

## 공통 Definition of Done

모든 제품 작업은 phase별 체크에 더해 다음을 만족해야 한다.

- [ ] Accepted ADR과 public schema를 위반하지 않는다.
- [ ] 정상·경계·실패 경로 테스트가 있다.
- [ ] 상태 의미를 바꾸는 작업은 [behavior spike oracle](../../spikes/adr-behavior/README.md)
      또는 독립 reference query와 parity를 확인한다.
- [ ] scope 누출, 비밀값 echo와 journal/projection 부분 commit이 없다.
- [ ] 사용자·운영자가 알아야 할 변경을 문서화한다.
- [ ] reviewer가 완료 체크와 증거를 확인했다.
- [ ] PR이 `main`에 병합됐고 작업 문서의 필수 로컬 검증이 통과했다.

## ADR 변경과 blocker 처리

- 구현이 ADR과 맞지 않으면 구현을 멈추고 `BLOCKED`로 표시한다. 현재 ADR을 조용히
  우회하거나 roadmap만 바꾸지 않는다.
- 기존 결정을 바꿔야 하면 새 ADR이 기존 ADR을 supersede하도록 작성하고 Accepted된 뒤
  작업을 재개한다.
- 라이브러리 API 차이처럼 의미를 바꾸지 않는 선택은 Phase 01의 implementation decision
  문서에 남긴다.
- 성능 최적화는 [Deferred 결정 목록](deferred-decisions.md)의 측정 trigger를 통과한
  경우에만 후속 ADR로 올린다.

## 작업 항목 형식

새 작업은 [작업 템플릿](task-template.md)을 복사한다. 작업 ID, ADR, 선행 조건, owner,
상태, 결과물, 완료 체크와 증거를 생략하지 않는다. 같은 PR에서 evidence-gap audit 행도
추가해 기존 baseline과 production 잔여 범위를 분리한다. 날짜는 `YYYY-MM-DD`, owner는
GitHub handle로 적고 미정이면 `unassigned`를 쓴다.

## 기준 자료

- [초기 설계](../init-design.md)
- [Accepted ADR 목록](../adr/README.md)
- [ADR 전체 리뷰](../adr/review.md)
- [behavior spike 결과](../spikes/adr-behavior-report.md)
- [behavior scenario matrix](../../spikes/adr-behavior/scenario-matrix.json)
- [ADR·spike 추적성 표](traceability.md)
- [기존 증거와 production 잔여 gate 감사](evidence-audit.md)
- [범위에서 제외된 작업 registry](retired-tasks.json)
- [FND-006 CI 작업 범위 제외 결정](../implementation/fnd-006-ci-retirement.md)
- [로드맵 자체 리뷰](review.md)
