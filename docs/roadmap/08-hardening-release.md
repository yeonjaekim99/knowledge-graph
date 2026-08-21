# Phase 08 — 성능·보안·운영 강화와 v1 릴리스

- 상태: `TODO`
- 진행률: 0/10
- 선행 phase: Phase 07 `DONE`
- 주요 근거: 전체 ADR의 Validation과 [ADR 전체 리뷰](../adr/review.md)
- 종료 조건: 10만 규모 성능, 동시성, 보안, replay/reinterpret 운영, backup/restore와 전체
  추적성 gate가 재현 가능한 증거로 통과해 v1 release 후보가 승인됨

## 작업 현황

| ID | 작업 | 상태 | Owner | 선행 작업 | 증거 |
|---|---|---|---|---|---|
| REL-001 | 결정적 10만 규모 fixture 생성기 | `TODO` | `unassigned` | PRJ-010, RCL-009 | — |
| REL-002 | replay·startup 성능 gate | `TODO` | `unassigned` | REL-001, PRJ-010 | — |
| REL-003 | recall 세 구간 p95 gate | `TODO` | `unassigned` | REL-001, RCL-009 | — |
| REL-004 | 8-client concurrency·busy 검증 | `TODO` | `unassigned` | REL-001, STO-008, MCP-007 | — |
| REL-005 | 비밀값·권한·사고 복구 보안 검증 | `TODO` | `unassigned` | MCP-005, REL-001 | — |
| REL-006 | 정비·운영 지표 report | `TODO` | `unassigned` | PRJ-008, RCL-008 | — |
| REL-007 | replay dry-run·rules rollout 운영 | `TODO` | `unassigned` | REL-002, REL-006 | — |
| REL-008 | reinterpret report·승인·되돌림 운영 | `TODO` | `unassigned` | REC-007, REV-003, REL-006 | — |
| REL-009 | 배포·backup·restore·upgrade runbook | `TODO` | `unassigned` | REL-004, REL-005, REL-007 | — |
| REL-010 | 최종 추적성·release readiness audit | `TODO` | `unassigned` | REL-001~009, MCP-008 | — |

## 상세 체크리스트

### REL-001 — 결정적 10만 규모 fixture 생성기

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-001, ADR-005, ADR-010, ADR-012, ADR-017
- 선행 작업: PRJ-010, RCL-009
- 결과물: versioned large-data generator와 fixture manifest

완료 체크:

- [ ] 고정 seed/clock으로 10만 event와 10만 active claim 조건을 각각 재현한다.
- [ ] 한국어·영어, literal/entity, raw-only, TTL, conflict, hub와 다중 support를 포함한다.
- [ ] merge/alias/retraction/reinterpret 비율과 기대 row/metric checksum을 manifest에 기록한다.
- [ ] fixture 생성 시간은 benchmark에서 제외하고 DB artifact는 release asset 또는 CI cache로 관리한다.
- [ ] 개인·비밀 데이터 없이 checksum이 같은 fixture를 깨끗한 환경에서 다시 만든다.

### REL-002 — replay·startup 성능 gate

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-001, ADR-007, ADR-017
- 선행 작업: REL-001, PRJ-010
- 결과물: replay benchmark report와 regression threshold

완료 체크:

- [ ] 지정 reference 환경에서 10만 event 전체 replay p95가 60초 이하다.
- [ ] 최소 반복 횟수, warm/cold cache, runtime/SQLite/host와 raw duration을 기록한다.
- [ ] startup catch-up, no-op reopen과 rules-version full replay를 분리 측정한다.
- [ ] replay 동안 WAL reader는 이전 일관 snapshot을 읽고 writer는 commit 뒤 진행한다.
- [ ] 60초를 3회 연속 넘을 때만 DEF-001 후속 ADR을 열고 snapshot을 임의 도입하지 않는다.

### REL-003 — recall 세 구간 p95 gate

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-010, ADR-012
- 선행 작업: REL-001, RCL-009
- 결과물: recall latency/plan report

완료 체크:

- [ ] 10만 claim에서 surface+1-hop p95 ≤50ms를 측정한다.
- [ ] 2-hop+ranking p95 ≤200ms, FTS 진입 p95 ≤300ms를 같은 방법으로 측정한다.
- [ ] representative hit/miss/hub/detail 분포와 p50/p95/raw samples를 함께 보존한다.
- [ ] correctness golden과 more_available 신호가 최적화 전후 동일하다.
- [ ] 2-hop 200ms 또는 support p99 100 trigger가 3회면 DEF-002 ADR을 검토한다.

### REL-004 — 8-client concurrency·busy 검증

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-001, ADR-005, ADR-007
- 선행 작업: REL-001, STO-008, MCP-007
- 결과물: mixed-load concurrency report

완료 체크:

- [ ] 8개 client가 record/recall/revise를 합의한 비율로 동시에 반복한다.
- [ ] process 내부 writer가 직렬화되고 reader snapshot과 read-your-writes가 보존된다.
- [ ] busy timeout·retryable error율, write latency와 장기 transaction을 기록한다.
- [ ] kill/restart, lock holder 지연과 replay 중 append에서 부분 commit·deadlock이 0건이다.
- [ ] 종료 후 full replay canonical dump와 online projection checksum이 같다.

### REL-005 — 비밀값·권한·사고 복구 보안 검증

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-003, ADR-011, ADR-016
- 선행 작업: MCP-005, REL-001
- 결과물: adversarial secret corpus, 권한 audit와 offline incident runbook

완료 체크:

