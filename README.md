# Knowledge Graph

사용자의 **두 번째 뇌**를 MCP 기반 knowledge graph로 저장하는 저장소입니다.

사용자의 지식과 맥락을 구조화해, 어떤 AI agent를 사용하더라도 필요한 정보를 기억하고 활용할 수 있게 하는 것을 목표로 합니다.

## Status

초기 개발 단계입니다.

## 빠른 시작

개발 환경은 Node.js `24.19.0`과 pnpm `11.22.0`을 사용합니다.

```bash
pnpm install --frozen-lockfile
pnpm verify:local
```

작업 ID 선택, TDD, 로컬 DB 안전 경로, 검증과 PR 절차는
[기여 가이드](CONTRIBUTING.md)를 따릅니다. Recall v1은 자동 CI를 운영하지 않으므로 각
PR에 로컬 검증 결과를 남겨야 합니다.

## Documentation

- [에이전트 공통 작업 규칙](AGENTS.md)
- [기여 가이드](CONTRIBUTING.md)
- [SQLite 저장 경로와 startup 운영 계약](docs/operations/storage.md)
- [Scope 배포 설정과 실패 계약](docs/operations/scope.md)
- [Runtime metadata 배포와 실패 계약](docs/operations/metadata.md)
- [초기 설계안](docs/init-design.md)
- [Accepted ADR 목록](docs/adr/README.md)
- [ADR 전체 리뷰](docs/adr/review.md)
- [ADR 시스템 동작 spike 결과](docs/spikes/adr-behavior-report.md)
- [구현 로드맵과 진행 현황](docs/roadmap/README.md)
- [기존 증거와 production 잔여 gate 감사](docs/roadmap/evidence-audit.md)
- [FND-001 production 기술 스택 결정](docs/implementation/fnd-001-production-stack.md)
- [FND-002 제품 모듈과 의존 방향](docs/implementation/fnd-002-module-boundaries.md)
- [FND-003 결정적 runtime 경계](docs/implementation/fnd-003-runtime-boundaries.md)
- [FND-004 public/domain schema 단일 출처](docs/implementation/fnd-004-schema-source.md)
- [FND-005 로컬 TDD 테스트 전략](docs/implementation/fnd-005-test-strategy.md)
- [FND-006 CI 작업 범위 제외 결정](docs/implementation/fnd-006-ci-retirement.md)
- [STO-005 trusted scope resolver](docs/implementation/sto-005-scope-resolver.md)
- [STO-006 trusted runtime metadata](docs/implementation/sto-006-runtime-metadata.md)
- [STO-007 append-only journal repository](docs/implementation/sto-007-append-only-journal.md)
- [STO-008 storage recovery와 concurrency 검증](docs/implementation/sto-008-storage-recovery-concurrency.md)
- [PRJ-001 scope replay와 canonical projection 계약](docs/implementation/prj-001-replay-contract.md)
