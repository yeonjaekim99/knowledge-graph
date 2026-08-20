# Recall Architecture Decision Records

이 디렉터리는 Recall의 구현을 구속하는 Architecture Decision Record(ADR)를 담는다.
초기 설계 초안은 [`../init-design.md`](../init-design.md)이며, 각 주제의 최종 규범은
상태가 `Accepted`인 담당 ADR이다.

## 규범 우선순위

1. 명시적으로 다른 ADR을 대체한다고 선언한 최신 `Accepted` ADR
2. 해당 주제를 소유하는 `Accepted` ADR
3. `init-design.md`의 DDL과 타입 정의
4. `init-design.md`의 설명과 예시

ADR끼리 충돌하거나 담당 ADR과 초기 설계가 설명 없이 다르면 문서 버그다. ADR 번호가
크다는 이유만으로 앞선 ADR을 자동 대체하지 않는다. 대체할 때는 `Supersedes`를
명시한다.

## 상태

- `Proposed`: 결정 후보이며 구현을 구속하지 않는다.
- `Accepted`: 검토를 마친 규범이며 구현을 구속한다.
- `Superseded`: 다른 ADR로 대체됐다.
- `Deprecated`: 더 이상 적용되지 않으며 대체 결정이 없을 수 있다.

## ADR 목록

| ID | 제목 | 선행 ADR | 상태 |
|---|---|---|---|
| [ADR-001](001-journal-projection.md) | 저널/투영 2층 구조, 불변식, 재생·재해석 경계 | — | Accepted |
| [ADR-002](002-identifiers.md) | 식별자 발급 규칙과 재생 안정성 | ADR-001 | Accepted |
| [ADR-003](003-scope.md) | scope_key 구성과 결정 경로 | ADR-001 | Accepted |
| [ADR-004](004-relations.md) | 관계 어휘, 카디널리티, 승격 절차 | — | Accepted |
| [ADR-005](005-fts-and-concurrency.md) | FTS 색인 대상, 토크나이저, 동기화 | — | Accepted |
| [ADR-006](006-normalization.md) | 정규화 규칙과 강도 | — | Accepted |
| [ADR-007](007-replay.md) | 재생 규칙과 사건별 처리 순서 | ADR-001, ADR-002, ADR-003, ADR-004 | Accepted |
| [ADR-008](008-entity-resolution.md) | 개체 해석, kind 불일치, 경합 처리 | ADR-002, ADR-003, ADR-006, ADR-007 | Accepted |
| [ADR-009](009-reinforcement-replacement.md) | 강화·대체 규칙 | ADR-004, ADR-007, ADR-008 | Accepted |
| [ADR-010](010-claim-aggregation.md) | 신뢰도·만료·상충 산출 방식과 캐시 전환 조건 | ADR-008, ADR-009 | Accepted |
| [ADR-011](011-secret-detection.md) | 비밀값 탐지 규칙과 오탐 처리 | — | Accepted |
| [ADR-012](012-recall-traversal-ranking.md) | 확장·수집 알고리즘, 경로 복원, 랭킹, 문장 조합 | ADR-005, ADR-010 | Accepted |
| [ADR-013](013-memory-record.md) | memory_record 인터페이스 | ADR-003, ADR-004, ADR-007, ADR-010, ADR-011 | Accepted |
| [ADR-014](014-memory-recall.md) | memory_recall 인터페이스와 응답 형태 | ADR-003, ADR-012 | Accepted |
| [ADR-015](015-memory-revise.md) | memory_revise 동작 정의, 철회 범위, 병합 절차 | ADR-007, ADR-013 | Accepted |
| [ADR-016](016-mcp-tool-contract.md) | 도구 명명·annotation·description 규약 | ADR-013, ADR-014, ADR-015, ADR-017 | Accepted |
| [ADR-017](017-replay-reinterpret.md) | 재생·재해석 절차와 회귀 비교 방법 | ADR-001, ADR-007, ADR-013 | Accepted |

## 작성 및 검토 순서

```text
ADR-001 ─ ADR-002/ADR-003 ─ ADR-007 ─ ADR-008 ─ ADR-009 ─ ADR-010
ADR-004 ────────────────┘        │                    │
ADR-006 ─────────────────────────┘                    ├─ ADR-012 ─ ADR-014 ─┐
ADR-005 ─────────────────────────────────────────────┘                     │
ADR-011 ────────────────┐                                                  │
ADR-003/004/007/010 ─ ADR-013 ─ ADR-015 ──────────────────────────────────┤
                              └─ ADR-017 ───────────────────────────────── ADR-016
```

독립 ADR을 먼저 작성할 수는 있지만, `Accepted` 여부는 모든 선행 ADR과의 정합성을
확인한 뒤 확정한다.

## 공통 불변식

- `journal`만이 기억의 유일한 진실 원천이다.
- 도구 핸들러는 투영을 직접 수정하지 않는다. 투영기는 저널 사건만 입력으로 받는다.
- 같은 저널과 같은 규칙 버전은 논리적으로 같은 투영을 만든다.
- 철회된 결정은 전체 재생 뒤에도 되살아나지 않는다.
- `scope_key`는 서버가 결정하며 도구 호출자가 넓힐 수 없다.
- 비밀값 검사는 저널 INSERT보다 먼저 끝난다.
- 읽기 경로는 저널이나 투영을 수정하지 않는다.
- 철회·만료된 parsed claim은 raw fallback으로 다시 노출하지 않는다.
- recall 한 호출은 같은 DB snapshot과 고정된 기준 시각을 사용한다.

## 전체 리뷰 통과 조건

- 17개 ADR이 모두 `Accepted`이고 필수 네 절을 포함한다.
- 초기 설계 9장의 미결 사항이 담당 ADR에서 결정됐다.
- 모든 DDL이 깨끗한 SQLite 데이터베이스에 적용된다.
- 외래 키 검사와 FTS5 기본 검색 검사가 통과한다.
- 기록, 강화, 사실 철회, 사건 철회, 정정, 병합, 병합 취소, 별칭, 재해석,
  TTL 만료, 표면형/FTS 조회 시나리오가 불변식과 모순되지 않는다.
- 용어, ID 형식, 시간 단위, 상태값과 타입이 ADR 전체에서 일치한다.

2026-08-20 전체 리뷰에서 위 문서 조건과 실행 가능한 DDL/FTS 검사를 통과했다. 발견한
문제와 구현 단계의 잔여 release gate는 [`review.md`](review.md)에 기록했다.
