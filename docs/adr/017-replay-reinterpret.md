# ADR-017: 재생·재해석 절차와 회귀 비교 방법

- 상태: Accepted
- 결정일: 2026-08-20
- 소유 영역: 초기 설계 1.3, 8.3~8.4, 9장 모델별 파싱 편차 항목
- 선행 ADR: ADR-001, ADR-007, ADR-013
- Supersedes: 없음

## Context

Replay는 저장된 statement의 parsed draft를 현재 서버 규칙으로 다시 투영한다. 자연어를
다시 쪼개지 않으므로 정규화·entity 해석·카디널리티 같은 서버 규칙은 고칠 수 있지만
과거 agent의 잘못된 파싱은 고칠 수 없다. 그 경우 원문을 agent가 다시 읽는
reinterpret가 필요하다.

두 절차를 섞으면 규칙 배포가 LLM 출력에 따라 비결정적이 되고, 재해석 시각이나 새
agent의 추측이 과거 provenance와 TTL을 바꿀 수 있다. 초기 설계는 경계를 제시했지만
대상 공급 방법, 원본 복원, 회귀 gate와 운영 원자성을 확정하지 않았다.

## Decision

### replay의 입력과 출력

Replay reducer 입력은 다음 둘뿐이다.

- 불변 journal의 전체 사건을 seq 오름차순으로 읽은 값
- 명시적인 `rules_version`

LLM, network 조회, 현재 git branch와 wall-clock 호출을 reducer 안에서 사용하지 않는다.
같은 입력은 논리적으로 같은 projection과 redirect를 만들어야 한다. expires_at은 사건의
effective created_at과 ttl로만 계산하고, 현재 만료 여부는 projection state에 굽지 않는다.
회귀 report가 recall 결과를 비교할 때만 별도의 `evaluation_now`를 고정한다.

전체 replay는 ADR-001/007과 같이 하나의 `BEGIN IMMEDIATE` transaction에서 수행한다.

1. 서버 write queue를 점유하고 transaction을 시작한다. 이 시점부터 다른 journal
   append는 대기하며 WAL reader는 커밋 전의 일관된 projection을 계속 본다.
2. journal checksum, scope의 최종 seq, rules_version과 기존 회귀 지표를 process memory에
   기록한다.
3. scope의 현재 projection을 FK 순서로 비우고 ADR-007의 pre-scan과 reducer를 같은
   table에 실행한다.
4. foreign key, unique invariant, redirect cycle, scope 누수, orphan support와 semantic
   scenario를 transaction 안에서 검증한다.
5. 새 projection 지표를 이전 값·예상 범위와 비교해 아래 gate를 통과시킨다.
6. `projection_meta.last_seq/rules_version/rebuilt_at`을 갱신하고, journal checksum과
   `last_seq == (SELECT MAX(seq) FROM journal WHERE scope_key=...)`를 다시 확인한 뒤 commit한다.
7. 어느 단계든 실패하면 rollback하므로 기존 projection이 그대로 복구된다.

journal checksum은 scope의 모든 journal 컬럼을 seq 순으로, NULL을 구분하는
type-tagged/length-prefixed byte로 직렬화한 SHA-256이다. JSON body를 parse/reserialize하지
않고 저장된 UTF-8 text byte를 사용한다.

FTS는 journal 원문 인덱스이므로 규칙 replay와 별개다. 손상 또는 tokenizer 변경 때만
ADR-005 절차로 재구축한다. 실시간 일반 append는 ADR-007의 incremental projector를
사용한다.

v1에서는 shadow table/file publish를 구현하지 않는다. replay가 writer를 너무 오래
막는다는 측정 결과가 생기면 snapshot 조건과 함께 후속 ADR에서 검토한다.

### replay 가능한 변경

다음은 rules_version을 올리고 replay로 적용할 수 있다.

- 정규화와 entity 해석
- relation 매핑과 카디널리티
- claim identity, 강화·대체·상충 판정
- TTL 계산 규칙
- projector 버그 수정

물리 schema 변경은 백업과 exclusive maintenance mode에서 transactional migration을
먼저 적용하고 replay한다. “replay가 있으므로 migration이 필요 없다”는 의미로
해석하지 않는다. 공개 ID가 one-to-many로
갈라지는 규칙 변경은 ADR-002에 따라 자동 배포하지 않고 사용자 mapping 결정이
필요하다.

