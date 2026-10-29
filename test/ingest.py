#!/usr/bin/env python3
"""Decode base62-grouped gzip JSON (from the browser tab) and merge into fixtures.json.
usage: ingest.py <blen> <file-with-chunks>"""
import gzip, json, sys, os
A = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
blen = int(sys.argv[1])
groups = open(sys.argv[2]).read().split()
out = bytearray()
for g in groups:
    v = 0
    for ch in g:
        v = v * 62 + A.index(ch)
    out += v.to_bytes(4, 'big')
data = json.loads(gzip.decompress(bytes(out[:blen])))
fx_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures.json')
fx = json.load(open(fx_path)) if os.path.exists(fx_path) else {}
fx.update(data)
json.dump(fx, open(fx_path, 'w'))
print('merged', len(data), 'total', len(fx), 'nulls', [k for k, v in data.items() if v is None])
