#!/usr/bin/env python3
"""sounds/ 폴더의 녹음 파일 이름으로 sounds/manifest.json을 만든다.

파일 이름 = <종류>_<아무거나>.<m4a|mp3|wav|ogg>  (예: cut_thin_01.m4a, scrape_long.m4a)
종류는 src/samples.js의 SAMPLE_KINDS. 모르는 종류로 시작하는 파일은 알려 주고 건너뛴다.
실행: python3 tools/sound_manifest.py   (soap-carve 폴더에서)
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SND = ROOT / 'sounds'
EXTS = {'.m4a', '.mp3', '.wav', '.ogg'}

# 종류 목록은 samples.js에서 읽는다 (두 곳에 따로 적지 않게)
src = (ROOT / 'src' / 'samples.js').read_text(encoding='utf-8')
block = src.split('export const SAMPLE_KINDS = {', 1)[1].split('};', 1)[0]
KINDS = sorted(re.findall(r'^\s*(\w+):', block, re.M), key=len, reverse=True)   # 긴 이름 먼저 (sand_loop가 sand보다 먼저)

man, skipped = {}, []
for f in sorted(SND.iterdir()):
    if f.suffix.lower() not in EXTS:
        continue
    kind = next((k for k in KINDS if f.stem == k or f.stem.startswith(k + '_')), None)
    if kind is None:
        skipped.append(f.name)
        continue
    man.setdefault(kind, []).append(f.name)

(SND / 'manifest.json').write_text(json.dumps(man, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
for k in sorted(KINDS):
    print(f'{k:10s} {len(man.get(k, [])):3d}개' + ('' if k in man else '  (없음 → 합성음)'))
if skipped:
    print('종류를 모르는 파일 (건너뜀):', ', '.join(skipped))
