#!/usr/bin/env python3
"""Parse Python helpers without writing bytecode into the source tree."""

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
failures = []

for path in sorted((ROOT / "scripts").rglob("*.py")):
    try:
        ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError as error:
        failures.append(f"{path.relative_to(ROOT)}:{error.lineno}:{error.offset}: {error.msg}")

if failures:
    print("Python syntax validation FAILED")
    print("\n".join(f"- {failure}" for failure in failures))
    raise SystemExit(1)

print("Python syntax validation PASSED")
