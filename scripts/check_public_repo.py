#!/usr/bin/env python3
"""Fail a public-repository preflight on likely private data.

Run before staging and again before pushing:
    python3 scripts/check_public_repo.py

Checks tracked files, publishable untracked files, archive members, Git history,
commit email metadata, and remote URLs. Findings never print the matched value.
This is a pattern-based gate, so a human should still review the staged diff.
"""

from __future__ import annotations

import io
import re
import subprocess
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOCAL_ACCOUNT = Path.home().name.encode("utf-8")
PATTERNS = {
    "local user path": re.compile(rb"(?i)(?:file://)?/(?:Users|home)/[A-Za-z0-9._-]+"),
    "local temp path": re.compile(rb"(?i)(?:file://)?/(?:private/)?var/folders/[A-Za-z0-9._/-]+"),
    "Windows user path": re.compile(rb"(?i)[A-Z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+"),
    "email address": re.compile(rb"(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"),
    "AWS access key": re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "GitHub token": re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
    "OpenAI API key": re.compile(rb"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b"),
    "Anthropic API key": re.compile(rb"\bsk-ant-[A-Za-z0-9_-]{20,}\b"),
    "Google API key": re.compile(rb"\bAIza[0-9A-Za-z_-]{35}\b"),
    "Slack token": re.compile(rb"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    "Stripe secret": re.compile(rb"\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b"),
    "private key block": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "literal bearer token": re.compile(rb"(?i)authorization\s*[:=]\s*[\x27\x22]?bearer\s+[A-Za-z0-9._~+/-]{16,}"),
    "credential in URL": re.compile(rb"(?i)https?://[^\s/@:]+:[^\s/@]+@[^\s/]+"),
    "credential assignment": re.compile(
        rb"(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)"
        rb"\s*[:=]\s*[\x27\x22]?([A-Za-z0-9._/-]{12,})"
    ),
}
if LOCAL_ACCOUNT and LOCAL_ACCOUNT not in (b"root", b"runner"):
    PATTERNS["local account name"] = re.compile(
        rb"(?i)(?<![A-Za-z0-9])" + re.escape(LOCAL_ACCOUNT) + rb"(?![A-Za-z0-9])"
    )
PRIVATE_FILENAMES = re.compile(
    r"(?i)(?:^|/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|"
    r"(?:credentials|secrets|service-account)[^/]*|(?:chat|conversation)[-_]export[^/]*|"
    r"[^/]*chat[-_]transcript[^/]*)$|\.(?:pem|key|p12|pfx|jks|sqlite3?|db)$"
)
ROLE_USER = re.compile(rb"(?i)[\x27\x22]role[\x27\x22]\s*:\s*[\x27\x22]user[\x27\x22]")
ROLE_ASSISTANT = re.compile(rb"(?i)[\x27\x22]role[\x27\x22]\s*:\s*[\x27\x22]assistant[\x27\x22]")
PLACEHOLDERS = (b"example", b"placeholder", b"your_", b"process.env", b"os.getenv")


def git(*args: str) -> bytes:
    return subprocess.run(("git", *args), cwd=ROOT, capture_output=True, check=True).stdout


def line_at(data: bytes, offset: int) -> int:
    return data.count(b"\n", 0, offset) + 1


def scan(data: bytes, path: str, origin: str, findings: set[tuple[str, str, int, str]]) -> None:
    for label, pattern in PATTERNS.items():
        for match in pattern.finditer(data):
            if label == "credential assignment" and any(p in match.group(0).lower() for p in PLACEHOLDERS):
                continue
            findings.add((origin, path, line_at(data, match.start()), label))
    if ROLE_USER.search(data) and ROLE_ASSISTANT.search(data):
        findings.add((origin, path, 0, "possible chat transcript"))


def scan_file(data: bytes, path: str, origin: str, findings: set[tuple[str, str, int, str]], depth: int = 0) -> None:
    if PRIVATE_FILENAMES.search(path) and not path.endswith((".env.example", ".env.sample")):
        findings.add((origin, path, 0, "private filename"))
    scan(data, path, origin, findings)
    if depth < 3 and zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for member in archive.infolist():
                if member.is_dir():
                    continue
                if member.file_size > 100_000_000:
                    findings.add((origin, f"{path}::{member.filename}", 0, "archive member too large to scan"))
                    continue
                scan_file(archive.read(member), f"{path}::{member.filename}", "archive", findings, depth + 1)


def main() -> int:
    findings: set[tuple[str, str, int, str]] = set()
    paths = [p.decode("utf-8", "replace") for p in git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split(b"\0") if p]
    for path in paths:
        file = ROOT / path
        if file.is_file():
            scan_file(file.read_bytes(), path, "working tree", findings)

    history_objects = 0
    for item in git("rev-list", "--objects", "--all").splitlines():
        object_id, _, raw_path = item.partition(b" ")
        if not raw_path or git("cat-file", "-t", object_id.decode()) != b"blob\n":
            continue
        history_objects += 1
        path = raw_path.decode("utf-8", "replace")
        scan_file(git("cat-file", "blob", object_id.decode()), path, "Git history", findings)

    commits = git("rev-list", "--all").splitlines()
    if commits:
        for field, label in (("%ae", "author"), ("%ce", "committer")):
            for line in git("log", "--all", f"--format={field}").splitlines():
                address = line.decode("utf-8", "replace").lower()
                if address and not address.endswith("@users.noreply.github.com"):
                    findings.add(("Git metadata", f"commit {label} email", 0, "personal email address"))
        if LOCAL_ACCOUNT and LOCAL_ACCOUNT not in (b"root", b"runner"):
            for field, label in (("%an", "author"), ("%cn", "committer")):
                for name in git("log", "--all", f"--format={field}").splitlines():
                    if PATTERNS["local account name"].search(name):
                        findings.add(("Git metadata", f"commit {label} name", 0, "local account name"))
    for commit in commits:
        data = git("cat-file", "commit", commit.decode())
        _, _, message = data.partition(b"\n\n")
        scan(message, f"commit {commit.decode()[:10]} message", "Git metadata", findings)
    for line in git("remote", "-v").splitlines():
        if PATTERNS["credential in URL"].search(line):
            findings.add(("Git metadata", "remote URL", 0, "credential in URL"))

    print(f"Scanned {len(paths)} publishable files and {history_objects} historical blobs.")
    if findings:
        print(f"BLOCKED: {len(findings)} possible disclosure(s). Matched values are never printed.")
        for origin, path, line, label in sorted(findings)[:40]:
            location = f"{path}:{line}" if line else path
            print(f"  {origin}: {location} — {label}")
        if len(findings) > 40:
            print(f"  ...and {len(findings) - 40} more")
        return 1
    print("PASS: no listed private paths, personal emails, chat transcripts, or credential patterns found.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as error:
        print(f"Audit could not complete: Git command failed ({error.returncode}).", file=sys.stderr)
        sys.exit(2)
