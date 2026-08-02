#!/usr/bin/env python3
"""Apply the bounded blackmagic-review-doc-privacy/1 source transform."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

TRANSFORM_ID = "blackmagic-review-doc-privacy/1"
SOURCE_COMMIT = "9b77aca15a67638287b95558b9b6927818ee9092"
SOURCE_TREE = "382232fa3ec7e575180ade48a3edf874c6f3880d"
SANITIZED_TREE = "29f3bae40c3b4af1b1f7ac98e2b98799d1425248"
SCANNER_SHA256 = "7808ae1f0a5039bd939236d17db9574f2249043a8596ca85f8f6c1270d9a2381"
HOME_RE = re.compile(rb"(?i)(?:file://)?/(?:Users|home)/([A-Za-z0-9._-]+)(?=/|\b)")

TARGETS = {
    "docs/reviews/million-eyes-7ba0de2b.md": {
        "mode": "100644",
        "before_blob": "8ef124b79d7c116165ef53407b44cb31003661d4",
        "after_blob": "fbf7c6638fb0699a42bdfa0dfc453a41d8041fe6",
        "home_root_matches": 3,
        "source_account_matches": 3,
        "remaining_account_matches": 0,
    },
    "docs/reviews/six-iteration-review.md": {
        "mode": "100644",
        "before_blob": "6ad1499565aa101a5f92dcfef2ed88f65b2feb95",
        "after_blob": "8a18e1cd0bc8029634e18089354e59b9dee8689f",
        "home_root_matches": 6,
        "source_account_matches": 6,
        "remaining_account_matches": 0,
    },
}


class TransformError(Exception):
    """A value-safe transform rejection."""


def run(repo: Path, *args: str, input_data: bytes | None = None) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        input=input_data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        raise TransformError("Git precondition or verification failed")
    return result.stdout


def tree_entries(repo: Path, ref: str) -> dict[str, tuple[str, str, str]]:
    entries: dict[str, tuple[str, str, str]] = {}
    for record in run(repo, "ls-tree", "-rz", "--full-tree", ref).split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, kind, oid = metadata.decode("ascii").split()
        path = raw_path.decode("utf-8")
        entries[path] = (mode, kind, oid)
    return entries


def index_entries(repo: Path) -> dict[str, tuple[str, str]]:
    entries: dict[str, tuple[str, str]] = {}
    for record in run(repo, "ls-files", "-s", "-z").split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, oid, stage = metadata.decode("ascii").split()
        if stage != "0":
            raise TransformError("Non-zero index stage rejected")
        entries[raw_path.decode("utf-8")] = (mode, oid)
    return entries


def blob(repo: Path, oid: str) -> bytes:
    return run(repo, "cat-file", "blob", oid)


def newline_sequence(data: bytes) -> list[bytes]:
    return re.findall(rb"\r\n|\r|\n", data)


def sanitize(repository: Path, scanner: Path) -> dict[str, object]:
    if hashlib.sha256(scanner.read_bytes()).hexdigest() != SCANNER_SHA256:
        raise TransformError("Privacy scanner digest mismatch")
    if run(repository, "rev-parse", "--show-toplevel").decode().strip() != str(repository):
        raise TransformError("Repository must be addressed by its top-level path")
    if run(repository, "rev-parse", "HEAD").decode().strip() != SOURCE_COMMIT:
        raise TransformError("Source commit precondition failed")
    if run(repository, "rev-parse", "HEAD^{tree}").decode().strip() != SOURCE_TREE:
        raise TransformError("Source tree precondition failed")
    if run(repository, "status", "--porcelain=v1", "-z"):
        raise TransformError("Source checkout must be clean")
    if run(repository, "write-tree").decode().strip() != SOURCE_TREE:
        raise TransformError("Source index tree precondition failed")

    entries = tree_entries(repository, "HEAD")
    for path, expected in TARGETS.items():
        actual = entries.get(path)
        if actual != (expected["mode"], "blob", expected["before_blob"]):
            raise TransformError(f"Approved input precondition failed for {path}")

    contents: dict[str, bytes] = {}
    accounts: set[bytes] = set()
    home_paths: set[str] = set()
    for path, (_mode, kind, oid) in entries.items():
        if kind != "blob":
            continue
        data = blob(repository, oid)
        contents[path] = data
        matches = list(HOME_RE.finditer(data))
        if matches:
            home_paths.add(path)
            accounts.update(match.group(1).lower() for match in matches)
    if home_paths != set(TARGETS):
        raise TransformError("Home-root finding outside the two approved paths")
    if len(accounts) != 1:
        raise TransformError("Transform requires exactly one derived local account")
    account = next(iter(accounts))
    account_re = re.compile(
        rb"(?i)(?<![A-Za-z0-9_])" + re.escape(account) + rb"(?![A-Za-z0-9_])"
    )

    account_paths = {path for path, data in contents.items() if account_re.search(data)}
    if account_paths != set(TARGETS):
        raise TransformError("Account finding outside the two approved paths")

    results: dict[str, dict[str, object]] = {}
    for path, expected in TARGETS.items():
        data = contents[path]
        try:
            data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise TransformError(f"Approved input is not UTF-8: {path}") from error
        if b"<LOCAL_HOME>" in data or b"<LOCAL_ACCOUNT>" in data:
            raise TransformError(f"Replacement literal already present in {path}")

        source_account_count = len(account_re.findall(data))
        transformed, home_count = HOME_RE.subn(b"<LOCAL_HOME>", data)
        remaining_count = len(account_re.findall(transformed))
        transformed, account_count = account_re.subn(b"<LOCAL_ACCOUNT>", transformed)
        if home_count <= 0 or source_account_count <= 0:
            raise TransformError(f"Zero source match count rejected for {path}")
        observed = (home_count, source_account_count, remaining_count, account_count)
        required = (
            expected["home_root_matches"],
            expected["source_account_matches"],
            expected["remaining_account_matches"],
            expected["remaining_account_matches"],
        )
        if observed != required:
            raise TransformError(f"Exact match-count precondition failed for {path}")
        if HOME_RE.search(transformed) or account_re.search(transformed):
            raise TransformError(f"Residual approved finding in {path}")
        try:
            transformed.decode("utf-8")
        except UnicodeDecodeError as error:
            raise TransformError(f"Transform did not preserve UTF-8 for {path}") from error
        if newline_sequence(data) != newline_sequence(transformed):
            raise TransformError(f"Transform did not preserve newline bytes for {path}")

        output = repository / path
        before_mode = output.stat().st_mode & 0o777
        output.write_bytes(transformed)
        if (output.stat().st_mode & 0o777) != before_mode:
            raise TransformError(f"Transform changed filesystem mode for {path}")
        results[path] = {
            "before_blob": expected["before_blob"],
            "after_blob": expected["after_blob"],
            "match_counts": {
                "home_roots": home_count,
                "source_account_tokens": source_account_count,
                "remaining_account_tokens": account_count,
            },
        }

    run(repository, "add", "--", *TARGETS)
    sanitized = index_entries(repository)
    if set(sanitized) != set(entries):
        raise TransformError("Path add/delete rejected")
    for path, (mode, kind, oid) in entries.items():
        if kind != "blob":
            raise TransformError("Unexpected non-blob leaf rejected")
        after_mode, after_oid = sanitized[path]
        if after_mode != mode:
            raise TransformError("Mode change rejected")
        expected_oid = TARGETS[path]["after_blob"] if path in TARGETS else oid
        if after_oid != expected_oid:
            raise TransformError("Non-target or unexpected target blob rejected")

    sanitized_tree = run(repository, "write-tree").decode().strip()
    if sanitized_tree != SANITIZED_TREE:
        raise TransformError("Sanitized tree digest mismatch")
    scanner_run = subprocess.run(
        [sys.executable, str(scanner), "index"],
        cwd=repository,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if scanner_run.returncode:
        raise TransformError("Sanitized index did not pass the privacy scanner")

    return {
        "transform_id": TRANSFORM_ID,
        "source_commit": SOURCE_COMMIT,
        "source_tree": SOURCE_TREE,
        "sanitized_tree": SANITIZED_TREE,
        "scanner_sha256": SCANNER_SHA256,
        "approved_rule_ids": ["home_path", "local_account"],
        "files": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True, type=Path)
    parser.add_argument("--scanner", required=True, type=Path)
    args = parser.parse_args()
    try:
        repository = args.repository.resolve(strict=True)
        scanner = args.scanner.resolve(strict=True)
        receipt = sanitize(repository, scanner)
    except (OSError, TransformError):
        print("sanitize-review-history: rejected without disclosing detected values", file=sys.stderr)
        return 1
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
