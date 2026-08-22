# SQLite integration tests

실제 임시 SQLite file, migration, WAL과 transaction을 검증한다. 공통 규칙은
[`../../README.md`](../../README.md)를 따른다.

PRJ-008의 [`prj-008-claim-aggregate.test.mjs`](prj-008-claim-aggregate.test.mjs)는 공통
valid-support source가 diagnostic view와 scope/fixed-now TEMP aggregate에서 같은 결과를
내는지 검증한다. expiry·label·contested 경계, cross-scope corruption invariant와 TEMP 조회
전후 영구 row/data version 불변만 소유하며 실제 recall transaction은 RCL-001에 남긴다.
