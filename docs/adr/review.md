# Recall ADR 전체 리뷰

- 리뷰일: 2026-08-20
- 대상: ADR-001~ADR-017
- 결과: 통과
- 규범성: 이 문서는 검토 기록이며 규범은 각 `Accepted` ADR이다.

## 리뷰 범위

다음 네 축으로 ADR 전체를 다시 읽고 교차 검증했다.

1. 초기 설계의 규범 DDL·타입·불변식과 9장 미결 사항의 담당 ADR 반영 여부
2. ADR 사이의 용어, 상태 전이, ID, scope, 시간과 tool 계약 정합성
3. SQLite DDL·FTS5·제약·집계 query의 실행 가능성
4. 기록부터 재생·재해석까지 주요 사용자 시나리오의 삭제/복원 경계

`Accepted`는 아키텍처 결정이 닫혔다는 뜻이다. 아직 제품 코드가 없으므로 실제 p95,
동시 client, MCP inspector와 다중 agent 품질 gate는 구현 완료 조건으로 남는다.

## 발견 후 반영한 사항

| 발견 사항 | 판정과 반영 | 소유 ADR |
|---|---|---|
| external-content FTS가 journal의 없는 raw_text 컬럼을 요구함 | contentless trigram FTS로 교체 | ADR-005 |
| `memory_record.idempotentHint=true`지만 반복 호출이 support를 늘림 | idempotentHint=false로 정정 | ADR-013, ADR-016 |
| MCP 2026-07-28에는 protocol session/initialize가 없음 | request `_meta` client info, nullable session으로 정정 | ADR-003, ADR-016 |
| `correct`가 새 statement의 필수 raw_text를 받지 않음 | correct.raw_text를 필수로 추가 | ADR-015 |
| 최신 relation label support가 TTL 만료돼도 저장 컬럼은 되돌아갈 수 없음 | claims 컬럼 제거, 유효 support 집계로 이동 | ADR-004, ADR-007, ADR-010 |
| describes 현재 claim 철회와 event 철회의 이전 값 복원 의미가 섞임 | 순차 상태 전이와 event pre-scan을 분리 | ADR-007, ADR-009 |
| 철회/만료 claim의 원문을 raw fallback하면 삭제와 TTL을 우회함 | 처음부터 parsed=[]인 live·unexpired statement만 raw 허용 | ADR-005, ADR-012, ADR-014 |
| parsed=[] statement에는 TTL 적용 위치가 없음 | statements.expires_at 추가 | ADR-007, ADR-010 |
| 전체 replay의 단일 transaction과 shadow publish 절차가 충돌함 | v1은 BEGIN IMMEDIATE 하나로 통일 | ADR-001, ADR-007, ADR-017 |
| agent_supplied surface를 alias 확인해도 INSERT OR IGNORE로 승격되지 않음 | confirmed > name > agent_supplied UPSERT | ADR-008, ADR-015 |
| JSON Schema enum/XOR 오류와 draft 부분 성공 설명이 충돌함 | Schema 오류는 전체 실패, 의미 오류만 부분 성공 | ADR-013, ADR-016 |
| 재해석 successor를 일반 event 철회하면 원본이 되살아남 | 기본 cascade=true 삭제, false만 reinterpret undo | ADR-007, ADR-015, ADR-017 |
| merge한 subject들의 서로 다른 describes가 unique index를 위반함 | 최근 구조적 활성값만 남기고 UPDATE 전 loser 비활성화 | ADR-008, ADR-009 |
| merge survivor를 effective first_seen/문자열 ID로 고르면 ID 순서가 흔들림 | claims.origin_seq와 숫자 parsed index 사용 | ADR-002, ADR-007, ADR-009 |
| entities.kind 정비 규칙은 있지만 ClaimDraft 입력 필드가 없음 | 선택 subject_kind/object_kind 추가 | ADR-008, ADR-013 |
| 여러 SQL로 수행하는 recall이 호출 중 TTL 경계를 넘을 수 있음 | 고정 now/snapshot의 TEMP aggregate 사용 | ADR-010, ADR-012 |
| full detail에 support 수 제한이 없어 응답이 폭발할 수 있음 | 전역 100 statement/1 MiB budget과 절단 신호 추가 | ADR-012, ADR-014 |
| actor/branch/session metadata가 비밀 검사를 우회할 수 있음 | actor/branch 마스킹, session HMAC 상관키 저장 | ADR-003, ADR-011 |
| 뒤늦게 append한 재해석이 그 사이의 정정·철회보다 최신 사건으로 적용됨 | root `order_seq`에서 leaf payload를 적용하고 supersedes는 scope 전체 replay | ADR-004, ADR-007, ADR-008, ADR-009, ADR-010, ADR-017 |
| 재해석의 “사용자 승인”이 description에만 있고 서버에서 강제되지 않음 | exact payload와 through_seq에 묶인 15분·일회성 maintenance approval을 필수화 | ADR-011, ADR-013, ADR-016, ADR-017 |
| relation_label “정규화 빈도”와 agent alias 충돌 처리가 정의되지 않음 | 지표 전용 normalize_v1과 subject/object별 additive alias 규칙 명시 | ADR-004, ADR-008 |
| 모든 SQLite 연결에서 journal_mode를 다시 설정하면 초기화 경합이 생길 수 있음 | 최초 writer만 WAL 설정, 나머지는 검증; unixepoch 포함 feature smoke test | ADR-005 |
| surface/overview seed와 raw answer 크기 절단이 응답에 드러나지 않음 | surface 50·overview 10 seed cap, raw/detail 공통 1 MiB 예산과 절단 note | ADR-012, ADR-014 |
| event ID regex가 128 bit 범위를 넘는 비정규 ULID도 허용함 | 첫 Crockford 문자를 0~7로 제한한 canonical ULID pattern 적용 | ADR-002, ADR-013, ADR-015 |
| recall TEMP aggregate의 scope 조건이 SQL 계약에 명시되지 않음 | `c.scope_key=:scope_key`로 materialize하고 이후 모든 경로가 scope 전용 TEMP만 사용 | ADR-003, ADR-010, ADR-012 |
| revise가 target을 해석한 뒤 write lock을 잡으면 merge/retraction 경합에 취약함 | 순수 preflight 뒤 BEGIN IMMEDIATE 안에서 target·redirect·no-op을 다시 판정 | ADR-005, ADR-015 |

