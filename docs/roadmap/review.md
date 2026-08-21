# 구현 로드맵 자체 리뷰

- 리뷰일: 2026-08-21
- 대상: `docs/roadmap/`과 root README 진입 링크
- 기준: Accepted ADR-001~017, ADR 전체 리뷰, behavior spike S01~S24
- 성격: 작성자 자체 교차 검토. RDY-005의 팀 PR 리뷰·main 병합을 대체하지 않음
- 결과: **문서 구조와 추적성 통과 · 차단 결함 0개 · 게시 절차만 남음**

## 검토 결과

| 검토 축 | 결과 | 근거 |
|---|---|---|
| 작업 구조 | 통과 | 준비 5개 + 제품 67개, 상세 heading과 현황 행 1:1 |
| 의존성 | 통과 | 00→01→02→03 이후 record/recall 병렬, revise와 MCP/release gate 순서 일치 |
| ADR coverage | 통과 | ADR-001~017 모두 구현 작업과 production 검증 작업에 연결 |
| spike coverage | 통과 | S01~S24 모두 production 회귀 소유 작업에 연결 |
| 협업 상태 모델 | 통과 | stable ID, 단일 owner, 네 상태, blocker와 PR evidence 규칙 명시 |
| 범위 통제 | 통과 | snapshot/cache/어휘/정규화 등 측정 전 결정은 Deferred로 격리 |
| 현재 상태 정확성 | 통과 | 제품 구현 0/67, RDY-005는 PR 병합 전이라 IN_PROGRESS 유지 |

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

## 의도적으로 남은 상태

- RDY-005의 roadmap PR 리뷰와 `main` 병합은 아직 실행하지 않았다. 따라서 Phase 00과
  전체 현황은 `IN_PROGRESS`, 4/5와 4/72가 맞다.
- FND-001의 production 언어/runtime/SQLite driver/MCP SDK 선택은 구현 결정이다. 이
  로드맵 리뷰가 특정 stack을 선결정하지 않는다.
- 모든 제품 task owner는 실제 planning 전까지 `unassigned`다. 임의 담당자를 문서에
  넣지 않았다.
- 외부 peer review가 새 문제를 찾으면 RDY-005를 완료하기 전에 수정한다.

## 이번 자체 검증 결과

| 검증 | 결과 |
|---|---|
| `python3 docs/roadmap/validate.py` | PASS — phase 9, task 72, product 67, 의존성 cycle 0 |
| 추적성 검사 | PASS — ADR 17/17, spike scenario 24/24 |
| Markdown link·공백·conflict marker 검사 | PASS — 파싱한 link 39개, 오류 0 |
| behavior spike 전체 회귀 | PASS — 25 tests |
| 변경 범위 | PASS — root README와 `docs/roadmap/`만 변경, 제품 구현 없음 |

## 게시 전 재현 검사

다음 검사를 roadmap PR에서 다시 실행한다.

```bash
git diff --check origin/main...HEAD
python3 docs/roadmap/validate.py
```

FND-006에서 두 번째 검사를 필수 CI job으로 연결한다.