### 회귀 비교와 승인 gate

규칙 변경 전후에 scope별로 다음을 기록한다.

- journal 최종 seq와 checksum
- entity/claim/surface/redirect 수와 active/live 상태별 수
- `relates_to` 비율과 relation_label 상위 빈도
- contested claim 쌍 수
- claim당 support 평균과 p95/p99
- orphan FK, redirect cycle, active describes 중복과 ID 이동 목록
- 고정 recall query의 answer ID, 순위와 path 차이
- 전체 replay 시간과 1/2-hop/FTS p50·p95

다음은 무조건 실패 gate다.

- journal 변경 또는 scope 간 참조 한 건
- 설명되지 않은 stable ID 소실, redirect cycle 또는 one-to-many split
- FK/unique/check invariant 위반 한 건
- 철회·병합 취소·재해석 복원 scenario의 실패 한 건
- 고정된 golden recall의 필수 answer 누락 한 건

entity/claim 수, relates_to, contested와 성능의 변화는 변경 ADR에 예상 범위와 이유를
적어야 한다. 예상 범위를 벗어나면 운영자가 diff를 승인하기 전 publish하지 않는다.
동일 journal/rules_version을 두 번 replay한 projection의 canonical dump checksum도
같아야 한다. canonical dump는 statements, entities, surface_forms, claims,
claim_support와 id_redirects를 각 PK 순서의 type-tagged/length-prefixed 값으로 직렬화한
SHA-256이다. 실행마다 달라지는 projection_meta.rebuilt_at, schema_migrations, TEMP/FTS는
제외한다.

전체 replay 10만 사건 p95 60초 목표를 세 번 연속 넘으면 ADR-001의 snapshot 후속 ADR을
검토한다. snapshot은 journal을 대체하지 않고 특정 seq/rules_version까지 검증된
projection 시작점만 저장한다.

### reinterpret 대상 공급

Public MCP tool은 세 개로 유지한다. 대상 일괄 선별은 인증된 로컬 maintenance command가
읽기 전용 report로 제공한다. report는 다음 filter를 지원한다.

- `parsed=[]`
- actor
- effective created_at 범위 또는 journal recorded_at 범위
- scope
- 명시한 event_id 목록

각 행은 event_id, 마스킹된 raw_text, 저장된 parsed, effective
provenance/created_at/ttl·expires_at과 actor를 포함한다. command는 journal이나 projection을
수정하지 않는다. Agent가 report를
받는 과정은 배포 환경의 관리 채널이며 일반 대화 중 자동 실행하지 않는다.

Agent가 새 `ClaimDraft[]`를 제안하면 maintenance command는 원본/신규 claim, 뒤따르는
retraction·merge·alias의 영향과 ID 변화를 dry-run으로 보여준다. 사용자가 정확한 제안을
승인한 뒤에만 서버 process memory에 다음 값에 묶인 일회성 approval을 만든다.

- 현재 `scope_key`와 supersedes 대상 event ID
- dry-run이 읽은 scope journal의 `through_seq`
- 비밀값 처리 후 raw_text byte와 검증·중복 제거를 마친 parsed 배열
- 원본에서 승계할 provenance와 ttl
- 발급 후 15분인 만료 시각

외부 token은 CSPRNG 256 bit를 base64url padding 없이 인코딩하며 정규식
`^ra_[A-Za-z0-9_-]{43}$`을 만족한다. 서버는 payload를 정확히 32 byte로 decode하고 같은
문자열로 canonical 재인코딩되는지도 확인한다. token은 재시작 시 사라지고 한 번의 성공 commit 뒤
소비된다. 실패·rollback 때는 만료 전 같은 요청을 재시도할 수 있다. token 자체와
승인 record는 journal, application log나 tool error에 쓰지 않는다. token byte는
constant-time으로 비교하고, token이 유출돼도 다른 scope, target 또는 payload에는 쓸 수
없게 묶인 필드를 검증 후의 typed 값으로 정확히 비교한다.

### reinterpret 기록

운영자 또는 사용자가 범위를 명시적으로 승인한 경우에만 agent가 raw_text를 다시
해석하고 다음 호출을 한다.

```typescript
memory_record({
  raw_text: original.raw_text,
  claims: reparsedDrafts,
  supersedes: original.event_id,
  reinterpret_approval: oneTimeApproval
})
```