초기 설계의 안내 문구에는 “예시(6장)”이라고 되어 있으나 실제 예시는 7장이고,
본문 일부의 7.1/7.4 참조는 최종 구성의 8.1/8.4를 뜻한다. 이를 비규범 편집 오류로
판정했으며 각 ADR은 실제 제목과 내용 기준으로 소유 범위를 정했다.

## 구조 검증

로컬 검사 결과는 다음과 같다.

| 검사 | 결과 |
|---|---|
| ADR 파일 수 | 17 |
| 상태 | 17개 모두 Accepted |
| 필수 절 | 전부 Context / Decision / Alternatives / Consequences 포함 |
| 추가 검증 절 | 전부 Validation / References 포함 |
| Markdown code fence | 전부 짝이 맞음 |
| ADR 번호 참조 | 존재하지 않는 ADR 참조 없음 |
| TODO/TBD/작성 예정 표식 | 없음 |

## SQLite 실행 검증

Python 표준 sqlite3가 연결한 SQLite 3.45.1 in-memory DB에서 Accepted ADR의 통합 DDL과
query를 실행했다. 제품 구현을 만든 것이 아니라 DDL의 실행 가능성과 핵심 제약을
검사하는 일회성 harness다.

| 검사 | 결과 |
|---|---|
| journal/projection/redirect/meta/migration table과 index 생성 | 통과 |
| FTS5 contentless + trigram table/INSERT trigger 생성 | 통과 |
| 한국어 trigram 2글자 무결과 / 3글자 MATCH 경계 | 통과 |
| FTS delete-all → 전체 재삽입 → optimize 결과 동일 | 통과 |
| TEMP recall_claim_agg/links/incident 생성 | 통과 |
| 두 scope 중 현재 scope만 TEMP aggregate materialize | 통과 |
| 만료된 최신 label 제외 후 이전 permanent label 복원 | 통과 |
| live parsed=[] raw 조회 및 expired raw 제외 | 통과 |
| active describes 단일 partial unique index | 통과 |
| object_id/object_value XOR CHECK | 통과 |
| claim_support의 non-statement event FK 차단 | 통과 |
| 재해석 leaf의 root order_seq 철회 cutoff | 통과 |
| 재해석보다 뒤의 describes 결정 우선순위 | 통과 |
| `PRAGMA foreign_key_check` | 빈 결과 |

