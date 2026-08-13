#!/usr/bin/env python3
"""WavCache unit selftest — pure logic, no piper model load."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from _ttscache import WavCache  # noqa: E402

PASS = FAIL = 0
def ok(cond, name):
    global PASS, FAIL
    if cond: PASS += 1; print("  ok:", name)
    else: FAIL += 1; print("  FAIL:", name)

c = WavCache(max_entries=3, max_total_bytes=100, max_item_bytes=40)

ok(c.get(("hi", 1.0)) is None, "miss on empty cache")
c.put(("hi", 1.0), b"a" * 10)
ok(c.get(("hi", 1.0)) == b"a" * 10, "hit returns stored bytes")
ok(c.hits == 1 and c.misses == 1, "hit/miss counters")
ok(c.get(("hi", 1.2)) is None, "speed is part of the key")

c.put(("big", 1.0), b"x" * 41)
ok(c.get(("big", 1.0)) is None, "oversized item never cached")

c.put(("b", 1.0), b"b" * 10)
c.put(("c", 1.0), b"c" * 10)          # order now: hi, b, c
c.get(("hi", 1.0))                    # refresh hi -> b becomes LRU
c.put(("d", 1.0), b"d" * 10)          # 4th entry -> evicts LRU (b)
ok(len(c._d) == 3, "entry cap enforced")
ok(c.get(("hi", 1.0)) is not None, "recently-used survives eviction")
ok(c.get(("b", 1.0)) is None, "least-recently-used evicted")

c2 = WavCache(max_entries=100, max_total_bytes=25, max_item_bytes=20)
c2.put(("p", 1.0), b"p" * 15)
c2.put(("q", 1.0), b"q" * 15)          # 30 bytes total -> evict p
ok(c2.get(("p", 1.0)) is None and c2.get(("q", 1.0)) is not None, "byte cap enforced")

print(f"PASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
