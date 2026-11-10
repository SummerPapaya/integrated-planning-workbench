#!/usr/bin/env python3
"""Reject publication to a repository other than this workbench's repository."""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = 'SummerPapaya/integrated-planning-workbench'
ALLOWED = re.compile(r'^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)' + re.escape(EXPECTED) + r'(?:\.git)?/?$', re.I)

def main():
    if len(sys.argv) > 1:
        urls = sys.argv[1:]
    else:
        result = subprocess.run(['git', 'remote', 'get-url', '--push', '--all', 'origin'], cwd=ROOT, capture_output=True, text=True)
        if result.returncode:
            print('BLOCKED: origin push target is unavailable.')
            return 1
        urls = result.stdout.splitlines()
    if not urls or any(not ALLOWED.fullmatch(url) for url in urls):
        print(f'BLOCKED: only {EXPECTED} is an authorized publication target. URL values are hidden.')
        return 1
    print(f'PASS: publication target is {EXPECTED}.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
