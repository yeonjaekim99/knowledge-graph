# Recall ADR 시스템 동작 spike 결과

- 실행일: 2026-08-21
- 대상: ADR-001~ADR-017
- 유형: 제품 구현 전 실행형 설계 검증
- 결과: 정상·적대적·장애 복구 시나리오 통과, 차단할 ADR 결함 없음
- 제품 코드 여부: 아님

## 결론

Accepted ADR의 핵심 상태 모델은 하나의 append-only journal과 결정적 projection으로 함께
구성할 수 있었다. 기록, 강화, 두 범위의 철회, 교정, 병합/취소, 별칭/취소, TTL,
scope 격리, FTS/그래프 조회, replay와 reinterpret를 같은 journal fixture에서 실행했다.
여기에 고정 seed 상태 전이, scope/event 변환을 이용한 메타모픽 비교와 실제 프로세스
강제 종료 후 재개방까지 추가했고 모든 시나리오가 통과했다.

이 결과는 Recall v1이 구현됐다는 뜻이 아니다. spike는 의도적으로 모든 write마다 전체
replay를 수행하는 느린 oracle이며 MCP transport, public JSON Schema, 증분 projector,
운영 command와 제품 성능 gate를 포함하지 않는다. 제품 구현은 이 코드를 이식하지 않고
Accepted ADR과 scenario fixture를 기준으로 별도로 작성해야 한다.

## 실행 환경과 증거

| 항목 | 값 |
|---|---|
| Python | 3.12.3 |
| SQLite | 3.45.1 |
| journal mode | WAL |
| SQLite capability | JSON, `unixepoch()`, FTS5 trigram 통과 |
| 자동 시나리오 | 25개 통과(행동 24개 + 매트릭스 meta-test 1개) |
| 적대적 상태 전이 | 고정 seed 8개 × 36 operation prefix = 288개, 각 prefix replay·SQL 불변식 확인 |
| 메타모픽 비교 | scope interleaving, correct 분해, merge/alias undo, TTL time-shift |
| 프로세스 장애 | 7개 transaction 지점의 `os._exit` + correct 첫 append 종료, 총 8개 case |
| 동시성 probe | 4 serialized writer + 4 WAL reader |
| projection 무결성 | 각 적대적 prefix/재개방에서 `integrity_check=ok`, FK·scope·redirect·카디널리티 검사 통과 |
| replay 결정성 | 같은 journal/rules version의 canonical checksum 일치 |

재현 명령:

```bash
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
```

시나리오와 ADR의 기계 판독 가능한 관계는
[`scenario-matrix.json`](../../spikes/adr-behavior/scenario-matrix.json)에 있다. 이 파일을
검사하는 meta-test가 실제 test method와 ADR 범위가 어긋나지 않도록 고정한다.

## 분류 기준

- `confirmed`: spike 실행으로 해당 핵심 규칙들이 함께 성립함을 확인했다.
- `ADR defect`: Accepted ADR끼리 양립하지 않거나 규범만으로 상태를 결정할 수 없다.
- `spike defect`: 테스트 oracle이나 harness 자체의 결함이다. ADR 판정과 분리해 수정하고
  전체 회귀를 다시 실행한다.
- `implementation risk`: 실제 transport, 성능, 배포 또는 production 품질 경계에서
  선택하고 검증해야 한다. ADR 표의 `implementation decision`으로 추적한다.

하나의 ADR에 `confirmed`와 `implementation decision`이 함께 있을 수 있다. 전자는 핵심
의미가 실행됐다는 뜻이고 후자는 아직 남은 제품 gate다.

## ADR별 판정

