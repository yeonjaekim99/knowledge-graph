# Recall ADR behavior spike

이 디렉터리는 ADR-001~017의 핵심 상태 전이와 불변식을 제품 구현 전에 실행해보는
참조 spike다. 프로덕션 Recall 서버, MCP transport 또는 재사용 가능한 application
library가 아니다.

## 목적

- append-only journal만으로 projection을 반복 복원할 수 있는지 확인한다.
- 철회·교정·병합·별칭·TTL·scope·조회·재해석 규칙이 함께 동작하는지 확인한다.
- 결정적 무작위 사건 trace와 메타모픽 변환에서도 같은 불변식이 유지되는지 확인한다.
- journal append, projection 재작성과 commit 경계에서 프로세스가 종료돼도 원자적으로
  재개방되는지 확인한다.
- 설계 결함과 단순 구현 선택을 제품 코드 작성 전에 분리한다.
- 향후 production projector와 recall engine이 대조할 수 있는 작은 oracle을 남긴다.

## 의도적인 제한

- 모든 write 뒤 projection 전체를 다시 만든다. 증분 projector를 구현하지 않는다.
- MCP server, tool handler, JSON Schema catalog와 SDK 통합을 구현하지 않는다.
- Python과 `sqlite3`는 spike 실행 수단일 뿐 production 기술 선택이 아니다.
- 비밀값 signature는 대표 형식만 넣는다. production registry의 완성본이 아니다.
- full detail의 1 MiB 예산, agent parsing/call fixture와 10만 사건 성능 gate는 실행하지
  않는다.
- spike module을 향후 `src/`에서 import하거나 그대로 이식하지 않는다. 제품 코드는
  Accepted ADR과 test fixture를 기준으로 별도로 작성한다.

## 실행

저장소 루트에서 다음 한 명령으로 실행한다.

```bash
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
```

필요 조건은 Python 3.12 계열과 FTS5 trigram, JSON 함수, `unixepoch()`를 포함한 SQLite다.
runner는 시작할 때 실제 capability query를 실행하며 빠진 기능이 있으면 실패한다.

## 구조

- `reference.py`: 전체 replay 방식의 SQLite 참조 reducer와 recall oracle
- `test_behavior.py`: 고정 시각·고정 입력을 사용하는 행동 시나리오
- `crash_worker.py`: 선택한 transaction 지점에서 `os._exit`하는 장애 주입 child process
- `scenario-matrix.json`: 시나리오와 ADR 근거의 기계 판독 가능한 매핑
- [`../../docs/spikes/adr-behavior-report.md`](../../docs/spikes/adr-behavior-report.md):
  실행 결과와 ADR별 판정

## 판정 기준

- `confirmed`: 이 spike의 실행 증거로 해당 핵심 규칙이 함께 성립함을 확인했다.
- `ADR defect`: 실행 결과가 Accepted ADR의 규범끼리 양립할 수 없음을 보였다.
- `implementation decision`: transport, 최적화, 운영 또는 production 품질 때문에 실제
  구현 단계에서 선택·검증해야 한다. spike가 통과했다는 이유로 완료 처리하지 않는다.

## 참조 모델 사용 원칙

참조 reducer의 입력은 저장된 journal과 `RULES_VERSION`뿐이다. wall clock은 TTL이
projection state에 굽지 않도록 recall 호출의 `now`로만 주입한다. canonical projection
checksum은 `projection_meta`, FTS와 TEMP 객체를 제외하고 PK 순서의 type-tagged 값으로
계산한다.

무작위 검증도 재현 가능해야 하므로 고정 seed와 고정 36-prefix trace만 사용한다. 장애
복구 검증은 Python 예외가 아니라 별도 프로세스의 `os._exit`를 사용해 정상
rollback/connection close 경로를 우회한다.

write API 모양은 test 편의를 위한 Python method일 뿐 public MCP 계약이 아니다. 특히
모든 write에서 전체 replay를 하는 비용과 반환값의 일부 축약은 production API의 선례로
사용하지 않는다.
