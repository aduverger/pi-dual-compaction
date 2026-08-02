#!/usr/bin/env python3
"""Reject local identity and workstation data from public Git repositories."""

from __future__ import annotations

import argparse
import getpass
import ipaddress
import os
import re
import socket
import subprocess
import sys
from pathlib import Path

PUBLIC_NAME = "deephbz"
PUBLIC_EMAIL = "13776377+deephbz@users.noreply.github.com"
MAX_FINDINGS = 100


def git(*args: str, input_data: bytes | None = None, check: bool = True) -> bytes:
    result = subprocess.run(
        ["git", *args], input=input_data, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=False,
    )
    if check and result.returncode:
        message = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(message or f"git {' '.join(args)} failed")
    return result.stdout


def git_ok(*args: str) -> bool:
    return subprocess.run(
        ["git", *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
    ).returncode == 0


def config_all(key: str) -> list[str]:
    raw = git("config", "--get-all", key, check=False)
    return [line for line in raw.decode("utf-8", "replace").splitlines() if line]


def enabled() -> bool:
    value = git("config", "--bool", "privacy.public", check=False).strip().lower()
    return value == b"true"


def add(findings: list[tuple[str, str]], rule: str, where: str) -> None:
    if len(findings) < MAX_FINDINGS:
        findings.append((rule, where))


def patterns() -> list[tuple[str, re.Pattern[bytes]]]:
    result = [
        ("home_path", re.compile(rb"(?i)(?:file://)?/(?:Users|home)/[A-Za-z0-9._-]+(?:/|\b)")),
        ("windows_home_path", re.compile(rb"(?i)\b[A-Z]:\\Users\\[^\\\s]+\\")),
        ("mac_address", re.compile(rb"(?i)(?<![0-9a-f])(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}(?![0-9a-f])")),
        ("private_key", re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
        ("npm_token", re.compile(rb"(?<![A-Za-z0-9])npm_[A-Za-z0-9]{20,}")),
        ("github_token", re.compile(rb"(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})")),
        ("aws_access_key", re.compile(rb"(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])")),
    ]
    user = getpass.getuser().encode()
    if len(user) >= 3:
        result.append(("local_account", re.compile(rb"(?i)(?<![A-Za-z0-9_])" + re.escape(user) + rb"(?![A-Za-z0-9_])")))
    host = socket.gethostname().encode()
    short_host = host.split(b".", 1)[0]
    for label, value in (("hostname", host), ("hostname", short_host)):
        if len(value) >= 4:
            result.append((label, re.compile(re.escape(value), re.IGNORECASE)))
    for literal in config_all("privacy.forbiddenLiteral"):
        result.append(("forbidden_literal", re.compile(re.escape(literal.encode()), re.IGNORECASE)))
    return result


EMAIL = re.compile(rb"(?i)(?<![A-Z0-9._%+-])([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})(?![A-Z0-9.-])")
IPV4 = re.compile(rb"(?<![0-9])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9])")


def scan_bytes(data: bytes, where: str, findings: list[tuple[str, str]], compiled: list[tuple[str, re.Pattern[bytes]]]) -> None:
    for rule, pattern in compiled:
        if pattern.search(data):
            add(findings, rule, where)

    allowed_emails = {PUBLIC_EMAIL.lower(), *[x.lower() for x in config_all("privacy.allowEmail")]}
    for match in EMAIL.finditer(data):
        value = match.group(1).decode("ascii", "ignore").lower()
        domain = value.rsplit("@", 1)[-1]
        if value in allowed_emails or domain in {"example.invalid", "example.com", "example.org", "example.net"}:
            continue
        add(findings, "email", where)
        break

    for match in IPV4.finditer(data):
        try:
            address = ipaddress.ip_address(match.group(0).decode())
        except ValueError:
            continue
        if address.is_loopback or address.is_unspecified or address in ipaddress.ip_network("192.0.2.0/24"):
            continue
        if address in ipaddress.ip_network("198.51.100.0/24") or address in ipaddress.ip_network("203.0.113.0/24"):
            continue
        if address.is_private or address.is_link_local:
            add(findings, "private_network_address", where)
            break


def check_identity(findings: list[tuple[str, str]]) -> None:
    name = git("config", "--get", "user.name", check=False).decode("utf-8", "replace").strip()
    email = git("config", "--get", "user.email", check=False).decode("utf-8", "replace").strip()
    if name != PUBLIC_NAME:
        add(findings, "configured_user_name", "git config")
    if email != PUBLIC_EMAIL:
        add(findings, "configured_user_email", "git config")


def index_blobs(only_paths: set[str] | None = None) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    for record in git("ls-files", "-s", "-z").split(b"\0"):
        if not record:
            continue
        metadata, path = record.split(b"\t", 1)
        mode, oid, stage = metadata.split()
        decoded = path.decode("utf-8", "replace")
        if stage == b"0" and mode != b"160000" and (only_paths is None or decoded in only_paths):
            result.append((oid.decode(), decoded))
    return result


def staged_blobs() -> list[tuple[str, str]]:
    changed = {
        path.decode("utf-8", "replace")
        for path in git("diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR", check=False).split(b"\0")
        if path
    }
    return index_blobs(changed)


def history_args(ref: str) -> tuple[list[str], str]:
    if ref == "--all":
        return ["--all"], "all refs"
    resolved = git("rev-parse", "--verify", f"{ref}^{{commit}}").decode().strip()
    return [resolved], resolved


def history_blobs(ref_args: list[str]) -> list[tuple[str, str]]:
    objects = git("rev-list", "--objects", *ref_args, check=False).splitlines()
    if not objects:
        return []
    paths: dict[str, str] = {}
    ids: list[str] = []
    for line in objects:
        oid, _, path = line.partition(b" ")
        key = oid.decode()
        ids.append(key)
        paths.setdefault(key, path.decode("utf-8", "replace") or "<unknown>")
    checked = git("cat-file", "--batch-check=%(objectname) %(objecttype)", input_data=("\n".join(ids) + "\n").encode())
    blob_ids = {line.split()[0].decode() for line in checked.splitlines() if line.endswith(b" blob")}
    return [(oid, paths[oid]) for oid in ids if oid in blob_ids]


def range_blobs(base: str, tip: str) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    seen: set[str] = set()
    commits = git("rev-list", "--reverse", f"{base}..{tip}").decode().splitlines()
    for commit in commits:
        paths = git("diff-tree", "--root", "--no-commit-id", "--name-only", "-z", "-r", commit).split(b"\0")
        for raw_path in paths:
            if not raw_path:
                continue
            path = raw_path.decode("utf-8", "replace")
            entry = git("ls-tree", "-z", commit, "--", path).split(b"\0", 1)[0]
            if not entry:
                continue
            metadata, _, listed_path = entry.partition(b"\t")
            mode, kind, oid = metadata.split()
            key = oid.decode()
            if kind == b"blob" and key not in seen:
                seen.add(key)
                result.append((key, listed_path.decode("utf-8", "replace")))
    return result


def scan_blobs(blobs: list[tuple[str, str]], findings: list[tuple[str, str]]) -> None:
    compiled = patterns()
    seen: set[str] = set()
    for oid, path in blobs:
        if oid in seen:
            continue
        seen.add(oid)
        data = git("cat-file", "blob", oid)
        scan_bytes(data, f"{path} ({oid[:12]})", findings, compiled)
        if len(findings) >= MAX_FINDINGS:
            return


def check_history_identity(ref_args: list[str], findings: list[tuple[str, str]]) -> None:
    format_string = "%H%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00"
    raw = git("log", *ref_args, f"--format={format_string}", check=False)
    fields = raw.replace(b"\0\n", b"\0").split(b"\0")
    while fields and not fields[-1]:
        fields.pop()
    for offset in range(0, len(fields), 7):
        record = fields[offset:offset + 7]
        if len(record) != 7:
            add(findings, "commit_metadata_parse", "git history")
            return
        oid, author_name, author_email, author_date, committer_name, committer_email, committer_date = record
        where = f"commit {oid.decode()[:12]}"
        if author_name.decode("utf-8", "replace") != PUBLIC_NAME:
            add(findings, "author_name", where)
        if author_email.decode("utf-8", "replace") != PUBLIC_EMAIL:
            add(findings, "author_email", where)
        if committer_name.decode("utf-8", "replace") != PUBLIC_NAME:
            add(findings, "committer_name", where)
        if committer_email.decode("utf-8", "replace") != PUBLIC_EMAIL:
            add(findings, "committer_email", where)
        if not author_date.endswith((b"+00:00", b"Z")):
            add(findings, "author_timezone", where)
        if not committer_date.endswith((b"+00:00", b"Z")):
            add(findings, "committer_timezone", where)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--if-enabled", action="store_true")
    parser.add_argument("--ref", default="--all", help="history cutoff or range tip; default scans all refs")
    parser.add_argument("--base", help="grandfathered history baseline for range mode")
    parser.add_argument("mode", choices=("index", "staged", "history", "range"))
    args = parser.parse_args()

    try:
        git("rev-parse", "--git-dir")
        if args.if_enabled and not enabled():
            return 0
        findings: list[tuple[str, str]] = []
        check_identity(findings)
        history_label = ""
        if args.mode == "index":
            scan_blobs(index_blobs(), findings)
        elif args.mode == "staged":
            scan_blobs(staged_blobs(), findings)
        elif args.mode == "history":
            ref_args, history_label = history_args(args.ref)
            check_history_identity(ref_args, findings)
            scan_blobs(history_blobs(ref_args), findings)
        else:
            if args.ref == "--all":
                raise RuntimeError("range mode requires --ref <tip>")
            tip = git("rev-parse", "--verify", f"{args.ref}^{{commit}}").decode().strip()
            base_value = args.base or (config_all("privacy.baseline")[-1] if config_all("privacy.baseline") else "")
            if base_value:
                base = git("rev-parse", "--verify", f"{base_value}^{{commit}}").decode().strip()
            else:
                base = ""
            if base and git_ok("merge-base", "--is-ancestor", base, tip):
                ref_args = [f"{base}..{tip}"]
                history_label = f"{base}..{tip}"
                check_history_identity(ref_args, findings)
                scan_blobs(range_blobs(base, tip), findings)
            else:
                history_label = tip
                check_history_identity([tip], findings)
                scan_blobs(history_blobs([tip]), findings)
    except RuntimeError as error:
        print(f"privacy-gate: error: {error}", file=sys.stderr)
        return 2

    for rule, where in findings:
        print(f"privacy-gate: {rule}: {where}", file=sys.stderr)
    if findings:
        if len(findings) >= MAX_FINDINGS:
            print(f"privacy-gate: stopped after {MAX_FINDINGS} findings", file=sys.stderr)
        print("privacy-gate: rejected; no detected value was printed", file=sys.stderr)
        return 1
    suffix = f" ref={history_label}" if args.mode in {"history", "range"} else ""
    print(f"privacy-gate: {args.mode} passed{suffix}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
