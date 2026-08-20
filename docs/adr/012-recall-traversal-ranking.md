# ADR-012: 확장·수집 알고리즘, 경로 복원, 랭킹, 문장 조합

- 상태: Accepted
- 결정일: 2026-08-20
- 소유 영역: 초기 설계 5장, 9장 허브 방어·기본 depth 항목
- 선행 ADR: ADR-005, ADR-010
- Supersedes: 초기 설계 5.1의 철회 claim raw fallback, 5.2의 active 여부만 확인하던 탐색 뷰

## Context

Recall은 표현을 개체에 연결한 뒤 그래프를 확장하고, 방문한 개체에 붙은 사실을 모아
점수화한다. 이때 이동 가능한 간선과 답으로 수집할 사실을 구분하지 않으면 리터럴
사실이 누락된다. 또한 TTL이 끝난 claim을 경로에 사용하거나 허브에서 무제한으로
확장하면 각각 정확성과 지연 목표가 깨진다.

초기 설계는 BFS와 점수 신호를 제안했지만 query에서 term을 만드는 방법, 동률 순서,
overview의 정렬, claim의 경로를 구성하는 방법과 허브 제한을 조정할 조건은 열어뒀다.
동일 DB에서 호출마다 답의 순서가 달라지지 않도록 이들을 확정한다.

## Decision

### 공통 유효성

탐색, 수집, overview와 랭킹은 모두 ADR-010이 호출 시작 시 고정한
현재 scope 전용 `TEMP recall_claim_agg` 행이 있는 claim만 사용한다. 구조적으로 active지만 모든
support가 만료된 claim은 어느 경로에도 참여하지 않는다.

```sql
CREATE TEMP VIEW recall_claim_links AS
SELECT c.subject_id AS from_id, c.object_id AS to_id, c.id AS claim_id
FROM claims c
JOIN recall_claim_agg a ON a.claim_id = c.id
WHERE c.object_id IS NOT NULL
UNION ALL
SELECT c.object_id AS from_id, c.subject_id AS to_id, c.id AS claim_id
FROM claims c
JOIN recall_claim_agg a ON a.claim_id = c.id
WHERE c.object_id IS NOT NULL;

CREATE TEMP VIEW recall_claim_incident AS
SELECT c.subject_id AS entity_id, c.id AS claim_id
FROM claims c
JOIN recall_claim_agg a ON a.claim_id = c.id
UNION ALL
SELECT c.object_id AS entity_id, c.id AS claim_id
FROM claims c
JOIN recall_claim_agg a ON a.claim_id = c.id
WHERE c.object_id IS NOT NULL;
```

`claims.state='active'` 조건은 aggregate 정의에 이미 포함돼 있다. 위 TEMP 뷰가 그 정의를
복제하지 않는 것은 유효성 판정을 한 곳에 두기 위해서다.

### search 진입점

1. `terms`가 있으면 배열 순서대로 처리한다. 각 term을 ADR-006으로 정규화하고 같은
   `(surface_norm, entity_id)` 입력은 한 번만 쓴다.
2. `terms`가 없으면 `query` 전체와 Unicode 문자·숫자의 연속 구간을 후보로 만든다.
   정규화 결과가 두 글자 이상인 후보를 긴 것부터, 원문 등장 순서로 최대 10개 쓴다.
   서버가 형태소 분석이나 의미 추출을 하지는 않는다.
3. 각 후보와 정확히 일치하는 `surface_forms` 행을 전부 가져온다. `merged_into`와
   `id_redirects`를 따라 canonical entity로 바꾼다. 같은 term 안에서는 canonical
   entity_id ASC로 정렬하고 term 순서와 첫 등장을 보존해 중복 제거한다.
   정렬 뒤 canonical seed는 전체 최대 50개이며 51개를 읽어 절단을 판정한다. 넘으면
   앞선 50개만 사용하고 `more_available=true`와 surface seed 절단 note를 남긴다.
4. surface hit를 seed로 확장해 유효 claim 답이 하나라도 생기면 `entry='surface'`로 한다.
5. surface hit가 없거나 hit는 있지만 유효 claim 답이 0개면 ADR-005의 FTS로
   live·unexpired statement를 21개까지 읽고 20개만 후보로 쓴다. 21번째가 있으면
   FTS 절단으로 표시한다. 세 글자 미만인 검색어만 남으면 FTS를 실행하지 않는다.
