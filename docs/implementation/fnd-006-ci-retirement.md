# FND-006: CI 작업 범위 제외 결정

- 상태: Accepted
- 결정일: 2026-08-21
- 원래 작업: FND-006
- 결정자: repository maintainer `log0629`
- 규범 관계: ADR을 대체하지 않는 roadmap scope decision

## 결론

Recall v1에서는 자동 CI workflow를 구축하거나 필수 merge gate로 운영하지 않는다.
`FND-006`은 active roadmap과 완료율 계산에서 제외하고, 안정적인 ID를 재사용하지 않도록
[`retired-tasks.json`](../roadmap/retired-tasks.json)에 영구 기록한다. 이 제외는 새로운
상태값이 아니므로 `TODO`, `IN_PROGRESS`, `BLOCKED`, `DONE` 상태 모델은 그대로 유지한다.

CI가 맡으려던 검증 자체를 없애는 결정은 아니다. 다음 두 active 작업이 로컬 gate를
나누어 소유한다.

- `FND-005`: unit, SQLite integration, MCP contract, process e2e, performance test 계층과
  결정적 실행 명령을 제공한다.
- `FND-007`: 깨끗한 checkout에서 설치와 필수 로컬 검증을 재현하는 기여 절차를 문서화한다.

각 구현 PR은 연결된 작업 문서의 명령을 로컬에서 실행하고 결과를 PR에 남긴다. reviewer는
그 결과와 diff를 확인한 뒤 merge한다. 외부 자동화가 우연히 존재하더라도 Recall v1의
완료 판정 근거나 필수 gate로 간주하지 않는다.

## 배경

기존 roadmap은 `FND-006`에서 format, lint, typecheck, test, schema와 문서 drift 검사를
PR 필수 CI로 묶도록 계획했다. maintainer는 현 단계에서 CI 운영 비용을 들이지 않고 로컬
TDD 흐름으로 개발하기로 결정했다. 따라서 CI라는 전달 수단만 범위에서 제거하고, 테스트와
검증 책임은 active 작업에 남겨야 한다.

안정적인 작업 ID를 행째 삭제하거나 다른 의미로 재사용하면 과거 PR과 roadmap 참조가
모호해진다. 반대로 `CANCELLED` 같은 다섯 번째 상태를 만들면 기존 상태 모델과 agent 계약을
깨뜨린다. 별도 registry의 tombstone이 두 문제를 모두 피한다.

## 적용 규칙

1. `FND-006`은 active phase 표, 상세 체크리스트, 의존성, phase/전체 완료율에서 제외한다.
2. historical ID 집합과 evidence-gap audit에는 원래 제목, 제외일, 이유와 이 결정 링크를
   남긴다.
3. roadmap validator는 active ID와 retired ID의 중복, retired ID 재사용, retired 작업에
   대한 active dependency, registry 형식·날짜·결정 링크, historical ID 연속성을 검사한다.
4. `FND-007`은 `FND-001`~`FND-005`만 선행 작업으로 요구한다.
5. 향후 CI가 필요해져도 `FND-006`을 되살리거나 재사용하지 않는다. 당시 범위와 근거를
   가진 새 stable task ID를 발급한다.

## 대안

### FND-006을 `DONE` 처리

구현되지 않은 CI를 완료로 표현하므로 사실과 다르다. 완료율과 증거 의미를 훼손해
선택하지 않았다.

### FND-006을 `BLOCKED` 또는 `TODO`로 유지

더 이상 수행할 계획이 없는 작업이 다음 작업과 phase 종료를 계속 막는다. blocker가 아닌
scope 결정이므로 선택하지 않았다.

### FND-006 행과 ID를 완전히 삭제

과거 문서와 대화에서 가리킨 안정적인 ID가 사라지고 나중에 재사용될 수 있다. roadmap의
stable ID 계약을 위반하므로 선택하지 않았다.

### 지금 CI를 구현

자동 검증과 merge 차단은 장점이 있지만 현재 maintainer의 범위 결정과 맞지 않는다.
필수 로컬 검증과 reviewer 확인으로 v1을 진행한다.

## 결과와 위험

- active 제품 작업은 67개에서 66개, 전체 active 작업은 74개에서 73개가 된다.
- Phase 01은 7개가 아니라 6개 active 작업으로 완료를 판정한다.
- PR에서 검증 누락을 자동으로 차단하지 못한다. 이를 완화하기 위해 작업별 단일 명령,
  clean checkout 재현 절차, PR 검증 기록과 reviewer 확인을 필수로 둔다.
- GitHub-hosted runner 차이나 workflow 유지보수는 v1 범위에서 사라진다.
- Accepted ADR의 상태 의미, 제품 schema와 release 품질 기준은 바뀌지 않는다.

## 검증

```bash
python3 docs/roadmap/validate.py
git diff --check
```

validator 출력은 active task 73개, historical task 74개, retired task 1개, active 제품 작업
66개와 evidence audit historical row 67개를 구분해야 한다. 실패 검증으로는 retired ID를
active 표나 dependency에 다시 넣었을 때 validator가 거부하는지를 확인한다.

## 증거

- PR: [#10](https://github.com/yeonjaekim99/knowledge-graph/pull/10)
- 결정 출처: 2026-08-21 maintainer 요청
