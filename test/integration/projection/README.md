# Projection integration tests

증분 journal prefix와 독립 full replay의 canonical parity를 검증한다. 공통 규칙은
[`../../README.md`](../../README.md)를 따른다.

현재 PRJ-001 suite는 다음 production 기반을 검증한다.

- 한 scope의 정렬된 journal과 rules version만 받는 pure reducer 경계
- `BEGIN IMMEDIATE`를 reducer 실행 동안 유지하는 scope 전체 교체와 rollback
- 다른 scope, append-only journal과 journal FTS의 불변성
- `projection_meta` missing/seq/rules mismatch와 current no-op 분기
- 여섯 projection table의 독립 `recall-projection-v1` canonical dump parity

PRJ-002의 versioned normalize와 relation/literal primitive는 domain unit·process fixture로
완료됐지만 아직 projection row를 만드는 reducer에는 연결되지 않았다. occurrence ID, 사건
pre-scan, entity/claim 상태 전이와 증분 dispatcher는 PRJ-003~009가 추가한다. 이 디렉터리의
기반 test가 있다는 사실만으로 S01/S02/S03/S24 전체 parity를 완료로 표시하지 않는다.