6. FTS statement가 뒷받침하는 유효 claim의 subject와, entity object가 있으면 object도
   seed로 삼고 그 claim 자체를 허브 K와 무관하게 `reached` 후보에 고정한다. journal body의
   저장된 `parsed`가 빈 배열인 live·unexpired statement만 `kind='raw'` 후보가 된다.
   parsed가 있었지만 claim이 철회·supersede·만료된 statement는 raw로 반환하지 않는다.
   동일한 저장 raw_text를 가진 다른 live·unexpired statement가 유효 claim을 지원하면
   raw 후보도 생략해 즉시 재시도 기록이 원문/claim으로 중복 표시되지 않게 한다.

FTS의 사용자 문자열은 연산자로 해석하지 않고 phrase literal로 escape한다. seed는
FTS rank, statement seq, subject 먼저/object 다음 순으로 안정화한다.
명시적 terms가 있으면 그 최대 10개를 OR phrase로 사용하고 query 전체를 추가하지
않는다. terms가 없으면 2단계에서 만든 후보를 그대로 사용한다.

### overview 진입점

`overview`는 query 없는 이 scope의 개요다. 유효한 **distinct incident claim** 수가
많은 entity를 우선하고, 그 entity에 붙은 유효 support의 최근 시각, entity id 순으로
동률을 푼다.

```text
valid incident claim count DESC
max valid support last_seen_at DESC
entity_id ASC
```

상위 `min(limit, 10)`개 entity를 seed로 잡아 depth 0에서 incident claim을 수집하고,
search와 같은 랭킹으로 최종 후보를 만든다. 남는 응답 칸은 최근 live·unexpired
`parsed=[]` statement를 effective created_at DESC, journal seq DESC로 채운다. 따라서 raw-only
scope도 overview에서 보이지만 철회·만료 claim 원문은 우회 반환되지 않는다. 위의
동일 raw_text graph 우선 중복 제거도 overview에 적용한다. 별도
entity 응답 타입을 도입하지 않으며 `entry='overview'`로 구분한다.
eligible entity를 seed cap보다 하나 더 읽어 후보가 남으면 최종 claim 중복 제거 결과와
무관하게 `more_available=true`와 overview seed 절단 note를 남긴다.

### 확장과 수집

기본 depth는 2, 허용 범위는 1~3이다. BFS는 양방향 `recall_claim_links`만 따라 이동한다.
방문한 모든 entity에서는 `recall_claim_incident`로 개체 목적어와 리터럴 목적어를 모두
수집 후보로 삼는다. 조기 종료하지 않는다.

각 entity에서 이동할 link와 수집할 incident claim은 각각 최대 30개다. 다음 순서로
정렬한 뒤 자른다.

```text
support_count DESC
strongest_rank DESC
last_seen_at DESC
claim.origin_seq ASC
claim ID suffix parsed_index ASC
```

어느 쪽이든 30개를 초과하면 결과 포함 여부와 무관하게 `more_available=true`다.
따라서 “모든 사실 수집”은 허브 제한 전의 의미이며 응답은 절단 사실을 숨기지 않는다.
방문 집합은 canonical entity id 기준이며, 여러 seed 또는 경로가 같은 entity에 도달하면 짧은
경로, seed 입력 순서, 위 간선 순서가 앞선 부모 포인터 하나를 남긴다.

절단 여부를 알기 위해 link/incident는 31개를 읽어 30개만 사용하고, 최종 랭킹도
`limit+1`개를 읽어 limit만 반환한다. 전체 COUNT를 추가로 수행하지 않는다.

수집된 claim은 다음 임시 테이블에 모은다. 같은 claim을 여러 entity에서 수집하면 가장
낮은 depth와 가장 이른 seed를 유지한다.

```sql
CREATE TEMP TABLE reached (
  claim_id   TEXT PRIMARY KEY,
  depth      INTEGER NOT NULL,
  seed       TEXT NOT NULL,
  seed_order INTEGER NOT NULL,
  anchor_id  TEXT NOT NULL
);
```

`depth`는 seed에서 claim에 닿은 가장 가까운 incident entity까지의 거리다. `anchor_id`는
그 entity이며 경로 복원 기준점이다.

