# MCP contract tests

실제 MCP SDK catalog, schema, structured result와 transport 계약을 검증한다. 공통 규칙은
[`../../README.md`](../../README.md)를 따른다.

REC-001의 [`rec-001-record-schema.test.mjs`](rec-001-record-schema.test.mjs)는 실제 MCP
Standard Schema adapter가 같은 frozen record source를 광고·검증하는지 확인한다. 아직 tool
catalog, handler나 transport를 등록하지 않으며 그 wiring은 MCP-003이 소유한다.
