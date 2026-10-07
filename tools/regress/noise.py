# 잔무늬 점수: 비누가 찍힌 픽셀에서 밝기 라플라시안 절댓값 평균 (가는 줄·점무늬·톱니가 많을수록 큼)
# python3 noise.py <이름> [<이름> ...]
import sys, os
import numpy as np
from PIL import Image
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
labels = sys.argv[1:]
scenes = sorted(os.listdir(os.path.join(root, labels[0])))
print(f'{"장면":22s}' + ''.join(f'{l:>10s}' for l in labels))
for fn in scenes:
    row = []
    for l in labels:
        a = np.asarray(Image.open(os.path.join(root, l, fn)).convert('L')).astype(np.float32)
        lap = np.abs(4 * a[1:-1, 1:-1] - a[:-2, 1:-1] - a[2:, 1:-1] - a[1:-1, :-2] - a[1:-1, 2:])
        mask = a[1:-1, 1:-1] > 70                              # 어두운 배경 제외
        row.append(lap[mask].mean())
    print(f'{fn:22s}' + ''.join(f'{v:10.2f}' for v in row))