### 경로와 hops

부모 포인터를 anchor까지 거슬러 올라가 seed surface와 entity 이름을 연결한다. claim이
개체 간 간선이고 반대쪽 entity가 아직 경로 끝에 없으면 그 entity를 한 번 덧붙인다.
claim 자체가 anchor로 오는 부모 간선이면 이미 양 끝이 경로에 있으므로 덧붙이지 않는다.
리터럴 claim은 anchor까지만 표시한다.

seed surface 표시가 첫 entity name과 byte-for-byte 같으면 한 번만 쓴다. 다른 별칭이면
`별칭 → canonical name`으로 둘 다 보여준다.

surface 진입의 seed 표시는 실제 매칭 term, FTS 진입은 첫 매칭 phrase에 `(FTS)`를 붙인
값, overview는 entity name이다. FTS phrase와 overview seed도 그래프 간선이 아니므로
hops에 세지 않는다. seed 표시는 Unicode 80자를 넘으면 79자와 `…`로 줄이되 탐색에 쓴
원래 값은 바꾸지 않는다.

`hops`는 출력 path 안에서 entity 사이를 건넌 간선 수다. surface가 첫 entity의 별칭인
경우 `로그인 → 인증 시스템` 표시는 설명을 위한 진입 연결이며 hops에 세지 않는다.
따라서 seed entity의 `uses` claim은 `로그인 → 인증 시스템 → 서버 세션`, `hops=1`이다.

### 랭킹

최근 기준은 호출 시각에서 30일 전이다. 초기 점수는 다음과 같다.

```text
-2 * depth
+ provenance: user_stated 6 / observed 4 / inferred 1
+ min(support_count, 4)
+ last_seen_at이 최근 30일 이내면 2
- contested면 3
```

점수가 같으면 `depth ASC`, `strongest_rank DESC`, `support_count DESC`,
`last_seen_at DESC`, `claim.origin_seq ASC`, claim ID suffix의 숫자 parsed_index ASC 순이다.
기본 limit은 10, 허용 범위는 1~50이다.
랭킹 전 후보가 limit보다 많거나 FTS 후보를 20개에서 잘랐으면
`more_available=true`다.

FTS에서 claim과 raw 후보가 함께 나오면 claim 답을 위 랭킹으로 먼저 채우고 남는 칸에
raw 답을 FTS score ASC, statement seq DESC 순으로 넣는다. raw 후보까지 limit에 잘리면
`more_available=true`다. 그래프를 우선하는 이 순서는 의도적이다.

contested는 ADR-010의 유효한 반대 claim 판정을 그대로 사용한다. 가중치는 제품 튜닝
값이지만 변경 시 고정 fixture의 순위 회귀 결과를 기록한다. 명시한 허브 K 외에는 SQL
밖에서 일부 후보를 미리 자르지 않는다.

### 문장과 detail

```text
text = subject.name + " " + predicate + " " + (object.name | object_value)
predicate = recall_claim_agg.relation_label ?? relation의 기본 표현
```

기본 표현은 `uses=사용`, `rejects=거부`, `contains=포함`, `describes==`,
`relates_to=관련`이다. relation_label은 ADR-010이 현재 유효 support에서 계산한 최근
표현을 그대로 사용하고 한국어 조사를 추측해 보정하지 않는다.
리터럴의 brief 표시는 ADR-009의 identity-normalized canonical `claims.object_value`이며,
입력 source 철자·공백은 full detail의 statement raw_text에서 확인한다.

`detail='full'`의 statements에는 현재 유효한 support만 넣는다. 모든 RawAnswer의 `text`와
claim detail의 `raw_text`가 공유하는 UTF-8 원문 payload 예산은 응답당 1 MiB다. 먼저
최종 answer 순서의 RawAnswer 필수 text를 할당하고, 맞지 않는 raw 후보는 반환하지 않은
채 `more_available=true`로 표시한다. 남은 byte 예산을 ranked claim answer 순서의 detail에
쓰며 detail statement는 추가로 최대 100개다. 각 claim에서는 journal seq가 최근인
support부터 선택한 뒤 표시할 때 effective created_at 오름차순, journal seq 오름차순으로
정렬한다. 잘리면 해당 `detail.more_available`과 결과의 `more_available`을 true로 하고
note에 raw/detail payload 절단을 적는다. 비밀값 마스킹을 거친 journal raw_text만
반환한다.

