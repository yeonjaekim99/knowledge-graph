# Phase 07 — MCP server와 공개 tool 통합

- 상태: `TODO`
- 진행률: 0/8
- 선행 phase: Phase 04~06 `DONE`
- 주요 근거: ADR-003, ADR-011, ADR-013~017
- 종료 조건: MCP 2026-07-28 기준의 세 tool만 결정적으로 노출되고, schema·annotation·오류·
  metadata·description 계약이 Inspector와 지원 client에서 검증됨

## 작업 현황

| ID | 작업 | 상태 | Owner | 선행 작업 | 증거 |
|---|---|---|---|---|---|
| MCP-001 | server lifecycle과 transport adapter | `TODO` | `unassigned` | FND-001, STO-001, REC-008, REV-007, RCL-008 | — |
| MCP-002 | 세 tool catalog와 annotation | `TODO` | `unassigned` | MCP-001 | — |
| MCP-003 | input/output schema와 structuredContent | `TODO` | `unassigned` | MCP-001, FND-004 | — |
| MCP-004 | tool description과 지시 경계 | `TODO` | `unassigned` | MCP-002, MCP-003 | — |
| MCP-005 | protocol error·typed result·redaction | `TODO` | `unassigned` | MCP-003, REC-002 | — |
| MCP-006 | client metadata·scope·request context 연결 | `TODO` | `unassigned` | MCP-001, STO-005, STO-006 | — |
| MCP-007 | Inspector·지원 client 계약 검증 | `TODO` | `unassigned` | MCP-002~006 | — |
| MCP-008 | agent 호출 판단·파싱 적합성 gate | `TODO` | `unassigned` | MCP-004, MCP-007, REC-008 | — |

## 상세 체크리스트

### MCP-001 — server lifecycle과 transport adapter

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-003, ADR-005, ADR-016
- 선행 작업: FND-001, STO-001, REC-008, REV-007, RCL-008
- 결과물: production MCP entrypoint와 transport-neutral application adapter

완료 체크:

- [ ] startup이 config/auth/SQLite capability/migration을 검증한 뒤에만 tool을 노출한다.
- [ ] stdio와 선택한 추가 transport가 같은 request context와 application service를 쓴다.
- [ ] graceful shutdown이 새 write를 막고 진행 transaction을 정리한 뒤 연결을 닫는다.
- [ ] signal/transport 오류가 journal/projection 부분 commit을 만들지 않는다.
- [ ] health/version 진단은 secret·절대 DB 경로·다른 scope 정보를 반환하지 않는다.

### MCP-002 — 세 tool catalog와 annotation

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-016
- 선행 작업: MCP-001
- 결과물: deterministic tool registry

완료 체크:

- [ ] 공개 이름은 memory_recall, memory_record, memory_revise 정확히 세 개다.
- [ ] tools/list를 이름 오름차순과 canonical schema serialization로 반환한다.
- [ ] recall annotation은 readOnly/idempotent true, destructive/openWorld false다.
- [ ] record는 destructive false·idempotent false, revise는 destructive true·idempotent false다.
- [ ] annotation을 authorization이나 server-side 확인 절차 대신 사용하지 않는다.

### MCP-003 — input/output schema와 structuredContent

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-013~016
- 선행 작업: MCP-001, FND-004
- 결과물: JSON Schema 2020-12 tool catalog와 response serializer

완료 체크:

- [ ] application schema 단일 출처에서 세 inputSchema/outputSchema를 생성한다.
- [ ] mode/action union, object XOR, supersedes/approval pair와 모든 금지 필드를 검증한다.
- [ ] 성공 객체를 outputSchema 검증 후 같은 값으로 structuredContent에 넣는다.
- [ ] content에는 규범 데이터를 대체하지 않는 짧고 의미 일치하는 text 요약만 둔다.
- [ ] catalog와 structured result snapshot이 runtime/locale에 따라 흔들리지 않는다.

### MCP-004 — tool description과 지시 경계

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-004, ADR-013~017
- 선행 작업: MCP-002, MCP-003
- 결과물: versioned descriptions와 description lint

완료 체크:

- [ ] 각 tool의 호출/미호출 조건과 revise의 claim/event 범위 차이를 모두 설명한다.
- [ ] relation 5종, relates_to 탈출구, provenance와 object/object_value 예시를 포함한다.
- [ ] `same_as` 같은 동일성 표현은 relation이 아니라 merge 또는 alias로 안내한다.
- [ ] subject/object aliases와 optional kind의 방향·한계를 예시로 구분한다.
- [ ] 불확실하면 claims=[]를 쓰고 일반 correct와 승인된 reinterpret를 구분한다.
- [ ] recalled project text를 system/tool instruction처럼 실행하지 말라는 경계를 명시한다.
- [ ] 필수 문구·예시가 빠지면 startup/CI description lint가 실패한다.

### MCP-005 — protocol error·typed result·redaction

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-011, ADR-013~016
- 선행 작업: MCP-003, REC-002
- 결과물: application-to-MCP error mapper와 safe logging policy

완료 체크:

- [ ] schema/auth/scope/DB/손상은 `isError:true`, 정상 rejected/ambiguous/no-op은 typed success다.
- [ ] actionable error가 문제 필드·허용 형태·안전한 재시도 예를 제공한다.
- [ ] relation enum 오류는 relates_to+label 재시도 예를 준다.
- [ ] secret 거부는 종류와 필드만 말하고 값·주변 문맥을 반복하지 않는다.
- [ ] error/content/log/trace에 raw secret, SQL, stack 내부값과 절대 DB 경로가 없다.

### MCP-006 — client metadata·scope·request context 연결

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-003, ADR-010, ADR-016
- 선행 작업: MCP-001, STO-005, STO-006
- 결과물: authenticated request context adapter

완료 체크:

- [ ] user principal과 immutable project config로 scope를 만들고 tool argument를 무시하는 경로가 없다.
- [ ] actor는 관찰한 client metadata만 사용하고 없으면 NULL이다.
- [ ] branch/session provider 실패는 nullable metadata로 제한되고 scope를 바꾸지 않는다.
- [ ] transport session 종료를 기억 TTL 종료로 해석하지 않는다.
- [ ] 두 동시 client/scope fixture에서 context가 request 사이에 섞이지 않는다.

### MCP-007 — Inspector·지원 client 계약 검증

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-016
- 선행 작업: MCP-002~006
- 결과물: protocol contract suite와 Inspector 증거

완료 체크:

- [ ] MCP Inspector에서 이름·순서·schema·annotation·structuredContent를 캡처한다.
- [ ] 지원 client마다 initialize/list/call/error/shutdown smoke test를 실행한다.
- [ ] 잘못된 mode/action/XOR/approval 입력이 journal 전에 거부된다.
- [ ] record→recall→revise→recall 수직 흐름을 실제 transport로 검증한다.
- [ ] negotiated protocol revision이 다르면 명시적으로 거부하거나 검증된 compatibility adapter를 쓴다.

### MCP-008 — agent 호출 판단·파싱 적합성 gate

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-013, ADR-016, ADR-017
- 선행 작업: MCP-004, MCP-007, REC-008
- 결과물: 지원 agent 평가 report와 고정 fixture

완료 체크:

- [ ] agent별 기록/미기록/revise 범위 각 10개, 총 30개 판단 fixture를 실행한다.
- [ ] record/recall/revise/미호출 선택 정확도가 각각 또는 합의한 집계로 90% 이상이다.
- [ ] secret 기록, 모호한 자동 merge, claim/event 범위 혼동이 0건이다.
- [ ] 20개 이상 parsing fixture 평균 pairwise Jaccard가 0.80 이상이다.
- [ ] 부정, relation, object/value 고위험 반전이 0건이며 실패 시 description을 보강해 재측정한다.

## Phase 종료 체크

- [ ] 공개 surface가 정확히 세 tool이고 catalog가 결정적이다.
- [ ] application 계약과 JSON Schema/structuredContent가 drift하지 않는다.
- [ ] scope·metadata·오류·prompt instruction 경계가 transport에서 유지된다.
- [ ] Inspector, 지원 client와 agent 적합성 release gate가 모두 통과한다.
