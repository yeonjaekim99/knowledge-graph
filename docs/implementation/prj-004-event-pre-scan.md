# PRJ-004: 사건 pre-scan과 effective statement stream

- 상태: 구현 완료
- 결정일: 2026-08-22
- 작업: PRJ-004
- Owner: `log0629`
- 규범 근거: ADR-007, ADR-010, ADR-017
- 선행 구현: PRJ-001, PRJ-003
- 구현 branch: `prj-004-effective-event-stream`
- PR: [#24](https://github.com/yeonjaekim99/knowledge-graph/pull/24)

## 목적과 범위

전체 replay는 projection row를 만들기 전에 journal 사건의 최종 효력과 의미 적용 순서를
먼저 알아야 한다. 뒤의 event retraction이 앞선 merge나 alias를 무효화할 수 있고, 늦게
append된 재해석 successor는 자기 occurrence ID를 유지하면서 root statement의 역사적
위치에서 적용돼야 하기 때문이다.

PRJ-004는 한 trusted scope의 정렬 journal과 `rulesVersion`만 받는 IO 없는 domain pass인
`preScanProjectionEvents`를 구현한다. 결과는 후속 reducer가 사용할 frozen effective event
stream, 모든 statement의 상태와 모든 실제 occurrence candidate registry다. SQLite row 생성,
entity/surface 해석, claim/support 상태 전이와 원자 publish는 각각 PRJ-005~009의 책임이다.

## 입력 신뢰 경계

입력은 PRJ-001의 `createProjectionReplayInput`을 먼저 통과한다. 따라서 다음 조건이 pre-scan
전에 고정된다.

- 모든 사건은 하나의 canonical `scopeKey`에 속하고 `seq`가 엄격히 증가한다.
- event ID, kind, body JSON text, audit metadata와 epoch 시각은 안전한 immutable snapshot이다.
- ambient clock, DB, process, network나 LLM은 입력에 없고 domain pass에서도 읽지 않는다.

교차 scope 사건은 이 경계에서 `SCOPE_MISMATCH`로 거부된다. 현재 scope journal에 없는
event ID를 supersedes/retraction으로 가리키면 pre-scan의 not-found 오류가 된다. 두 오류 모두
submitted scope, ID나 payload를 message와 error property에 넣지 않는다.

저장된 statement body는 기본값이 이미 확정된 `raw_text`, `parsed`, `provenance`, `ttl`과
선택적인 `supersedes`를 가져야 한다. statement 대상 retraction body에는 ADR-015의 public
기본값을 적용한 `cascade: true|false`가 항상 저장돼야 한다. merge/alias 대상과 claim 대상에는
`cascade`를 허용하지 않는다. 이 구분으로 미래 public default가 바뀌어도 replay 의미는
변하지 않는다.

## 정적 graph 검증

pre-scan은 먼저 모든 body와 occurrence 후보를 읽고 다음 오류를 projection write 전에
거부한다.

- 중복 event anchor와 malformed stored body
- 없는 사건, 미래 사건 또는 retraction 사건을 향한 event-level retraction
- 없는 사건, 미래 사건 또는 non-statement를 향한 supersedes
- supersedes cycle, 이미 retracted인 target과 동시에 살아 있는 두 successor
- successor의 `raw_text`, effective provenance 또는 TTL이 root와 다른 경우

cycle 검출은 반복형 graph walk이고, root event ID는 과거 방향을 한 번만 계산해 registry로
보존한다. 따라서 긴 chain에서 재귀 호출 스택을 소비하거나 statement마다 root까지 다시
걸어가는 제곱 비용을 만들지 않는다.

## seq별 효력 계산

검증된 사건을 실제 `seq` 순서로 훑으며 statement retraction set, merge/alias decision
retraction set과 당시까지의 supersedes child를 갱신한다.

| 사건 | pre-scan 처리 |
|---|---|
| claim retraction | canonical target을 실제 seq 위치의 의미 사건으로 보존한다. support cutoff는 PRJ-006이 적용한다. |
| statement retraction, `cascade:true` | 그 시점까지 존재한 root chain component 전체를 실제 seq 순서로 확장해 retracted로 만든다. |
| statement retraction, `cascade:false` | exact statement만 retracted로 만들고 가능한 predecessor를 복원한다. |
| merge/alias retraction | exact decision을 최종 의미 stream에서 제외한다. |

`cascade:false`가 살아 있는 chain의 중간을 잘라 ancestor와 descendant를 동시에 leaf로 만드는
경우에는 `MULTIPLE_LIVE_LEAVES`로 거부한다. leaf successor만 철회하면 predecessor가 `live`로
복원된다. 이미 exact 철회된 successor를 나중에 `cascade:true`로 다시 가리키면 전체 chain을
삭제할 수 있다.

최종 statement 상태 우선순위는 다음과 같다.

```text
직접 또는 cascade 범위에 포함됨 → retracted
살아 있는 direct successor가 있음 → superseded
그 외                           → live
```

같은 root component의 live leaf는 최대 하나다. 철회된 중간 노드를 건너뛰어 descendant를
ancestor의 direct successor처럼 취급하지 않는다.

## actual anchor와 effective history 분리

모든 statement는 최종 상태와 관계없이 실제 journal seq로 PRJ-003 occurrence candidate를
등록한다. 예를 들어 seq 3의 첫 draft는 root가 seq 1이어도 `c3.0`, `e3.0`에서 시작한다.

살아 있는 재해석 leaf의 의미 사건은 다음 두 시각/순서를 함께 가진다.

| 값 | 출처 |
|---|---|
| `eventId`, `actualSeq`, `recordedAt`, `parsed`, candidate ID | 실제 leaf journal 사건 |
| `rootEventId`, `orderSeq`, `createdAt`, provenance, TTL | 최초 root statement |

effective stream은 `orderSeq`, `actualSeq`, event ID 순으로 정렬한다. 따라서 seq 3에 append된
재해석 payload가 root의 seq 1 위치에 놓이고, seq 2 이후의 claim retraction이나 독립
`describes` 결정을 최신 write처럼 덮지 못한다. TTL 만료 시각 계산 자체는 PRJ-006/008이
ADR-010의 effective `createdAt`을 사용해 수행한다.

## 출력과 실패 계약

`ProjectionPreScanResult`는 다음 세 collection을 반환한다.

- `statements`: 모든 statement의 actual/root anchor, 최종 상태와 effective/recorded metadata
- `statementCandidates`: 모든 실제 statement의 frozen parsed payload와 occurrence candidate ID
- `events`: live statement leaf, 모든 retraction과 retraction되지 않은 merge/alias의 총순서

결과와 중첩 배열·JSON payload·target은 재귀적으로 변경할 수 없다. `ProjectionPreScanError`는
고정 code/message만 제공하고 원문, ID, scope와 parser/allocator cause를 보관하지 않는다.
PRJ-001 입력 오류도 같은 payload-redaction 원칙을 유지한다.

## TDD와 검증

첫 RED는 아직 없는 `ProjectionPreScanError` export에서 실패했다. 구현 검토 중 참조 spike와
대조해 두 가지 추가 RED를 만들었다.

1. `A→B→C`에서 중간 `B`만 exact 철회하면 두 live leaf가 생기는데 이를 허용하던 문제
2. 12,000단계 cycle/cascade가 재귀 호출 스택을 소진하던 문제

direct-child leaf 판정과 반복형 traversal/root registry로 두 문제를 수정했다. fixture는 다음을
검증한다.

- 정상 stream, 입력 불변성과 recursive freeze
- claim/event retraction, merge/alias 제외와 잘못된 target/cascade
- cascade true/false, predecessor 복원, 중간 cut과 branch 거부
- cycle, 미래·없는·다른 kind·교차 scope supersedes
- root order와 leaf actual ID, effective/recorded 시각 및 metadata 승계
- backdated reinterpret와 후속 사건 순서
- malformed payload 비노출, 재실행 byte 동등성과 12,000단계 stack 안전성

```bash
pnpm verify:prj-004
pnpm verify:local
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
python3 docs/roadmap/validate.py
```

PRJ-004 완료 시점 기준 target은 14/14, 빠른 전체 suite는 131/131이다. S14/S15의 pre-scan
부분은 production fixture로 고정했지만 claim/support·`describes` reduce와 SQLite prefix
parity가 아직 없으므로 scenario manifest는 `planned`를 유지한다. Python behavior spike는
독립 oracle이며 production code에서 import하거나 복사하지 않았다.

## 후속 작업 경계

- PRJ-005: effective statement를 entity/surface/kind occurrence와 연결
- PRJ-006: claim/support, retraction cutoff, TTL과 cardinality 상태 전이
- PRJ-007: live merge/alias 적용과 decision retraction 후 구조 복원
- PRJ-008: 유효 support aggregate와 relation label
- PRJ-009: 증분/full dispatcher와 journal+projection 원자 publish
- PRJ-010: 모든 journal prefix의 online/full replay canonical parity
- REC-007/REL-008: 승인된 reinterpret append/report workflow

Accepted ADR의 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