- [ ] pattern·entropy·오탐 corpus로 raw masking, draft rejection과 actionable note를 검증한다.
- [ ] DB/WAL/backup/log/response/error/trace에서 canary secret 평문을 자동 스캔한다.
- [ ] local DB와 backup 최소 권한, 원격 인증·scope fail-closed를 배포 환경에서 확인한다.
- [ ] prompt-like memory가 도구 실행/권한 확대 지시로 취급되지 않는 client fixture가 있다.
- [ ] 실제 물리 삭제가 필요한 사고는 server 중지·승인·backup 폐기·DB 재작성 절차로 연습한다.

### REL-006 — 정비·운영 지표 report

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-004, ADR-006, ADR-008, ADR-010, ADR-012, ADR-017
- 선행 작업: PRJ-008, RCL-008
- 결과물: 읽기 전용 maintenance report와 metric dictionary

완료 체크:

- [ ] entry/절단 분포, relates_to/label 빈도, conflict와 claim당 support 분포를 낸다.
- [ ] relation label 승격 지표는 공백·대소문자·호환 문자를 합치되 문장부호 차이는 보존한다.
- [ ] kind 불일치, 다의 surface, 반복 검색 실패와 merge/alias 후보를 계산한다.
- [ ] actor별 parsed=[]·Jaccard 편차와 replay/recall latency를 scope·기간별로 집계한다.
- [ ] report는 자동 수정하지 않고 canonical ID와 근거 event를 안전하게 제공한다.
- [ ] DEF-002~007 trigger 정의와 metric query가 서로 추적되고 개인정보를 최소화한다.

### REL-007 — replay dry-run·rules rollout 운영

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-001, ADR-002, ADR-007, ADR-017
- 선행 작업: REL-002, REL-006
- 결과물: local maintenance replay command, diff/gate와 rollout runbook

완료 체크:

- [ ] journal checksum, rules version, row/state/redirect/conflict/support와 golden recall diff를 낸다.
- [ ] scope 누출·ID 소실·one-to-many·FK/unique·복원 scenario 실패를 publish 전에 차단한다.
- [ ] 승인 범위를 벗어난 metric diff는 운영자 승인 전 commit하지 않는다.
- [ ] 동일 입력 두 replay의 canonical checksum과 오류 주입 rollback을 검증한다.
- [ ] schema 변경은 backup+maintenance migration 뒤 replay하며 FTS 재구축을 규칙 replay와 분리한다.

### REL-008 — reinterpret report·승인·되돌림 운영

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-013, ADR-015, ADR-017
- 선행 작업: REC-007, REV-003, REL-006
- 결과물: local candidate/dry-run command와 payload-bound approval store

완료 체크:

- [ ] parsed=[]/actor/effective·recorded 기간/scope/event ID filter의 읽기 전용 report를 제공한다.
- [ ] 원본/신규 claim, downstream retraction·merge·alias와 ID 차이를 statement별로 보여준다.
- [ ] 256-bit canonical token을 scope/target/through_seq/sanitized payload/metadata에 15분 묶는다.
- [ ] token은 memory only·constant-time 비교·성공 후 1회 소비이며 로그/journal에 남지 않는다.
- [ ] stale/mismatch/다중 live successor/부분 성공을 거부하고 effective metadata/order를 승계한다.
- [ ] downstream 철회가 있는 identity-changing 제안은 자동 batch에서 제외해 별도 승인한다.
- [ ] 최대 100개 batch가 statement별 별도 token/transaction을 쓰고 cascade=false 보상 철회를
      실제 실패 주입으로 검증한다.

### REL-009 — 배포·backup·restore·upgrade runbook

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-001, ADR-003, ADR-005, ADR-011, ADR-017
- 선행 작업: REL-004, REL-005, REL-007
- 결과물: packaging과 운영 runbook suite

완료 체크:

- [ ] 지원 OS/runtime의 설치, config, project당 process와 local filesystem 제한을 문서화한다.
- [ ] SQLite online backup 방식으로 journal+projection+WAL 일관 backup을 만들고 암호화/보존 책임을 정한다.
- [ ] 빈 host restore 뒤 migration/checksum/replay/FTS 검증과 golden recall이 통과한다.
- [ ] 이전 지원 version에서 upgrade와 실패 rollback을 release candidate로 연습한다.
- [ ] startup 실패, busy, corruption, secret incident와 rules rollback의 담당·명령·예상 결과가 있다.

### REL-010 — 최종 추적성·release readiness audit

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-001~017
- 선행 작업: REL-001~009, MCP-008
- 결과물: v1 release checklist, ADR evidence matrix와 승인 기록

완료 체크:

- [ ] ADR-001~017의 모든 Validation 항목이 test/CI/report/수동 증거 하나 이상과 연결된다.
- [ ] S01~S24, crash/adversarial, contract, agent, 성능과 restore gate가 release commit에서 통과한다.
- [ ] open `BLOCKED`, 설명 없는 golden diff, 고위험 agent error와 secret leak가 0건이다.
- [ ] Deferred 항목은 trigger 충족 여부와 미도입 근거가 기록돼 있다.
- [ ] roadmap의 67개 제품 작업이 DONE이고 owner·PR·검증 증거가 main에 있다.
- [ ] version/tag, changelog, 운영자 승인과 rollback 기준이 기록됐다.

## Phase 종료 체크

- [ ] 기능·성능·동시성·보안·운영 gate가 같은 release commit에서 통과한다.
- [ ] backup/restore, replay rules rollout과 reinterpret undo가 실제 rehearsal로 검증됐다.
- [ ] Accepted ADR 전체가 구현·test·증거로 양방향 추적된다.
- [ ] v1을 배포하거나 rollback할 책임자와 절차가 명확하다.
