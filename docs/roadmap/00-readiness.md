# Phase 00 — 구현 준비

- 상태: `DONE`
- 진행률: 6/6
- 선행 phase: 없음
- 종료 조건: RDY-001~006이 모두 `DONE`

이 phase는 제품 코드를 만들지 않는다. 설계가 닫혔고 구현이 검증 가능한 상태인지,
그리고 팀이 같은 현황판을 볼 수 있는지를 확정한다.

## 작업 현황

| ID | 작업 | 상태 | Owner | 근거 | 증거 |
|---|---|---|---|---|---|
| RDY-001 | ADR-001~017 확정 | `DONE` | `log0629` | 전체 ADR | [PR #1](https://github.com/yeonjaekim99/knowledge-graph/pull/1) |
| RDY-002 | ADR 교차 리뷰 | `DONE` | `log0629` | ADR review | [review.md](../adr/review.md) |
| RDY-003 | 핵심 behavior spike | `DONE` | `log0629` | ADR-001~017 | [PR #2](https://github.com/yeonjaekim99/knowledge-graph/pull/2) |
| RDY-004 | 적대적·crash spike | `DONE` | `log0629` | ADR-001, 002, 005, 007, 015, 017 | [spike report](../spikes/adr-behavior-report.md) |
| RDY-005 | 공동 구현 로드맵 게시 | `DONE` | `log0629` | 전체 ADR·spike | [PR #3](https://github.com/yeonjaekim99/knowledge-graph/pull/3) |
| RDY-006 | 에이전트 공통 작업 계약 게시 | `DONE` | `log0629` | 전체 ADR·roadmap | [PR #4](https://github.com/yeonjaekim99/knowledge-graph/pull/4) |

## 상세 체크리스트

### RDY-001 — ADR-001~017 확정

- 상태: `DONE`
- Owner: `log0629`
- 결과물: [Accepted ADR 목록](../adr/README.md)

완료 체크:

- [x] 17개 ADR이 Context / Decision / Alternatives / Consequences / Validation 형식을 갖는다.
- [x] 초기 설계의 미결 항목이 담당 ADR에서 닫혔다.
- [x] 모든 ADR 상태가 `Accepted`이며 의존 관계가 검토됐다.
- [x] PR #1이 `main`에 병합됐다.

### RDY-002 — ADR 교차 리뷰

- 상태: `DONE`
- Owner: `log0629`
- 선행 작업: RDY-001
- 결과물: [ADR 전체 리뷰](../adr/review.md)

완료 체크:

- [x] 규범 DDL과 TypeScript 타입의 충돌을 확인했다.
- [x] ID, scope, TTL, 철회, replay와 MCP 계약을 시나리오로 교차 검증했다.
- [x] 구현 단계에 남은 release gate와 의도적 제한을 분리했다.

### RDY-003 — 핵심 behavior spike

- 상태: `DONE`
- Owner: `log0629`
- 선행 작업: RDY-001, RDY-002
- 결과물: [실행형 reference spike](../../spikes/adr-behavior/README.md)

완료 체크:

- [x] record/recall/revise와 replay/reinterpret 핵심 상태 전이를 실행했다.
- [x] S01~S22가 ADR과 기계 판독 가능한 매트릭스로 연결됐다.
- [x] spike가 production source가 아님을 명시했다.

### RDY-004 — 적대적·crash spike

- 상태: `DONE`
- Owner: `log0629`
- 선행 작업: RDY-003
- 결과물: [spike 결과 보고서](../spikes/adr-behavior-report.md)

완료 체크:

- [x] 288개 결정적 operation prefix가 replay checksum과 독립 SQL 불변식을 통과했다.
- [x] scope interleaving, correct 분해, merge/alias undo와 TTL time-shift를 검증했다.
- [x] 8개 hard process exit case가 완전한 이전/새 상태 중 하나로 복구됐다.
- [x] 차단성 ADR defect가 0개임을 확인했다.

### RDY-005 — 공동 구현 로드맵 게시

- 상태: `DONE`
- Owner: `log0629`
- 선행 작업: RDY-001~004
- 결과물: `docs/roadmap/`

완료 체크:

- [x] phase 의존성과 67개 제품 작업에 안정적인 ID를 부여했다.
- [x] 모든 작업에 owner, 상태, ADR, 선행 조건, 완료 체크와 증거 필드를 정의했다.
- [x] ADR-001~017과 spike 잔여 gate의 추적성 리뷰가 통과했다.
- [x] 자체 리뷰와 검증을 거친 roadmap PR #3이 `main`에 병합됐다.

증거:

- PR: [#3](https://github.com/yeonjaekim99/knowledge-graph/pull/3)
- 검증: [추적성 표](traceability.md), [로드맵 자체 리뷰](review.md)

### RDY-006 — 에이전트 공통 작업 계약 게시

- 상태: `DONE`
- Owner: `log0629`
- 선행 작업: RDY-001~005
- 결과물: [공통 작업 규칙](../../AGENTS.md), [Claude Code 진입 파일](../../CLAUDE.md)

완료 체크:

- [x] `AGENTS.md`가 ADR, roadmap, checklist와 spike의 우선순위 및 작업 전 확인 절차를 정의한다.
- [x] 제품 구현의 branch, owner, 상태 전이, 검증, 리뷰, 증거와 인계 규칙을 정의한다.
- [x] 핵심 아키텍처 불변식과 ADR 충돌 시 `BLOCKED`/superseding ADR 절차를 명시한다.
- [x] `CLAUDE.md`가 공통 규칙을 복제하지 않고 `@AGENTS.md`를 불러온다.
- [x] roadmap validator와 behavior spike 전체 회귀가 통과했다.
- [x] 작업 계약 PR #4가 `main`에 병합됐다.

증거:

- PR: [#4](https://github.com/yeonjaekim99/knowledge-graph/pull/4)
- 검증: [로드맵 자체 리뷰](review.md), `python3 docs/roadmap/validate.py`, behavior spike 25 tests

## Phase 종료 체크

- [x] 의미 설계와 spike 검증이 완료됐다.
- [x] 팀이 `main`에서 동일한 roadmap을 볼 수 있다.
- [x] Codex와 Claude Code가 같은 공통 작업 계약에서 시작한다.
- [x] FND-001의 선행 조건과 완료 기준이 roadmap에 명시됐다.
