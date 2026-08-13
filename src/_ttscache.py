"""Bounded LRU for synthesized WAV bytes, keyed by (text, speed).

The warm TTS server's voice is fixed for its lifetime, so the voice is not in
the key. Bounds are hard: entry count AND total bytes, plus a per-item cap so
one long reply can never dominate the cache — repeated SHORT strings (route
announcements, canned acks, "Done.") are the whole point.
"""
from collections import OrderedDict


class WavCache:
    def __init__(self, max_entries=64, max_total_bytes=10 * 1024 * 1024,
                 max_item_bytes=1536 * 1024):
        self.max_entries = max_entries
        self.max_total = max_total_bytes
        self.max_item = max_item_bytes
        self._d = OrderedDict()
        self._total = 0
        self.hits = 0
        self.misses = 0

    def get(self, key):
        wav = self._d.get(key)
        if wav is None:
            self.misses += 1
            return None
        self._d.move_to_end(key)
        self.hits += 1
        return wav

    def put(self, key, wav):
        if len(wav) > self.max_item or key in self._d:
            return
        self._d[key] = wav
        self._total += len(wav)
        while len(self._d) > self.max_entries or self._total > self.max_total:
            _, old = self._d.popitem(last=False)
            self._total -= len(old)
