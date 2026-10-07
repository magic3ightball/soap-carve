# 회귀 검사 비교: python3 compare.py <기준> <새것>
# 장면마다 평균 차이(0~255), 크게 바뀐 픽셀 비율(차이 > 24)을 찍고, out/cmp_<기준>_<새것>/<장면>.png 에 [기준 | 새것 | 차이×4]를 저장
import sys, os
import numpy as np
from PIL import Image
base, new = sys.argv[1], sys.argv[2]
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
dst = os.path.join(root, f'cmp_{base}_{new}'); os.makedirs(dst, exist_ok=True)
for fn in sorted(os.listdir(os.path.join(root, base))):
    pb, pn = os.path.join(root, base, fn), os.path.join(root, new, fn)
    if not os.path.exists(pn): print(f'{fn:22s} 없음'); continue
    a = np.asarray(Image.open(pb).convert('RGB')).astype(np.int16)
    b = np.asarray(Image.open(pn).convert('RGB')).astype(np.int16)
    if a.shape != b.shape: print(f'{fn:22s} 크기 다름 {a.shape} {b.shape}'); continue
    d = np.abs(a - b).max(axis=2)
    print(f'{fn:22s} 평균차 {d.mean():5.2f}  크게 바뀐 픽셀 {100 * (d > 24).mean():5.1f}%')
    diff = np.clip(d * 4, 0, 255).astype(np.uint8)
    strip = np.concatenate([a.astype(np.uint8), b.astype(np.uint8), np.stack([diff] * 3, axis=2)], axis=1)
    Image.fromarray(strip).save(os.path.join(dst, fn))
