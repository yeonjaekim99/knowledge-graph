"""Child process used to prove SQLite recovery after an ungraceful exit.

This is deliberately a test harness.  The selected fault hook calls os._exit so
Python cannot roll back or close the SQLite connection on the way out.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from reference import ReferenceSpike


SCOPE = "u:alice/p:recall"
T0 = 1_700_000_000
CRASH_EXIT_CODE = 91


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit("usage: crash_worker.py DB_PATH FAULT_POINT record|correct")
    db_path = Path(sys.argv[1])
    selected_point = sys.argv[2]
    operation = sys.argv[3]

    def hard_crash(point: str) -> None:
        if point == selected_point:
            os._exit(CRASH_EXIT_CODE)

    spike = ReferenceSpike(db_path, start_time=T0, fault_hook=hard_crash)
    if operation == "record":
        spike.record(
            SCOPE,
            "장애 직전 값은 v2다",
            [{"subject": "장애 복구 값", "relation": "describes", "object_value": "v2"}],
            provenance="user_stated",
            at=T0 + 60,
        )
    elif operation == "correct":
        claim_id = spike.conn.execute(
            "SELECT id FROM claims WHERE scope_key=? AND state='active' "
            "AND relation='describes' ORDER BY id LIMIT 1",
            (SCOPE,),
        ).fetchone()[0]
        spike.correct_claim(
            SCOPE,
            claim_id,
            "장애 직전 교정 값은 v2다",
            {"subject": "장애 복구 값", "relation": "describes", "object_value": "v2"},
            provenance="user_stated",
            at=T0 + 60,
        )
    else:
        raise SystemExit(f"unknown operation: {operation}")
    spike.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
