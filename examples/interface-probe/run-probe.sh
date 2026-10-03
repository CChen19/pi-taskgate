#!/usr/bin/env bash
# run-probe.sh — compile-only C++ interface-contract probe (host-owned).
#
# Compiles probe-valid-expire-at.cpp (host-owned, next to this script) against
# a candidate tree and reports whether the caller-owned interface contract
# holds. Never executes candidate code and never writes inside the candidate
# tree: compiler output goes to a private temporary directory (honoring
# TMPDIR) that is removed on success and on failure.
#
# Usage: run-probe.sh [--compiler CMD] [--std STD] [--] [ROOT]
#   ROOT       candidate tree root; must contain handler/expire_at.h, the one
#              header the probe includes. Default: the current directory, i.e.
#              the clean-room checkout when run by verification. Use "--"
#              before ROOT when it starts with "-".
#   --compiler compiler command (default: c++ — any compiler with GCC-style
#              -std/-I/-c/-o flags, e.g. g++ or clang++)
#   --std      -std flag value (default: c++14)
#
# Exit codes: 0 contract satisfied; 1 contract violated; 2 usage error;
# 3 probe/header not found; 4 compiler not found; 5 could not create temp dir.
set -u

PROG_NAME="interface-probe"
PROBE_HEADER=handler/expire_at.h
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROBE_CPP="$SCRIPT_DIR/probe-valid-expire-at.cpp"

compiler=c++
std=c++14
root=.

usage() {
  cat >&2 <<EOF
usage: run-probe.sh [--compiler CMD] [--std STD] [--] [ROOT]
  ROOT is the candidate tree holding $PROBE_HEADER (default: current directory).
exit codes: 0 pass, 1 contract violated, 2 usage, 3 probe/header missing, 4 compiler missing, 5 temp dir
EOF
}

die() { # die EXIT_CODE MESSAGE
  local code=$1; shift
  echo "$PROG_NAME: $*" >&2
  exit "$code"
}

while [ $# -gt 0 ]; do
  case $1 in
    --compiler)
      [ $# -ge 2 ] || die 2 "--compiler requires a value"; compiler=$2; shift 2 ;;
    --std)
      [ $# -ge 2 ] || die 2 "--std requires a value"; std=$2; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    --)
      shift
      if [ $# -gt 0 ]; then root=$1; shift; fi
      break ;;
    -*)
      die 2 "unknown option: $1 (see --help)" ;;
    *)
      root=$1; shift ;;
  esac
done
[ $# -eq 0 ] || die 2 "unexpected extra arguments: $* (only one ROOT is accepted)"

[ -f "$PROBE_CPP" ] || die 3 "probe source not found next to this script: $PROBE_CPP"
[ -d "$root" ] || die 3 "candidate root is not a directory: $root"
[ -f "$root/$PROBE_HEADER" ] || die 3 "candidate header not found: $root/$PROBE_HEADER"
command -v -- "$compiler" >/dev/null 2>&1 \
  || die 4 "compiler not found: '$compiler' (install it or pass --compiler CMD)"

tmpdir_probe=$(mktemp -d "${TMPDIR:-/tmp}/${PROG_NAME}.XXXXXX") \
  || die 5 "could not create a temporary directory (TMPDIR=${TMPDIR:-unset})"
cleanup() { rm -rf -- "$tmpdir_probe"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# LC_ALL=C keeps diagnostics untranslated so they do not vary with the host
# locale. No output rewriting: compiler diagnostics are printed verbatim and
# stay meaningful for any compiler, whatever characters TMPDIR contains.
if LC_ALL=C "$compiler" -std="$std" -I"$root" -c "$PROBE_CPP" -o "$tmpdir_probe/probe.o" \
    2>"$tmpdir_probe/compiler.err"; then
  echo "$PROG_NAME: PASS: global bool valid_expire_at(const std::string&) usable from $root/$PROBE_HEADER"
  exit 0
fi

cat "$tmpdir_probe/compiler.err" >&2
echo "$PROG_NAME: FAIL: contract not satisfied at $root/$PROBE_HEADER; the compiler diagnostics above are the evidence" >&2
exit 1