### K와 depth의 재검토 조건

K=30과 기본 depth=2를 v1 값으로 확정한다. 최소 200회의 실제 recall 또는 고정된
10만-claim 평가 자료를 확보한 뒤 다음 중 하나면 후속 ADR에서 조정한다.

- fanout 절단으로 `more_available`이 10%를 넘는다.
- 사람이 판정한 정답이 절단 또는 depth 때문에 top 10에서 빠지는 비율이 5%를 넘는다.
- 반대로 p95 지연이 목표의 50% 이하면서 더 큰 K/depth가 recall 품질을 유의미하게
  높인다.

성능 목표는 표면형+1-hop p95 50ms, 2-hop+랭킹 p95 200ms, FTS 경로 p95 300ms다.

## Alternatives

### 1-hop에서 결과가 충분하면 종료

가까운 약한 사실이 먼 강한 사실의 후보 진입을 막는다. 비용은 fanout으로 제한하고
요청 depth까지 펼친다.

### 리터럴도 entity로 저장

이동과 수집을 하나로 만들 수 있지만 명령, 숫자와 상태값이 노드로 팽창한다. 리터럴은
claim 값으로 두고 incident collection으로 반환한다.

### `subject_id=? OR object_id=?`

간단하지만 양쪽 인덱스 사용과 방향별 순서 제어가 어렵다. UNION ALL view를 사용한다.

### overview 전용 응답 타입

개체 요약을 새로 정의해야 하고 recall 계약이 복잡해진다. 상위 entity를 seed로 삼아
기존 claim 답을 재사용한다.

## Consequences

- 이동 가능한 사실과 답으로 보일 사실의 차이가 명시된다.
- 만료된 claim은 결과뿐 아니라 중간 경로로도 사용되지 않는다.
- 같은 snapshot, 호출 인자와 캡처한 now는 같은 seed, 부모 경로와 결과 순서를 만든다.
- 허브 절단 때문에 일부 관련 사실을 놓칠 수 있으며 `more_available`이 이를 드러낸다.
- 다의 surface, overview와 원문 payload도 상한을 가지며 모든 절단을 note로 드러낸다.
- query term 파생은 의도적으로 단순해 surface form 품질과 FTS가 중요하다.
- overview도 기존 Answer 계약과 랭킹을 공유한다.

## Validation

- seed entity의 리터럴 claim이 depth 0 후보와 답에 포함돼야 한다.
- 목적어 쪽에서 시작해도 incoming claim을 찾고 반대 entity까지 path를 만들어야 한다.
- 모든 support가 만료된 claim은 이동·수집·overview 어느 곳에도 나타나지 않아야 한다.
- claim 철회/만료 뒤 같은 statement 원문이 raw answer로 나타나지 않아야 한다.
- live·unexpired parsed=[] statement는 FTS와 overview에서 raw answer가 되고 expiry 뒤
  사라져야 한다.
- 같은 raw_text의 유효 claim statement가 있으면 parsed=[] 복제본은 raw로 중복
  반환되지 않아야 한다.
- 여러 seed가 같은 entity에 도달하면 규정된 동률 순서로 같은 path가 반복 생성돼야 한다.
- surface가 canonical entity 51개에 매칭되면 50개만 seed가 되고 surface 절단 note가
  있어야 한다. overview도 seed cap보다 entity가 많으면 같은 신호를 내야 한다.
- 31개 이상 간선인 허브에서 30개만 확장되고 `more_available=true`여야 한다.
- 31개 이상 incident claim인 entity에서도 30개만 후보화되고 more_available이어야 한다.
- limit 절단과 FTS 20건 절단도 `more_available=true`여야 한다.
- raw answer와 full detail의 합산 UTF-8 원문이 1 MiB를 넘지 않고 잘린 raw/detail이
  more_available과 note에 드러나야 한다.
- recall 전후 journal과 영구 projection row 수가 같아야 한다.
- 10만 claim fixture에서 세 구간의 p95 목표를 측정해야 한다.

## References

- 초기 설계 5장, 9장 허브 방어 항목
- ADR-005, ADR-006, ADR-008, ADR-010, ADR-014
