# PRJ-007: merge·alias와 claim rewrite

- 상태: 구현 완료
- 결정일: 2026-08-22
- 작업: PRJ-007
- Owner: `log0629`
- 규범 근거: ADR-002, ADR-007~009, ADR-015
- 선행 구현: PRJ-003~006
- 구현 branch: `prj-007-merge-alias-rewrite`
- PR: [#27](https://github.com/yeonjaekim99/knowledge-graph/pull/27)

## 목적과 범위

PRJ-007은 PRJ-004의 effective event stream과 PRJ-005/006의 entity·claim 규칙을 한 의미
순서에서 조합해 merge와 alias 결정을 투영한다. 결과는 모든 occurrence anchor와 historical
loser row를 보존하면서 surface, entity reference, claim identity와 support를 현재 canonical
ID로 정합화한다.

이번 작업은 다음을 구현한다.

- 명시적 `keep ← absorb` entity merge와 terminal redirect
- absorb surface의 origin 우선순위 보존과 alias `confirmed` 기여
- subject/object entity reference를 바꾼 뒤의 claim identity 재작성
- numeric-earliest claim survivor, losing claim history와 support dedupe
- 서로 다른 `describes` 값이 한 subject slot으로 모일 때의 구조적 승자 선택
- merge/alias event 철회가 후속 statement 해석까지 되돌리는 full replay 의미
- 반복 병합 no-op, 반대 방향 cycle과 손상된 decision body의 안전한 실패

TTL·aggregate·relation label·contested는 PRJ-008, SQLite publish와 incremental/full dispatcher는
PRJ-009, 모든 journal prefix의 production/oracle parity는 PRJ-010 범위다. 공개
`memory_revise` 입력 해석과 event append는 REV-001~006이 소유한다.

## 왜 결정을 사후 적용하지 않는가

PRJ-005 entity 결과와 PRJ-006 claim 결과를 모두 만든 뒤 최종 ID만 치환하면 merge 이전의
서로 다른 `describes` slot이 처음부터 하나였던 것처럼 처리된다. 예를 들어 A와 B가 서로
다른 값을 갖고, B의 현재 claim이 merge 전에 철회된 경우에는 A 값이 살아 있어야 한다.
최종 ID를 선적용하면 B 값이 A 값을 먼저 supersede한 뒤 철회되어 active 값이 사라진다.

따라서 `reduceMergeAliasState`는 PRJ-004가 정렬한 다음 사건을 한 stream에서 처리한다.

```text
effective statement | claim retraction | merge | alias
```

event-level statement·merge·alias 철회는 pre-scan이 해당 사건을 stream에서 처음부터
제외한다. reducer 안에 역연산을 만들지 않으므로 decision 이후 statement가 그 alias나
merge를 사용했던 해석도 자연스럽게 다시 계산된다.

결정이 없는 입력에서는 PRJ-005/006의 entity·claim collection과 byte-equivalent한 결과를
낸다. statement가 등록한 agent-supplied alias가 뒤 statement의 이름 해석을 바꾸는 경우처럼
두 기존 reducer 사이에서 canonical entity row가 생기는 seam은 combined reducer가 직접
닫는다.

## anchor와 결정적 registry

모든 stored statement draft를 실제 journal seq와 stored draft index 순서로 먼저 등록한다.
live 여부와 무관하게 다음 anchor를 유지한다.

- subject와 entity object의 `e{actual_seq}.{position}` 후보
- claim의 `c{actual_seq}.{draft_index}` 후보
- `(event_id, draft_index)` support occurrence
- entity·claim occurrence에서 최종 canonical ID로 가는 mapping

초기 normal-name과 claim identity dedupe는 ADR-002의 숫자 occurrence 순서를 사용한다.
명시적 entity merge만 사용자가 선택한 `keep`을 우선한다. claim survivor는 entity keep과
독립적으로 `origin_seq`, 같은 seq에서는 numeric draft index가 가장 작은 ID다. `c2.0`이
`c10.0`보다 먼저라는 규칙을 문자열 정렬로 대체하지 않는다.

모든 redirect는 reduce 종료 전에 terminal canonical ID로 압축하고 기존 source reason을
유지한다. entity와 claim registry를 다시 검증해 dangling target, kind 혼합, cycle과 scope
손상을 게시 전에 실패시킨다.

## entity merge와 alias

merge body는 이미 preflight된 canonical entity ID만 받으며 실제 decision seq보다 앞선 같은
scope anchor인지 다시 확인한다. 유효한 merge는 다음 순서로 적용한다.

1. absorb를 keep으로 redirect한다.
2. absorb의 surface를 keep으로 옮기고 `confirmed > name > agent_supplied` 중 강한 origin을
   남긴다.
3. claim의 subject/object를 terminal entity로 바꾼 identity를 계산한다.
4. 동일 identity claim과 중복 support를 합친다.
5. 같은 subject의 active `describes`를 구조적 activation 순서로 정리한다.

이미 `absorb → keep` 방향으로 합쳐진 반복 merge는 결과를 바꾸지 않는다. 반대로 keep이
absorb를 향하는 상태에서 방향을 뒤집으면 cycle로 거부한다. merge chain은 모든 과거 ID가
같은 terminal을 가리키도록 압축한다.

alias body의 원문 surface는 ADR-006으로 정규화하고 `origin='confirmed'`로 UPSERT한다. 같은
surface가 다른 entity에도 있으면 homonym일 수 있으므로 삭제하지 않는다. 뒤 statement가
그 surface를 이름으로 쓰면 후보 전체를 canonicalize하고 exact normal-name 하나로도
결정되지 않을 때 `AMBIGUOUS_ENTITY`로 실패한다.

## claim rewrite와 `describes`

entity rewrite 뒤 같은 claim identity가 된 행은 다음처럼 합친다.

- numeric-earliest claim을 survivor로 선택한다.
- losing support를 survivor로 옮긴다.
- 같은 `(claim_id, event_id)`가 겹치면 작은 draft index 하나를 남긴다.
- 중복 support 중 하나라도 아직 구조적으로 live이면 합친 support도 live다.
- 명시적 merge의 losing claim은 `superseded` row와 `reason='merge'` redirect로 보존한다.

서로 다른 값의 active `describes`가 같은 subject로 모이면 각 claim을 마지막으로 active로
만든 구조적 live statement의 `(order_seq, actual_seq, draft_index)`를 비교한다. 가장 큰
값만 active이고 나머지는 superseded다. backdated reinterpret의 actual append seq가 커도
root order가 과거이면 최신 결정을 덮지 않는다.

리뷰 중 동일 identity 두 행 중 한쪽이 이미 claim 철회된 반례를 추가했다. survivor가
active라고 해서 철회된 행의 더 늦은 과거 activation을 승자 비교에 사용하면 다른
`describes` 값을 잘못 밀어낼 수 있다. 최종 state와 같은 행의 activation만 합치도록 고쳐
구조적으로 살아 있는 기여만 cardinality 판단에 사용한다.

claim-level retraction은 target redirect를 당시 canonical까지 따라가고
`statement.order_seq < retraction.actual_seq`인 support만 끊는다. merge 뒤 승자 claim을
철회해도 과거 describes loser를 자동 복구하지 않는다. merge event 자체를 철회한 replay만
원래 subject slot을 다시 갈라 각 값을 복원한다.

## 출력과 실패 계약

`MergeAliasStateProjection`은 다음 collection을 명시적으로 정렬하고 재귀적으로 freeze한다.

- entity/claim anchor와 occurrence
- canonical·merged entity row와 surface form
- active/superseded/retracted claim row와 structural support
- entity/claim terminal redirect
- merge 뒤 다시 계산한 kind와 kind maintenance candidate

reducer는 DB, clock, network, process 전역과 behavior spike 코드를 읽지 않으며 입력을
변경하지 않는다. `ProjectionDecisionError`는 고정 code/message만 제공하고 raw text,
surface, subject/object, target ID, scope나 내부 cause를 보관하지 않는다. malformed body,
missing/future target, reverse cycle, ambiguity, duplicate stored claim과 forged state를 서로
구분하되 제출 값을 echo하지 않는다.

현재 구현은 정확성 우선의 full-scope pure reducer다. merge와 alias-derived dedupe가 발생할
때 claim identity를 다시 계산하므로 decision 수가 큰 replay의 성능은 PRJ-009/010과
REL-001~003의 실제 dispatcher·10만 event fixture에서 측정한다. 측정 전에 snapshot/cache나
의미가 다른 증분 최적화를 도입하지 않는다.

## TDD와 리뷰

첫 RED는 test가 import한 `ProjectionDecisionError` export가 없어 ESM module instantiation에서
실패했다. GREEN 뒤 전체 diff를 ADR Validation과 대조하면서 다음 반례를 추가 RED로 만들었다.

- alias/merge event 철회 뒤의 후속 statement도 사건이 없었던 replay와 같아야 한다.
- merge 전 claim 철회가 다른 subject의 과거 describes 값을 먼저 supersede하면 안 된다.
- 철회된 duplicate의 activation이 merge 뒤 cardinality 승자가 되면 안 된다.
- backdated reinterpret는 merge를 거쳐도 뒤의 일반 statement보다 최신이 될 수 없다.
- 같은 방향 반복 merge는 no-op이고 반대 방향 redirect는 cycle이다.

최종 19개 fixture는 no-decision PRJ-005/006 parity, agent-supplied·confirmed alias resolution,
S07 support 보존, S08 origin 복원, S17 describes merge, S21 후속 entity resolution, numeric
`c2 < c10`, subject/object rewrite, support collision, redirect chain, kind, ambiguity와
payload-redacted failure를 포함한다.

## 검증

```bash
pnpm verify:prj-007
pnpm test:prj-005
pnpm test:prj-006
pnpm verify:local
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
python3 docs/roadmap/validate.py
pnpm audit --prod
```

완료 시점 기준 PRJ-007 target은 19/19, PRJ-005는 11/11, PRJ-006은 15/15,
빠른 전체 suite는 176/176, 독립 behavior spike는 25/25다. architecture/type/build,
roadmap audit와 production dependency audit도 통과했다.

S07/S08/S17/S21의 domain 상태 primitive는 고정했지만 SQLite prefix publish와 공개
record/revise/recall 경로가 남아 production scenario manifest는 `planned`를 유지한다.
PRJ-010이 별도 production reducer와 reference oracle의 모든 prefix parity를 증명한 뒤에만
scenario 전체를 구현 완료로 올린다.

## 후속 작업 경계

- PRJ-008: effective TTL, statement/support expiry와 aggregate·label·contested
- PRJ-009: reducer 조립, SQLite transaction, incremental/full dispatcher와 commit gate
- PRJ-010: S01~S24 production prefix·metamorphic·crash parity
- REC-004/006: write-time alias ambiguity와 statement append/project application service
- REV-005/006: public merge/alias preflight, unchanged 결과와 journal append