실행 환경에 FTS5, trigram 또는 JSON 함수가 없을 수 있으므로 ADR-005의 시작 smoke test는
여전히 필수다.

## 타입과 저장 형태 검토

| 경계 | 확정 내용 |
|---|---|
| public record 입력 | `raw_text + claims`, claims 빈 배열 허용, scope/metadata 금지; supersedes에는 일회성 approval 필수 |
| ClaimDraft 목적어 | object/object_value 정확히 하나, object_kind/aliases는 object에서만 |
| statement journal body | public claims 중 승인된 항목을 `parsed`로 저장, provenance/ttl 기본값 명시 |
| correct | raw_text + replacement 하나, retraction/statement 두 사건 원자 적용 |
| event 철회 | statement는 cascade 기본 true, merge/alias는 exact event |
| recall | search/overview 판별 union, overview에는 query/terms/depth 금지 |
| output 시간 | effective created_at과 실제 journal recorded_at을 각각 UTC ISO로 반환 |
| 재해석 순서 | leaf ID는 실제 seq, 의미 적용은 root order_seq; 같은 순서에서는 실제 seq로 tie-break |
| IDs | event는 `ev_` + ULID, entity/claim은 journal seq와 저장 배열 위치 기반 |
| MCP 결과 | 규범 객체는 structuredContent, text content는 호환용 요약 |
| capability/ID 형식 | canonical 128-bit ULID와 32-byte approval token encode/decode fixture 통과 |

## 시나리오 교차 리뷰

| 시나리오 | 기대 결과 | 판정 근거 |
|---|---|---|
| 새 사실 기록 | statement, entity, claim, support가 한 transaction에 생성 | ADR-001, ADR-007, ADR-013 |
| 두 scope 동시 데이터 | recall TEMP/overview/traversal에 현재 scope claim만 존재 | ADR-003, ADR-010, ADR-012 |
| 같은 사실 재기록 | claim ID 유지, statement/support와 last_seen 증가 | ADR-009, ADR-013 |
| 한 claim 철회 | 그 claim의 기존 live support만 0, 같은 statement의 다른 claim 유지 | ADR-007, ADR-015 |
| TTL이 지난 claim 철회 | 현재 안 보여도 retraction 사건을 남겨 규칙 변경 부활 차단 | ADR-015 |
| statement 철회 | 기본 supersedes chain과 모든 support 제거, FTS join에서도 제외 | ADR-005, ADR-015 |
| correct | retraction 다음 statement가 연속 seq이며 둘 중 실패 시 rollback | ADR-015 |
| describes A→B 뒤 B claim 철회 | A는 superseded 유지, 자동 복원 안 함 | ADR-009 |
| describes B statement event 철회 | B의 대체 side effect가 replay에서 없어져 A 복원 | ADR-007, ADR-009 |
| entity merge | keep ID 유지, surface 이동, 동일 claim support 합침 | ADR-002, ADR-008, ADR-009 |
| describes가 다른 두 subject merge | 최근 구조적 활성값 하나만 active | ADR-008, ADR-009 |
| merge event 철회 | 전체 replay로 entity/claim을 원래 표현 기준으로 다시 분리 | ADR-007, ADR-015 |
| agent surface alias 확인 | confirmed로 승격, alias event 철회 시 이전 origin 복원 | ADR-008, ADR-015 |
| claim TTL 만료 | write 없이 traversal/ranking/contested/detail에서 제외 | ADR-010, ADR-012 |
| raw-only TTL 만료 | FTS/overview raw answer에서 제외 | ADR-005, ADR-010, ADR-014 |
| 철회 claim FTS hit | parsed가 있었으므로 raw fallback하지 않음 | ADR-005, ADR-012 |
| surface 실패 | 안전하게 escape한 FTS → 유효 claim seed, parsed=[]만 raw | ADR-005, ADR-012 |
| reinterpret | 원본 effective 시각/provenance/ttl 승계, 새 parsed만 투영 | ADR-017 |
| reinterpret 뒤의 결정 | root order_seq에서 재적용되어 이후 describes·merge·alias가 그대로 우선 | ADR-007, ADR-009, ADR-017 |
| reinterpret 전 claim 철회 | 같은 identity는 계속 철회; identity 변경은 자동 batch 제외 후 diff 승인 | ADR-007, ADR-017 |
| 미승인 reinterpret | 없거나 scope/target/payload가 다른 일회성 approval이면 사건 없이 거부 | ADR-013, ADR-017 |
| reinterpret draft 거부 | successor 전체 rollback, 원본 live 유지 | ADR-013, ADR-017 |
| reinterpret undo | cascade=false면 predecessor 복원, 기본 철회면 chain 전체 삭제 | ADR-015, ADR-017 |
| replay 반복 | 같은 journal/rules_version의 canonical projection checksum 동일 | ADR-001, ADR-017 |