| ADR | 판정 | 확인한 실행 증거 | 남은 implementation decision |
|---|---|---|---|
| ADR-001 | confirmed | S02/S06: transaction rollback·반복 replay. S20: WAL 직렬화. S23: 288 prefix replay. S24: 실제 process crash 원자성 | 증분 projector와 전체 replay의 별도 구현 parity, migration startup 정책, 10만 사건 replay p95 |
| ADR-002 | confirmed | S03: occurrence ID/dedup redirect. S07: merge redirect/undo. S23/S24: redirect 무순환·재개방 후 seq/ID 연속성 | one-to-many 정규화 변경 dry-run, 손상 redirect 32-hop/cycle 운영 진단 |
| ADR-003 | confirmed | S09: 두 scope 격리와 cross-scope ID 차단. S23: scope별 순서를 보존한 global interleaving의 의미 동등성 및 SQL 누출 검사 | 인증 principal, project별 process lifecycle, actor/branch/session metadata adapter |
| ADR-004 | confirmed | 입력 enum/`relates_to` label 검증, S04/S10/S17의 단일 describes·relation label 동작 | relation 승격 metric과 schema migration dry-run |
| ADR-005 | confirmed | S01: contentless trigram FTS/rebuild. S11: live/TTL join. S20: WAL reader. S23/S24: statement-FTS parity와 crash rollback | 실제 5초 busy UX, network filesystem 차단, 장시간 replay와 외부 client 부하 |
| ADR-006 | confirmed | S01/S03: NFKC·lowercase·공백/하이픈/underscore 제거와 조사 비제거, entity/surface 공유 | locale/언어별 byte fixture 확대, 규칙 변경 split dry-run |
| ADR-007 | confirmed | S02/S04/S05/S07/S14/S15: 재생 순서와 복원. S23: 모든 적대적 prefix checksum. S24: projection 부분 재작성 crash rollback | production 증분 reducer와 oracle full replay의 모든 prefix parity |
| ADR-008 | confirmed | S07/S08/S17/S21: merge·surface·claim rewrite. S20: 동시 entity 하나. S23: 무작위 merge/alias와 redirect/scope 독립 검사 | 다의 surface write ambiguity UX, kind 불일치 정비 report |
| ADR-009 | confirmed | S03/S04/S07/S10/S17: 강화·대체·복원. S23: 무작위 단일 cardinality 및 merge/alias undo 동등성 | 대규모 c2/c10 및 normalization-version 회귀 fixture 확대 |
| ADR-010 | confirmed | S09/S10/S11/S12/S19: support·TTL·상충·read-only. S23: TTL time-shift와 여러 now에서 projection 불변 | claim aggregate cache 도입 조건의 실제 측정 |
| ADR-011 | confirmed | S16/S18: approval 비저장, raw 마스킹, draft 부분 거부, alias 의미값 fail-closed | provider signature registry 완성, log/backup 권한, metadata 검사와 offline 누출 복구 훈련 |
| ADR-012 | confirmed | S09~S13/S19/S22: surface/FTS 진입·fallback, 양방향 BFS, literal/raw 수집, path/hops, ranking, fanout 신호 | surface 50 cap, full detail/1 MiB budget, 10만 claim p95와 품질 평가 |
| ADR-013 | confirmed | S03/S11/S14/S16/S18: raw-only, 중복 draft, 저장 index, 부분 성공과 reinterpret 전체 거부 | public JSON Schema 2020-12, client별 20개 parsing fixture |
| ADR-014 | confirmed | S10~S13/S19: search/overview, empty/raw/claim 구분, 결정적 순서와 read-only 상태 | UTC ISO output, full detail budget, outputSchema validation |
| ADR-015 | confirmed | S04~S08/S09/S15/S18: revise 범위·취소. S23: correct 분해 동등성. S24: correct 첫 event 직후 crash에도 batch 전체 rollback | 자연어 target ambiguity, no-op typed result와 lock 전후 preflight 경합 UX |
| ADR-016 | implementation decision | 제품 MCP 계층을 만들지 않는다는 spike 경계 때문에 실행 판정하지 않음 | tools/list, JSON Schema, annotation, description lint, MCP Inspector와 30개 agent 호출 판단 fixture 전체 |
| ADR-017 | confirmed | S02/S14~S16: metadata/order·cascade·approval. S23/S24: 반복 replay와 장애 후 reopen/replay 결정성 | maintenance report/diff/batch 운영, golden query diff, 10만 사건 replay 성능 |

이번 실행에서 `ADR defect`는 **0개**다. 장애 검증을 준비하며 `spike defect` 1개를 찾아
수정했고 전체 회귀를 다시 통과했다. 기존 및 신규 `implementation risk`는 표의
implementation decision 열에 남아 있으며 이번 통과가 그 release gate를 면제하지 않는다.

## 실행 중 발견한 사항

### 1. 구조 시각과 집계 시각의 SQL 컬럼명 충돌

초기 spike가 `SELECT c.*, a.*`를 사용했을 때 `claims.last_seen_at`과
`recall_claim_agg.last_seen_at`이 같은 이름으로 노출됐다. Python SQLite row lookup은 앞의
구조 시각을 반환해, 최신 support가 만료된 뒤에도 응답의 최근성이 되돌아가지 않았다.

- 분류: `implementation risk` (ADR 표에서는 `implementation decision`으로 추적)
- ADR 판정: 결함 아님. ADR-010은 이미 응답과 ranking이 aggregate를 단일 출처로 쓰도록
  규정한다.
- 제품 구현 지침: aggregate 컬럼을 명시적으로 alias하고, 만료된 최신 support 뒤 이전
  support의 `last_seen`·label이 함께 복원되는 fixture를 유지한다.

