# MCP contract tests

실제 MCP SDK catalog, schema, structured result와 transport 계약을 검증한다. 공통 규칙은
[`../../README.md`](../../README.md)를 따른다.

REC-001의 [`rec-001-record-schema.test.mjs`](rec-001-record-schema.test.mjs)는 실제 MCP
Standard Schema adapter가 같은 frozen record source를 광고·검증하는지 확인한다. 아직 tool
catalog, handler나 transport를 등록하지 않으며 그 wiring은 MCP-003이 소유한다.

RCL-001의 [`rcl-001-memory-recall-contract.test.mjs`](rcl-001-memory-recall-contract.test.mjs)는
search/overview 판별 입력, 기본값, Unicode query/terms 상한과 닫힌 RecallResult answer union을
FND-004와 같은 SDK validator로 검증한다. 독립 SDK contract가 advertised source만 compile해도
padding을 제외한 query 4,096자 경계가 같은지 확인한다. schema/type drift는 같은 이름의 type
fixture가 별도 `typecheck:rcl-001`에서 막는다. 실제 tool catalog와 structuredContent wiring은
MCP-003이 소유한다.
