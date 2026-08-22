# Unit tests

IO 없는 domain/application test만 둔다. 공통 규칙은 [`../README.md`](../README.md)를 따른다.

PRJ-003의 occurrence candidate, canonical 선택, redirect registry와 rules dry-run fixture는
[`domain/prj-003-occurrence-redirects.test.mjs`](domain/prj-003-occurrence-redirects.test.mjs)에
둔다. 이 fixture는 실제 SQLite projection이나 사건 reducer 완료를 주장하지 않는다.
