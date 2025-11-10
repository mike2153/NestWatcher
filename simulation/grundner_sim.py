"""Compatibility wrapper that routes to the unified simulator Grundner command."""
from __future__ import annotations

import sys
from pathlib import Path

if __name__ == "__main__":
    current_dir = Path(__file__).resolve().parent
    if str(current_dir) not in sys.path:
        sys.path.insert(0, str(current_dir))
    import simulator  # noqa: WPS433

    args = ["grundner", *sys.argv[1:]]
    raise SystemExit(simulator.run_cli(args))