서버는 supersedes target에 대해 다음을 검증한다.

검증은 `memory_record`의 `BEGIN IMMEDIATE`가 writer queue를 점유한 뒤 journal INSERT 전에
수행해 through_seq 확인과 append 사이에 다른 사건이 끼지 못하게 한다.

- 같은 scope의 statement 사건이고 현재 live다.
- 새 raw_text가 저장된 마스킹 원문과 byte-for-byte 같다.
- 순환 supersedes나 한 원본의 동시에 live인 두 successor를 만들지 않는다.
- 입력이 명시적 claims=[]가 아닌 한 모든 draft가 검증을 통과한다. 부분 성공 successor는
  허용하지 않는다.
- 유효하고 아직 소비되지 않은 approval이 현재 scope, target, 마스킹된 raw_text, 승인된
  parsed와 effective provenance/ttl에 정확히 일치하고, 현재 scope 마지막 seq가 승인된
  `through_seq`와 같다. 중간에 다른 사건이 추가됐으면 stale approval로 거부하고 새
  dry-run 승인을 요구한다.

서버는 caller가 보낸 provenance/ttl이 없으면 원본의 effective 값을 채운다. 값이 있으면
원본과 같아야 하며 다르면 reject한다. journal의 새 사건 `created_at`은 실제 append
시각이지만 statements projection의 effective `created_at`, provenance와 ttl은 supersedes
chain의 최초 원본에서 승계한다. 따라서 재해석 때문에 최근성, 출처 강도나 만료 시각이
새로 시작되지 않는다. recall detail은 둘을 숨기지 않고 effective `created_at`과 journal
append의 `recorded_at`을 함께 반환한다.

의미 적용 순서도 최초 원본의 journal seq인 `order_seq`를 승계한다. 새 leaf의 entity/claim
후보 ID는 감사 사건인 leaf의 실제 seq와 draft 위치로 계산하지만, leaf payload는 replay
때 root의 순서 위치에서 적용한다. 이후의 statement, retraction, merge와 alias는 원래
순서대로 그 결과 위에 적용된다. 따라서 과거 문장 재파싱이 그 뒤의 사용자 결정이나
삭제를 최신 write처럼 덮을 수 없다. `supersedes` 기록은 이 과거 구간을 다시 계산해야
하므로 ADR-007에 따라 scope 전체 replay를 트리거한다.

새 successor가 live면 원본 statement는 superseded이고 support는 집계에서 제외된다.
successor statement 사건을 `{event_id, cascade:false}`로 철회하면 replay pre-scan이 그
successor만 제외하고 원본을 다시 live로 복원한다. 기본 event 철회는 chain 전체를
삭제하므로 복원되지 않는다. successor를 다시 재해석하면 chain에서 live leaf 하나만
허용하고 모든 조상은 superseded다.

재해석은 원문 하나를 여러 claim으로 또는 빈 배열로 바꿀 수 있다. claim ID는 새 사건의
parsed 위치에서 새로 발급되며 identity가 기존 claim과 같으면 기존 ID/support로
강화된다. 이 동작은 규칙 replay와 달리 새로운 해석 사건이므로 audit history를
보존한다.

원본 `order_seq` 뒤에 claim-level retraction이 있으면 동일 identity로 재해석된 support는
그 retraction cutoff에 의해 계속 비활성이다. 새 파싱이 identity를 추가·제거하면 과거
claim ID 철회를 새 identity에 임의 전파하지 않는다. maintenance diff는 이런 downstream
retraction과 각 신규 identity의 적용 결과를 별도 고위험 항목으로 표시해야 하며, 자동
batch에서 제외하고 statement 하나 단위의 명시적 승인을 받아야 한다. 이는 “삭제된 같은
사실의 부활”은 막되, 과거 원문에서 새로 분리된 다른 사실까지 근거 없이 삭제된 것으로
간주하지 않기 위한 경계다.

### 파싱 편차와 재해석 gate

ADR-013의 지원 agent 20개 fixture 결과를 actor별로 보관한다. 평균 pairwise Jaccard
0.80 미만, 고위험 의미 반전 한 건 또는 특정 actor의 `parsed=[]` 비율이 전체 평균보다
10%p 높을 때 해당 actor/기간을 reinterpret 후보 report에 올린다. 이는 자동 실행
조건이 아니라 사용자 검토를 시작할 신호다.

