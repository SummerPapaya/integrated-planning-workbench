#!/usr/bin/env python3
"""Package the Integrated Planning Workbench CSV templates."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
directory = root / "docs/templates"
output = directory.parent / "templates.zip"
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for name in ("README.txt", "sales.csv", "inventory.csv", "products.csv", "inbound.csv",
                 "promotions.csv", "actuals.csv", "executions.csv"):
        archive.write(directory / name, name)
print(f"Wrote {output} ({output.stat().st_size:,} bytes)")
