# Roadmap 작업 템플릿

아래 블록을 해당 phase 문서에 복사한다. 같은 정보가 phase 작업 표에도 있어야 한다.

```markdown
### XXX-000 — 작업 제목

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-XXX
- 선행 작업: XXX-000
- 결과물: 코드, migration, fixture 또는 문서

완료 체크:

- [ ] 구현 결과를 검증할 수 있다.
- [ ] 정상·실패 경로 테스트가 통과한다.
- [ ] 관련 문서와 roadmap roll-up을 갱신했다.

증거:

- PR: —
- 검증: —
- 비고: —

Blocker (`BLOCKED`일 때만):

- 발생일: YYYY-MM-DD
- 사유: —
- 필요한 결정/외부 변화: —
- 해제 책임자: `unassigned`
```

## 작성 규칙

- 제목과 범위를 바꾸어 기존 ID를 재사용하지 않는다.
- 여러 phase에 걸친 작업은 최종 결과를 소유하는 phase에 두고 선행 작업을 연결한다.
- 체크 항목은 “구현한다”보다 관찰 가능한 결과와 실패 조건을 쓴다.
- 증거는 브랜치가 아니라 병합된 PR 또는 immutable CI 실행을 링크한다.
- `DONE` 작업에 `—` 증거가 남아 있으면 안 된다.