## 초기 설계 9장 미결 사항 추적

| 미결 사항 | 확정 위치 | 결정 |
|---|---|---|
| 관계 5종 | ADR-004 | v1 5종 유지, 20%/40회 지표로 후속 승격 |
| 조사 제거 | ADR-006 | v1 미적용, dry-run과 split gate 뒤 후속 ADR |
| 모델 파싱 편차 | ADR-013, ADR-017 | 20개 fixture, Jaccard 0.80 및 고위험 0건 gate |
| K=30, depth=2 | ADR-012 | v1 확정, 절단 10%/정답 누락 5% 기준 재검토 |
| claim_agg 캐시 | ADR-010 | p95 200ms 또는 support p99 100을 3회 넘으면 검토 |
| replay snapshot | ADR-001, ADR-017 | 10만 사건 p95 60초를 3회 넘으면 검토 |
| 동기/비동기 replay | ADR-001, ADR-007 | v1 동기, read-your-writes 보장 |
| 한 서버의 여러 project | ADR-003 | v1 프로세스당 project 하나 |
| 다중 client | ADR-005 | 여러 reader + process 내부 단일 writer queue |
| session 12시간 | ADR-010, ADR-013 | v1 근사 확정, 실제 오류율 조건으로 재검토 |
| overview 정렬 | ADR-012, ADR-014 | distinct 연결 수 → 최근성 → entity ID |

## 수용한 제한과 구현 단계 gate

- v1은 project별 서버 프로세스와 로컬 SQLite 단일 writer를 전제로 한다.
- agent_supplied surface 하나만 철회하는 사건은 없으며 원 statement 철회/재기록이
  필요하다.
- merge 뒤 쌓인 기록은 merge 취소 시 원문 표현에 따라 다시 갈리므로 적용 전 diff가
  필요하다.
- session TTL은 protocol session이 아니라 12시간 근사다.
- snapshot과 aggregate cache는 측정 전에는 구현하지 않는다.
- p95 성능 목표, 8-client 혼합 부하, MCP inspector schema, 20개 parser fixture와
  30개 호출 판단 fixture는 제품 코드가 생긴 뒤 release gate로 실행한다.

## 참고 자료

- [MCP 2026-07-28 Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP 2026-07-28 Schema](https://modelcontextprotocol.io/specification/2026-07-28/schema)
- [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [SQLite FTS5](https://www.sqlite.org/fts5.html)
- [SQLite WAL](https://www.sqlite.org/wal.html)
- [SQLite PRAGMA](https://www.sqlite.org/pragma.html)
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
