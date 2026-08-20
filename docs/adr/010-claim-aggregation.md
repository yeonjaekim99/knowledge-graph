# ADR-010: 신뢰도·만료·상충 산출 방식과 캐시 전환 조건

- 상태: Accepted
- 결정일: 2026-08-20
- 소유 영역: 초기 설계 3.4, 4.3~4.4, 9장 집계 캐시 항목
- 선행 ADR: ADR-008, ADR-009
- Supersedes: 초기 설계 3.1의 claims.relation_label 저장, 4.3의 만료 support를 포함하던 claim_agg 뷰

## Context

신뢰도, 만료와 상충은 support와 상대 claim이 바뀔 때 함께 달라지는 파생값이다.
claims에 캐시하면 갱신 경로를 빠뜨려 조용히 틀린 값이 남을 수 있다. 초기 `claim_agg`
뷰는 `expires_at`으로 claim의 최종 만료만 계산했지만 이미 만료된 support도 count,
strongest와 last_seen에 포함했다. 또한 traversal과 contested 판정이 TTL을 보지 않으면
만료된 사실을 경로로 사용하거나 상충으로 표시할 수 있다.

## Decision

### TTL

시간 단위는 UTC Unix epoch 초다. statement가 ttl을 생략하면 provenance로 결정한다.

| provenance | 기본 ttl |
|---|---|
| `user_stated` | `permanent` |
| `observed` | `permanent` |
| `inferred` | `weeks` |

| ttl | statements.expires_at / support.expires_at |
|---|---|
| `session` | effective statement created_at + 43,200초 |
| `weeks` | effective statement created_at + 2,592,000초 |
| `permanent` | NULL |

명시한 ttl은 provenance 기본값보다 우선한다. 최신 MCP가 protocol session을 보장하지
않으므로 `session`은 v1에서 12시간 근사로 확정하고 session 종료 write를 만들지 않는다.

statement의 effective expiry를 `statements.expires_at`에 두고, parsed draft의 support는
같은 값을 `claim_support.expires_at`에 복사한다. 전자는 raw statement 조회, 후자는
claim별 집계의 단일 입력이다. 둘이 다른 값이면 projection 무결성 오류다.

### 유효 support 집계

`claim_agg`는 **현재 시각에 유효한 support만** 집계한다. statement projection의
effective provenance/created_at을 사용해 재해석에서도 역사적 강도가 바뀌지 않는다.

```sql
CREATE VIEW claim_agg AS
SELECT
  cs.claim_id,
  COUNT(*) AS support_count,
  MAX(CASE s.provenance
        WHEN 'user_stated' THEN 3
        WHEN 'observed'    THEN 2
        ELSE 1 END) AS strongest_rank,
  MAX(s.created_at) AS last_seen_at,
  (
    SELECT NULLIF(TRIM(json_extract(
             jl.body,
             '$.parsed[' || csl.draft_index || '].relation_label'
           )), '')
    FROM claim_support csl
    JOIN statements sl ON sl.event_id = csl.event_id
    JOIN journal jl    ON jl.id = csl.event_id
    WHERE csl.claim_id = cs.claim_id
      AND csl.live = 1
      AND sl.state = 'live'
      AND (csl.expires_at IS NULL OR csl.expires_at > unixepoch('now'))
      AND NULLIF(TRIM(json_extract(
            jl.body,
            '$.parsed[' || csl.draft_index || '].relation_label'
          )), '') IS NOT NULL
    ORDER BY sl.order_seq DESC, jl.seq DESC
    LIMIT 1
  ) AS relation_label,
  CASE WHEN COUNT(*) > COUNT(cs.expires_at)
       THEN NULL
       ELSE MAX(cs.expires_at)
  END AS effective_expires_at
FROM claim_support cs
JOIN statements s ON s.event_id = cs.event_id
JOIN claims c     ON c.id = cs.claim_id
WHERE cs.live = 1
  AND s.state = 'live'
  AND c.state = 'active'
  AND (cs.expires_at IS NULL OR cs.expires_at > unixepoch('now'))
GROUP BY cs.claim_id;
```

규범 의미는 다음과 같다.

- claim이 현재 유효하려면 `claims.state='active'`이고 `claim_agg` 행이 존재해야 한다.
- support_count, strongest와 last_seen은 만료되지 않은 support만 반영한다.
- relation_label은 그 support 집합에서 order_seq, 실제 journal seq 순으로 가장 최근인
  non-empty label이며 최신 label support가 만료·철회되면 이전 유효 label로 돌아간다.
- 하나라도 permanent support가 있으면 effective_expires_at은 NULL이다.
- 모두 유한하면 남은 유효 support 중 가장 늦은 expires_at이다.
- 모든 support가 만료돼도 claims.state를 쓰기로 바꾸지 않는다. 뷰에서 자연스럽게
  사라지며 recall은 read-only로 유지된다.

위 view는 관리 쿼리와 정답 정의를 위한 현재 시각 표현이다. `memory_recall`은 여러 SQL
statement로 BFS를 실행하므로 호출 시작 시 UTC epoch 초 `now`를 한 번 캡처하고 read
transaction을 연다. 위 SELECT에서 모든 `unixepoch('now')`를 같은 `:now`로 치환한
parameterized query에 **`AND c.scope_key = :scope_key`를 추가**해
`TEMP recall_claim_agg`에 한 번 materialize한다. 호출의 모든 진입·탐색·수집·랭킹·detail이
그 scope 전용 TEMP table만 사용한다. 영구 view는 운영자가 여러 scope를 진단할 수 있어
전역이지만 반드시 claims와 join해 명시한 scope로 제한한다. view와 TEMP query는 한 source
template로 생성해 유효성 조건이 갈라지지 않게 한다.

