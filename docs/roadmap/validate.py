#!/usr/bin/env python3
"""Validate the roadmap's structure, dependencies, links, and traceability."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ROADMAP = ROOT / "docs" / "roadmap"
EXPECTED = {
    "RDY": 7,
    "FND": 7,
    "STO": 8,
    "PRJ": 10,
    "REC": 8,
    "REV": 7,
    "RCL": 9,
    "MCP": 8,
    "REL": 10,
}
VALID_STATUSES = {"TODO", "IN_PROGRESS", "BLOCKED", "DONE"}
TASK_HEADING = re.compile(r"^### ([A-Z]{3}-\d{3}) — (.+)$", re.MULTILINE)
TASK_ROW = re.compile(r"^\| ([A-Z]{3}-\d{3}) \|.*$", re.MULTILINE)
MARKDOWN_LINK = re.compile(r"(?<!!)\[[^]]+\]\(([^)]+)\)")
EVIDENCE_ROW = re.compile(
    r"^- \[x\] `([A-Z]{3}-\d{3})` \| baseline: (.+) \| production: (.+)$",
    re.MULTILINE,
)
EVIDENCE_MARKER = re.compile(
    r"^- \[([ x])\] `([A-Z]{3}-\d{3})`",
    re.MULTILINE,
)


def expand_task_references(value: str) -> set[str]:
    references = set(re.findall(r"\b[A-Z]{3}-\d{3}\b", value))
    for prefix, start, end in re.findall(
        r"\b([A-Z]{3})-(\d{3})~(\d{3})\b", value
    ):
        references.update(
            f"{prefix}-{number:03d}"
            for number in range(int(start), int(end) + 1)
        )
    return references


def parse_table_rows(text: str) -> dict[str, list[str]]:
    rows: dict[str, list[str]] = {}
    for line in text.splitlines():
        if not re.match(r"^\| [A-Z]{3}-\d{3} \|", line):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        rows[cells[0]] = cells
    return rows


def task_blocks(text: str) -> dict[str, str]:
    matches = list(TASK_HEADING.finditer(text))
    return {
        match.group(1): text[
            match.end() : matches[index + 1].start()
            if index + 1 < len(matches)
            else len(text)
        ]
        for index, match in enumerate(matches)
    }


def main() -> int:
    errors: list[str] = []
    phase_files = sorted(ROADMAP.glob("[0-9][0-9]-*.md"))
    all_ids: set[str] = set()
    dependency_graph: dict[str, set[str]] = {}
    status_totals = {status: 0 for status in VALID_STATUSES}
    task_statuses: dict[str, str] = {}
    phase_summaries: dict[str, tuple[str, int, int]] = {}

    if len(phase_files) != 9:
        errors.append(f"expected 9 phase files, found {len(phase_files)}")

    parsed: list[tuple[Path, str, dict[str, list[str]], dict[str, str]]] = []
    for path in phase_files:
        text = path.read_text(encoding="utf-8")
        rows = parse_table_rows(text)
        blocks = task_blocks(text)
        heading_ids = list(blocks)
        row_ids = list(rows)

        if len(heading_ids) != len(set(heading_ids)):
            errors.append(f"{path.name}: duplicate detail heading")
        if set(heading_ids) != set(row_ids):
            errors.append(
                f"{path.name}: heading/table mismatch "
                f"{sorted(set(heading_ids) ^ set(row_ids))}"
            )
        for task_id in heading_ids:
            if task_id in all_ids:
                errors.append(f"duplicate task ID: {task_id}")
            all_ids.add(task_id)
        parsed.append((path, text, rows, blocks))

    for prefix, expected_count in EXPECTED.items():
        actual = sorted(task_id for task_id in all_ids if task_id.startswith(prefix + "-"))
        expected_ids = [f"{prefix}-{number:03d}" for number in range(1, expected_count + 1)]
        if actual != expected_ids:
            errors.append(f"{prefix}: expected {expected_ids}, found {actual}")

    dependency_graph = {task_id: set() for task_id in all_ids}
    for path, text, rows, blocks in parsed:
        table_status_counts = {status: 0 for status in VALID_STATUSES}
        for task_id, cells in rows.items():
            if len(cells) != 6:
                errors.append(f"{task_id}: expected 6 table columns, found {len(cells)}")
                continue
            table_status = cells[2].strip("`")
            table_owner = cells[3].strip("`")
            if table_status not in VALID_STATUSES:
                errors.append(f"{task_id}: invalid table status {table_status!r}")
                continue
            table_status_counts[table_status] += 1
            status_totals[table_status] += 1
            task_statuses[task_id] = table_status

            block = blocks.get(task_id, "")
            status_match = re.search(r"^- 상태: `([^`]+)`$", block, re.MULTILINE)
            owner_match = re.search(r"^- Owner: `([^`]+)`$", block, re.MULTILINE)
            if not status_match or not owner_match:
                errors.append(f"{task_id}: missing detail status or owner")
                continue
            detail_status = status_match.group(1)
            detail_owner = owner_match.group(1)
            if (table_status, table_owner) != (detail_status, detail_owner):
                errors.append(f"{task_id}: table/detail status or owner mismatch")
            if detail_status == "TODO" and detail_owner != "unassigned":
                errors.append(f"{task_id}: TODO owner must be unassigned")
            if detail_status in {"DONE", "IN_PROGRESS"} and detail_owner == "unassigned":
                errors.append(f"{task_id}: active/done task needs an owner")

            checkboxes = re.findall(r"^- \[([ x])\] ", block, re.MULTILINE)
            if not checkboxes:
                errors.append(f"{task_id}: no completion checklist")
            if detail_status == "DONE" and any(value != "x" for value in checkboxes):
                errors.append(f"{task_id}: DONE task has unchecked completion item")
            if detail_status == "TODO" and any(value == "x" for value in checkboxes):
                errors.append(f"{task_id}: TODO task has checked completion item")
            if detail_status == "DONE" and cells[5] == "—":
                errors.append(f"{task_id}: DONE task has no evidence")

            if task_id.startswith("RDY-"):
                dependency_lines = re.findall(
                    r"^- 선행 작업: (.+)$", block, re.MULTILINE
                )
                dependency_text = dependency_lines[0] if dependency_lines else ""
            else:
                dependency_text = cells[4]
            dependency_graph[task_id] = expand_task_references(dependency_text)

        progress = re.search(r"^- 진행률: (\d+)/(\d+)$", text, re.MULTILINE)
        if not progress:
            errors.append(f"{path.name}: missing progress header")
        else:
            done, total = map(int, progress.groups())
            if done != table_status_counts["DONE"] or total != sum(
                table_status_counts.values()
            ):
                errors.append(
                    f"{path.name}: progress {done}/{total} does not match "
                    f"table {table_status_counts}"
                )
            phase_status = re.search(r"^- 상태: `([^`]+)`$", text, re.MULTILINE)
            if not phase_status or phase_status.group(1) not in VALID_STATUSES:
                errors.append(f"{path.name}: missing or invalid phase status")
            else:
                phase_summaries[path.name[:2]] = (phase_status.group(1), done, total)

    for task_id, dependencies in dependency_graph.items():
        unknown = dependencies - all_ids
        if unknown:
            errors.append(f"{task_id}: unknown dependencies {sorted(unknown)}")

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(task_id: str, trail: list[str]) -> None:
        if task_id in visiting:
            errors.append("dependency cycle: " + " -> ".join(trail + [task_id]))
            return
        if task_id in visited:
            return
        visiting.add(task_id)
        for dependency in dependency_graph.get(task_id, set()):
            if dependency in all_ids:
                visit(dependency, trail + [task_id])
        visiting.remove(task_id)
        visited.add(task_id)

    for task_id in sorted(all_ids):
        visit(task_id, [])

    evidence_path = ROADMAP / "evidence-audit.md"
    evidence_text = ""
    if not evidence_path.is_file():
        errors.append("missing roadmap evidence audit")
    else:
        evidence_text = evidence_path.read_text(encoding="utf-8")
        evidence_rows = EVIDENCE_ROW.findall(evidence_text)
        evidence_ids = [task_id for task_id, _, _ in evidence_rows]
        evidence_markers = EVIDENCE_MARKER.findall(evidence_text)
        product_ids = sorted(
            task_id for task_id in all_ids if not task_id.startswith("RDY-")
        )
        if len(evidence_markers) != len(evidence_rows):
            errors.append("evidence audit has unchecked or malformed task rows")
        if len(evidence_ids) != len(set(evidence_ids)):
            errors.append("evidence audit has duplicate task rows")
        if sorted(evidence_ids) != product_ids:
            errors.append(
                "evidence audit task mismatch "
                f"{sorted(set(evidence_ids) ^ set(product_ids))}"
            )
        audited_product_done = sum(
            task_statuses[task_id] == "DONE" for task_id in product_ids
        )
        completion_boundary = (
            f"제품 작업 완료 수는 현재 {audited_product_done}/{len(product_ids)}이다"
        )
        if completion_boundary not in evidence_text:
            errors.append("evidence audit must preserve the product completion boundary")

    for path, text, _, _ in parsed:
        if path.name == "00-readiness.md":
            continue
        if "- 선행 증거 감사: [" not in text or "(evidence-audit.md#" not in text:
            errors.append(f"{path.name}: missing evidence audit entry link")
        if "완료 체크를 대신하지 않는다." not in text:
            errors.append(f"{path.name}: missing baseline/product status boundary")

    agent_guide = ROOT / "AGENTS.md"
    claude_guide = ROOT / "CLAUDE.md"
    for path in (agent_guide, claude_guide):
        if not path.is_file():
            errors.append(f"missing agent instruction file: {path.name}")

    if agent_guide.is_file():
        agent_text = agent_guide.read_text(encoding="utf-8")
        if len(agent_text.encode("utf-8")) > 32 * 1024:
            errors.append("AGENTS.md exceeds the 32 KiB project instruction budget")
        required_agent_content = {
            "Accepted ADR link": "[Accepted ADR 목록](docs/adr/README.md)",
            "roadmap link": "[구현 로드맵](docs/roadmap/README.md)",
            "spike link": "[behavior spike](spikes/adr-behavior/README.md)",
            "evidence audit link": "[evidence-gap audit](docs/roadmap/evidence-audit.md)",
            "roadmap validation command": "python3 docs/roadmap/validate.py",
            "four-state workflow": "`TODO`, `IN_PROGRESS`, `BLOCKED`, `DONE`",
            "journal invariant": "journal은 append-only",
            "projection invariant": "projection과 FTS는 파생 상태",
            "evidence gap rule": "baseline을 신규 작업으로 제안하거나 반복하지 않는다",
        }
        for label, expected in required_agent_content.items():
            if expected not in agent_text:
                errors.append(f"AGENTS.md: missing {label}")

    if claude_guide.is_file():
        claude_text = claude_guide.read_text(encoding="utf-8")
        imports = [
            line.strip() for line in claude_text.splitlines() if line.strip() == "@AGENTS.md"
        ]
        if len(imports) != 1:
            errors.append("CLAUDE.md must import @AGENTS.md exactly once")
        if len(claude_text.splitlines()) > 20:
            errors.append("CLAUDE.md should remain a thin tool-specific entry file")

    markdown_files = [
        ROOT / "README.md",
        agent_guide,
        claude_guide,
        *sorted(ROADMAP.glob("*.md")),
    ]
    link_count = 0
    for path in markdown_files:
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        for line_number, line in enumerate(text.splitlines(), start=1):
            if line.rstrip() != line:
                errors.append(f"{path.relative_to(ROOT)}:{line_number}: trailing whitespace")
            if line.startswith(("<<<<<<<", "=======", ">>>>>>>")):
                errors.append(f"{path.relative_to(ROOT)}:{line_number}: conflict marker")
        for raw_target in MARKDOWN_LINK.findall(text):
            link_count += 1
            target = raw_target.strip().strip("<>")
            if re.match(r"^[a-z]+://", target) or target.startswith("#"):
                continue
            target = target.split("#", 1)[0]
            resolved = (path.parent / target).resolve()
            if not resolved.exists():
                errors.append(f"broken link: {path.relative_to(ROOT)} -> {target}")

    traceability = (ROADMAP / "traceability.md").read_text(encoding="utf-8")
    for number in range(1, 18):
        adr = f"ADR-{number:03d}"
        if not re.search(rf"^\| {adr} \|", traceability, re.MULTILINE):
            errors.append(f"missing traceability row: {adr}")
    for number in range(1, 25):
        scenario = f"S{number:02d}"
        if not re.search(rf"^\| {scenario} \|", traceability, re.MULTILINE):
            errors.append(f"missing traceability row: {scenario}")

    master = (ROADMAP / "README.md").read_text(encoding="utf-8")
    product_count = sum(not task_id.startswith("RDY-") for task_id in all_ids)
    readiness_count = len(all_ids) - product_count
    readiness_done = sum(
        status == "DONE"
        for task_id, status in task_statuses.items()
        if task_id.startswith("RDY-")
    )
    product_done = sum(
        status == "DONE"
        for task_id, status in task_statuses.items()
        if not task_id.startswith("RDY-")
    )
    done_count = readiness_done + product_done
    if f"| 구현 준비 | {readiness_done} | {readiness_count} |" not in master:
        errors.append("master readiness roll-up is stale")
    if f"| 제품 구현 | {product_done} | {product_count} |" not in master:
        errors.append("master product roll-up is stale")
    if f"| 전체 | {done_count} | {len(all_ids)} |" not in master:
        errors.append("master overall roll-up is stale")

    for phase_number, (status, done, total) in phase_summaries.items():
        row = re.search(
            rf"^\| {phase_number} \|.*\| `([^`]+)` \| (\d+)/(\d+) \|",
            master,
            re.MULTILINE,
        )
        if not row:
            errors.append(f"master phase row missing: {phase_number}")
            continue
        if (row.group(1), int(row.group(2)), int(row.group(3))) != (
            status,
            done,
            total,
        ):
            errors.append(f"master phase row is stale: {phase_number}")

    print(f"phase_files={len(phase_files)}")
    print(
        f"tasks={len(all_ids)} readiness="
        f"{sum(task_id.startswith('RDY-') for task_id in all_ids)} "
        f"product={product_count}"
    )
    print(
        "by_prefix="
        + ", ".join(
            f"{prefix}:{sum(task_id.startswith(prefix + '-') for task_id in all_ids)}"
            for prefix in EXPECTED
        )
    )
    print(f"local_and_external_links_parsed={link_count}")
    print("adr_trace=17/17 scenario_trace=24/24")
    print(f"evidence_gap_audit={len(EVIDENCE_ROW.findall(evidence_text))}/67")

    if errors:
        print("roadmap_audit=FAIL", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print("dependency_graph=acyclic")
    print("roadmap_audit=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