### 2. Unicode 단어 경계에 의존한 secret signature 누락

`ghp_...은`처럼 token 직후에 한국어 조사가 붙으면 Python 정규식의 `\b`는 ASCII token과
한글 모두를 word character로 보아 경계를 만들지 않았다. entropy detector가 우연히
보류했지만 provider class를 정확히 식별하지 못했다.

- 분류: `implementation risk` (ADR 표에서는 `implementation decision`으로 추적)
- ADR 판정: 결함 아님. ADR-011은 signature class와 entropy 결합을 요구하지만 특정 regex를
  규범화하지 않는다.
- 제품 구현 지침: provider token 경계는 Unicode `\b` 대신 ASCII alphabet에 대한
  lookaround를 사용하고 한국어 조사·문장부호 인접 fixture를 넣는다.

### 3. 이미 존재하는 entity occurrence도 ID 위치를 소비한다

한 statement의 두 draft가 같은 subject를 반복하면 두 번째 subject 후보도 entity
position을 소비하고 redirect된다. 따라서 두 번째 object는 직관적인 `e1.2`가 아니라
`e1.3`이 된다.

- 분류: `confirmed`
- ADR 판정: ADR-002 규칙과 일치하며 test 기대값을 수정했다.
- 제품 구현 지침: 입력 index, 저장 parsed index와 entity occurrence position을 서로
  혼용하지 않는다.

### 4. 최초 schema bootstrap이 재개방을 지원하지 않음

초기 참조 모델은 매 생성 시 plain `CREATE TABLE`을 실행하고 migration row를 다시
삽입했다. 따라서 정상 종료든 강제 종료든 기존 DB를 새 process에서 열면 projection을
검사하기 전에 `table already exists`로 실패했다.

- 분류: `spike defect` — 수정 완료
- ADR 판정: 결함 아님. ADR-001/005는 재시작 가능한 SQLite 운영을 전제하며 이 문제는
  최초 oracle bootstrap이 그 전제를 구현하지 못한 것이었다.
- 수정: schema 객체를 idempotent하게 확인하고, 기존 migration version의 이름과 schema
  checksum이 정확히 일치할 때만 재개방하도록 했다.
- 제품 구현 지침: startup migration은 존재 여부만 보지 말고 version/name/checksum을
  검증하며, 정상 reopen과 crash reopen을 같은 fixture로 유지한다.

## 시나리오별 요약

| 묶음 | 포함 시나리오 | 결과 |
|---|---|---|
| SQLite/정규화/FTS | capability, 한국어 2·3글자 경계, rebuild | 통과 |
| journal/replay | append rollback, projector rollback, 반복 checksum | 통과 |
| record/claim | 강화, request 중복, stable ID, support 누적 | 통과 |
| revise | claim/event 철회, correct 원자성, merge/alias와 취소 | 통과 |
| 시간/격리 | TTL 집계, label fallback, contested 해제, 두 scope 분리 | 통과 |
| recall | raw 보호, 양방향 BFS, literal, path/hops, fanout, overview | 통과 |
| reinterpret | metadata/order 승계, 철회 cutoff, cascade, approval stale/expiry | 통과 |
| 보안 | raw mask, draft 부분 거부, revise 의미값 fail-closed | 통과 |
| 동시성 | 같은 이름을 기록하는 writer 직렬화와 WAL reader 4개 | 통과 |
| 적대적 상태 전이 | 288 prefix replay, 독립 SQL 불변식, 4개 메타모픽 관계 | 통과 |
| 장애 복구 | journal/projection/commit 7개 지점과 correct batch 중간의 실제 process 종료 | 통과 |

## 다음 단계 판단

정상 시나리오뿐 아니라 조합 상태 전이와 process crash까지 핵심 의미 모델을 차단하는
ADR 결함은 발견되지 않았다. 구현 전 P0 spike는 이 범위에서 종료하고 구현 플랫폼과
production test 전략을 결정하는 단계로 넘어갈 수 있다. 다음 작업은 이 spike를 제품
코드로 다듬는 것이 아니라 새 코드에서 이 scenario를 black-box oracle로 재사용하는
것이어야 한다.

제품 구현 PR은 최소한 다음을 만족해야 한다.

1. production incremental projector의 각 journal prefix 결과를 이 full-replay oracle과
   비교한다.
2. public MCP 계약은 ADR-016의 Inspector/schema/agent fixture를 별도로 통과한다.
3. secret registry와 metadata/log 경계는 대표 signature만 든 spike보다 넓게 구현한다.
4. 성능 수치는 spike 실행 시간으로 판단하지 않고 10만 사건/claim fixture로 측정한다.