재해석 batch는 적용 전에 원본/신규 claim diff를 보여주고 사용자가 범위를 승인한다.
한 batch는 최대 100 statement이며 승인된 statement마다 별도 token과 memory_record
transaction을 쓴다. 중간 실패 시 이미 기록된 successor를 삭제하지 않고
`{event_id, cascade:false}`로 철회해 원본을 복원한다. 아직 쓰지 않은 token은 폐기한다.

## Alternatives

### replay 때 raw_text를 LLM으로 다시 파싱

규칙 배포가 비결정적이고 비용·모델 가용성에 의존한다. 저장된 parsed만 replay하고
재해석은 별도 승인 절차로 둔다.

### 재해석 시 새 provenance와 시각 사용

오래된 추측이 새 사용자 진술처럼 강해지고 TTL이 연장된다. 최초 원본의 effective
metadata를 승계한다.

### 원본 statement를 직접 수정

감사와 되돌리기가 불가능하다. successor 사건과 supersedes 링크를 추가한다.

### public `memory_reinterpret` tool 추가

일상 agent가 대량 과거 기록을 자의적으로 바꿀 위험이 있다. 후보 선별은 local
maintenance report, 적용은 승인된 `memory_record(supersedes)`로 제한한다.

## Consequences

- 서버 규칙 배포는 LLM과 무관하게 결정적이다.
- 파싱 개선은 비용과 의미 변경을 드러내는 별도 감사 사건으로 남는다.
- 재해석이 역사적 provenance, 최근성 또는 TTL을 부풀리지 않는다.
- 재해석이 실제 append 시각이 아니라 원본 의미 순서에서 적용되므로 이후 결정이
  보존된다.
- 전체 replay 동안 다른 writer는 대기하지만 WAL reader는 이전 snapshot을 읽을 수 있다.
- maintenance command라는 비-MCP 운영 표면을 구현해야 한다.
- 재해석은 사용자 승인을 설명문에 의존하지 않고 payload-bound 일회성 token으로
  강제된다.
- batch 재해석은 원자적 전체 작업이 아니므로 되돌림도 retraction 사건으로 수행한다.

## Validation

- 같은 journal/rules_version을 두 번 replay한 canonical projection checksum이 같아야 한다.
- replay 도중 오류를 주입하면 journal과 기존 projection으로 완전히 rollback돼야 한다.
- 동시 append는 replay commit 뒤 실행되고 projection_meta가 최종 scope seq와 같아야 한다.
- 정규화 merge 규칙 변경에서 이전 ID redirect와 예상 metric diff가 나와야 한다.
- `parsed=[]` 원문을 재해석하면 원본 effective metadata와 만료 시각을 승계해야 한다.
- root seq 1, 동일 claim 철회 seq 2, reinterpret leaf seq 3 fixture에서 leaf support가
  `order_seq=1`로 계산되어 계속 철회돼야 한다.
- root describes seq 1, 새 describes seq 2, root reinterpret seq 3 fixture에서 seq 2의
  값이 현재값으로 남아야 한다.
- downstream claim 철회가 있는 원본의 identity-changing reinterpret는 자동 batch에서
  제외되고 적용 결과 diff를 별도 승인해야 한다.
- 재해석 successor를 cascade=false로 철회한 뒤 replay하면 원본 statement/support가
  복원되고 기본 cascade 철회에서는 chain 전체가 사라져야 한다.
- 같은 원본에 두 live successor, 다른 raw_text 또는 다른 scope supersedes가 거부돼야 한다.
- approval의 scope/target/raw_text/draft가 하나라도 다르거나 15분이 지나면 거부되고,
  성공 뒤 재사용도 거부돼야 한다. rollback 뒤 동일 요청은 만료 전 재시도 가능해야 한다.
- approval 발급 뒤 같은 scope에 다른 사건을 하나 추가하면 through_seq 불일치로
  재해석이 거부돼야 한다.
- golden 기록·강화·claim/event 철회·정정·merge/취소·alias/취소·TTL·FTS 시나리오가
  규칙 변경 전후의 승인된 차이 외에는 같아야 한다.
- 20개 parsing fixture와 actor 편차 report가 재현 가능해야 한다.

## References

- 초기 설계 1.3, 3.3, 8.3~8.4, 9장 파싱 편차·snapshot 항목
- ADR-001, ADR-002, ADR-005, ADR-007, ADR-010, ADR-013
