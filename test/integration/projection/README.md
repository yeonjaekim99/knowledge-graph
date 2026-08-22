# Projection integration tests

증분 journal prefix와 독립 full replay의 canonical parity를 검증한다. 공통 규칙은
[`../../README.md`](../../README.md)를 따른다.

현재 PRJ-001 suite는 다음 production 기반을 검증한다.

- 한 scope의 정렬된 journal과 rules version만 받는 pure reducer 경계
- `BEGIN IMMEDIATE`를 reducer 실행 동안 유지하는 scope 전체 교체와 rollback
- 다른 scope, append-only journal과 journal FTS의 불변성
- `projection_meta` missing/seq/rules mismatch와 current no-op 분기
- 여섯 projection table의 독립 `recall-projection-v1` canonical dump parity

PRJ-002~009의 normalize, ID, pre-scan, entity/claim/decision/validity reducer와 atomic
dispatcher를 PRJ-010이 production 회귀 suite로 연결한다.

- `prj-010-scenario-prefix-parity.test.mjs`: S01~S24의 projection 가능 이력 98 prefix
- `s23-seeded-state-machine.test.mjs`: 8 trace × 36 operation, correct/scope/time/undo metamorphic
- 매 prefix의 canonical byte·checksum과 scope/FK/FTS/support/describes/redirect/meta 불변식

이 suite는 stored journal→projection 경계만 소유한다. S01~S22의 public
Record/Revise/Recall 동작은 manifest의 각 vertical target이 추가될 때까지 완료로
표시하지 않는다.
