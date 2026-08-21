# Deferred 결정 목록

아래 항목은 누락된 구현 작업이 아니다. Accepted ADR이 측정 전 도입을 금지하거나 실제
사용 신호가 생길 때만 재검토하도록 정한 범위다. trigger가 충족되면 자동 구현하지 않고
후속 ADR을 먼저 작성한다.

| ID | 항목 | 현재 결정 | 재검토 trigger | 근거 |
|---|---|---|---|---|
| DEF-001 | replay snapshot | v1 미구현 | 10만 사건 전체 replay p95 60초 초과가 3회 연속 | ADR-001, ADR-017 |
| DEF-002 | claim aggregate cache | v1 미구현 | 2-hop p95 200ms 초과 또는 유효 support p99 100 초과가 3회 연속 | ADR-010 |
| DEF-003 | 관계 어휘 승격 | 5종 유지 | 최근 유효 draft 200개 이상에서 `relates_to` 20% 초과 또는 같은 label 40 statement 이상 | ADR-004 |
| DEF-004 | 한국어 조사 정규화 | 조사 제거 안 함 | 최근 1,000 statement 평균 support ≤1.1이고 분리 후보의 조사 차이 비율 ≥20% | ADR-006 |
| DEF-005 | 정확한 session TTL | 12시간 근사 | session TTL 100개 이상이고 근사로 인한 사용자 정정 비율 ≥5% | ADR-010 |
| DEF-006 | 다중 project process | project당 process 하나 | 3개 이상 상시 서버가 운영 문제이거나 단일 endpoint 전환 요구 발생 | ADR-003 |
| DEF-007 | fanout/depth 변경 | K=30, 기본 depth=2 | 실제 recall 200회 이상에서 절단 >10%, 정답 누락 >5% 또는 충분한 성능 여유와 품질 향상 | ADR-012 |

## 승격 절차

- [ ] trigger를 재현한 측정 자료와 fixture를 보존한다.
- [ ] 현재 rules/schema와 변경안의 dry-run diff를 만든다.
- [ ] stable ID, scope, FK, 철회·병합 복원과 golden recall 영향이 설명된다.
- [ ] 후속 ADR이 Accepted된다.
- [ ] 새 작업 ID를 적절한 phase 또는 별도 roadmap revision에 추가한다.

trigger가 충족되지 않은 상태에서 “미리 최적화”를 이유로 이 목록의 항목을 phase
체크리스트에 넣지 않는다.
