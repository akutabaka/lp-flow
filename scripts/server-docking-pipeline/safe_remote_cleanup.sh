#!/usr/bin/env bash
set -euo pipefail

run_dir="${1:-}"
allowed_root="${2:-}"

if [[ -z "$run_dir" ]]; then
  echo "Refusing cleanup: run_dir is empty" >&2
  exit 2
fi

if [[ -z "$allowed_root" ]]; then
  echo "Refusing cleanup: allowed_root is empty" >&2
  exit 3
fi

if [[ "$run_dir" != /* || "$allowed_root" != /* ]]; then
  echo "Refusing cleanup: run_dir and allowed_root must be absolute paths" >&2
  exit 4
fi

case "/$run_dir/" in
  *"/../"*|*"/./"*)
    echo "Refusing cleanup: run_dir must not contain . or .. path segments: $run_dir" >&2
    exit 5
    ;;
esac

case "/$allowed_root/" in
  *"/../"*|*"/./"*)
    echo "Refusing cleanup: allowed_root must not contain . or .. path segments: $allowed_root" >&2
    exit 6
    ;;
esac

if ! command -v realpath >/dev/null 2>&1; then
  echo "Refusing cleanup: realpath is required for canonical path checks" >&2
  exit 7
fi

run_canon="$(realpath -m -- "$run_dir")"
allowed_canon="$(realpath -m -- "$allowed_root")"

if [[ "$allowed_canon" == "/" ]]; then
  echo "Refusing cleanup: allowed_root resolves to filesystem root" >&2
  exit 8
fi

if [[ "$run_canon" != "$allowed_canon"/* ]]; then
  echo "Refusing cleanup: canonical run_dir is outside allowed root: $run_canon not under $allowed_canon" >&2
  exit 9
fi

if [[ "$run_canon" == "$allowed_canon" ]]; then
  echo "Refusing cleanup: run_dir resolves to allowed root itself: $run_canon" >&2
  exit 10
fi

if [[ ! -d "$run_canon" ]]; then
  echo "Refusing cleanup: run_dir does not exist: $run_dir" >&2
  exit 11
fi

rm -rf -- "$run_canon"
echo "Removed safe remote run folder: $run_canon"
