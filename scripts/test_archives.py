#!/usr/bin/env python3
"""Run the recovered historical suites with synthetic data and mocked adapters."""

from pathlib import Path
import os
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
SUITES = ("decision-core", "observer-0.1.0")
PRIVATE_ENV_NAMES = (
    "SEQUENCE_API_KEY",
    "SEQUENCE_WEBHOOK_SECRET",
    "DATABASE_URL",
    "BLOB_READ_WRITE_TOKEN",
    "CRON_SECRET",
)


def main() -> int:
    env = os.environ.copy()
    for name in PRIVATE_ENV_NAMES:
        env.pop(name, None)
    env.update(APP_MODE="observe", LIVE_TRANSFERS_ENABLED="false")
    failed = False
    for suite in SUITES:
        result = subprocess.run(
            [sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests"],
            cwd=ROOT / "archive" / suite,
            env=env,
            check=False,
        )
        failed = failed or result.returncode != 0
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