따라서 호출 도중 wall clock이 expiry를 지나도 해당 호출 안에서는 결과가 일관되고,
다음 호출부터 만료가 반영된다. 테스트도 명시한 `:now`로 같은 query를 사용한다.

### traversal과 collection

`claim_links`, `claim_incident`, overview와 ranking은 단순히 active claims를 읽지 않고
recall 안에서는 반드시 `TEMP recall_claim_agg`와 join한다. recall 밖의 진단 쿼리는
`claim_agg`를 쓴다. 만료 claim은 이동, 수집, fanout 계산과 결과 후보 어느 곳에도
참여하지 않는다. 응답의 relation_label도 `claims`가 아니라 이 aggregate에서 읽는다.

### 상충

현재 claim과 반대 claim 모두 같은 호출의 aggregate에 존재할 때만 contested다. recall
query에서는 고정된 `recall_claim_agg`를 쓰고 관리 query에서는 `claim_agg`로 치환한다.

```sql
EXISTS (
  SELECT 1
  FROM claims x
  JOIN recall_claim_agg xa ON xa.claim_id = x.id
  WHERE x.scope_key = c.scope_key
    AND x.subject_id = c.subject_id
    AND x.object_id IS c.object_id
    AND x.object_value IS c.object_value
    AND x.relation = CASE c.relation
      WHEN 'uses' THEN 'rejects'
      WHEN 'rejects' THEN 'uses'
    END
) AS contested
```

uses/rejects 외 관계는 false다. 한쪽 support가 철회·supersede·만료되면 별도 write 없이
상충이 풀린다.

### 집계 캐시 전환 조건

v1은 뷰를 정답 정의로 사용하고 캐시하지 않는다. 다음 중 하나가 세 번 연속 재현되면
후속 ADR로 캐시를 검토한다.

- 10만 사건 표준 fixture의 2-hop recall p95가 200ms를 초과한다.
- 실제 데이터에서 claim당 유효 support 수 p99가 100을 초과한다.

캐시를 도입해도 이 뷰와 동일한 parameterized reference query를 테스트 oracle로 남긴다.
projector가 캐시를 갱신하고 샘플 비교에서 불일치가 한 건이라도 나오면 캐시 사용을
중지한다.

### session TTL 재검토

서버가 신뢰할 수 있는 logical session 종료 시각을 요청 간에 제공하는 배포가 생기고,
session TTL statement가 100개 이상 쌓인 뒤 12시간 근사 때문에 발생한 사용자 정정이
5% 이상이면 ADR-010 후속 ADR에서 정확한 session 만료 사건 또는 별도 수명 모델을
검토한다.

## Alternatives

### claims에 confidence와 expires_at 저장

조회는 빠르지만 support 강화/철회/만료마다 여러 캐시를 고쳐야 한다. 초기 규모에서는
정확한 뷰를 선택한다.

### 만료된 support도 strongest/count에 포함

claim 자체가 아직 유효하더라도 오래된 강한 근거가 현재 점수를 부풀린다. 모든 집계
신호를 같은 유효 support 집합에서 계산한다.

### 만료 시 background write

claims.state를 즉시 바꿀 수 있지만 읽기가 시간에 따라 write를 요구하고 journal 밖
변경 경로가 생긴다. 동적 뷰로 판정한다.

### protocol session 종료를 TTL로 사용

최신 MCP에는 protocol-level session이 없고 transport마다 수명 의미가 다르다. 12시간
근사를 명시한다.

## Consequences

- support 응답, relation label, ranking, traversal와 contested가 같은 유효성 정의를 공유한다.
- 시간 경과만으로 결과가 사라져도 DB write가 발생하지 않는다.
- aggregate materialization 비용이 모든 recall 경로에 포함된다.
- claims.state는 구조 상태이며 시간 유효성 상태가 아니라는 구분이 중요하다.
- 캐시 최적화에는 명시적 성능 증거와 reference query 대조가 필요하다.

## Validation

- expired 강한 support와 unexpired 약한 support가 있을 때 count/strongest가 약한 support만
  반영해야 한다.
- 최신 label support가 만료되면 이전 유효 non-empty label이 반환돼야 한다.
- permanent support 하나가 있으면 effective_expires_at이 NULL이어야 한다.
- 모든 support 만료 뒤 claim이 traversal, overview, ranking과 contested에서 사라져야 한다.
- 반대 claim 한쪽만 만료·철회했을 때 contested가 false가 돼야 한다.
- recall 전후 journal/projection row count와 `PRAGMA data_version`이 바뀌지 않아야 한다.
- expiry 경계를 호출 중간에 넘기는 clock fixture에서 한 호출 안 결과는 고정되고 다음
  호출에서만 사라져야 한다.
- 두 scope에 각각 유효 claim이 있어도 `recall_claim_agg`에는 현재 scope의 claim만
  materialize되고 overview/traversal에서 반대 scope ID가 한 건도 나오지 않아야 한다.
- reference query와 향후 캐시 결과를 동일 fixture로 비교할 수 있어야 한다.

## References

- 초기 설계 3.4, 4.3, 4.4
- ADR-003, ADR-009, ADR-012, ADR-013
