#!/usr/bin/env bash
# file_brain.sh — a minimal reference "host loop" for the FILE transport.
#
# The FILE transport decouples broca-machina from your brain through two paths
# on disk:
#   IN  (to you):   broca-machina writes each transcript to
#                   <transcriptDir>/<timestamp>.txt
#   OUT (from you): you write the spoken reply into <replyFile>; broca-machina
#                   polls it, speaks it, and deletes it.
#
# This script is a tiny illustration of the OTHER side of that contract: it
# watches transcriptDir, computes a reply (here it just echoes), and writes the
# reply to replyFile ATOMICALLY (temp file + mv) so broca-machina's poller can
# never read a half-written file. Replace the "your brain goes here" block with
# a real call — or drive replyFile from your own long-running process instead.
#
# Usage: file_brain.sh <transcriptDir> <replyFile>
set -uo pipefail

dir="${1:?usage: file_brain.sh <transcriptDir> <replyFile>}"
reply="${2:?usage: file_brain.sh <transcriptDir> <replyFile>}"

mkdir -p "$dir" "$(dirname "$reply")"
echo "watching $dir  ->  writing replies to $reply   (Ctrl-C to stop)"

while true; do
  # Oldest transcript first (timestamped filenames sort chronologically).
  for f in "$dir"/*.txt; do
    [ -e "$f" ] || continue          # no matches -> the glob is literal; skip
    transcript="$(cat "$f")"
    rm -f "$f"
    [ -n "${transcript//[[:space:]]/}" ] || continue   # ignore empty transcripts

    # ---- your brain goes here; this demo just echoes ----
    answer="You said: $transcript"
    # -----------------------------------------------------

    # Atomic write: build in a temp file, then rename into place. broca-machina
    # only ever sees a complete replyFile.
    tmp="$(mktemp "${reply}.XXXXXX")"
    printf '%s' "$answer" > "$tmp"
    mv -f "$tmp" "$reply"
  done
  sleep 0.3
done
