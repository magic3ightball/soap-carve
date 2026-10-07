# 고정 장면 회귀 검사

수정 전후로 같은 장면(깎기·물·자르기)을 똑같이 재현해 캡처하고 비교한다. 렌더링을 고칠 때마다 먼저 돌린다.

1. 수신기: `python3 tools/regress/recv.py` (127.0.0.1:8941, 로컬 전용)
2. 개발 서버(launch.json `soap-carve`, 8933)에서 `http://127.0.0.1:8933/?regress=<이름>` 열기 → 제목이 `regress done 6`이 될 때까지 대기
3. 비교: `python3 tools/regress/compare.py <기준> <새것>` → 수치 + `out/cmp_<기준>_<새것>/*.png`([기준 | 새것 | 차이×4])

장면은 `scenes.js`의 `SCENES`. 같은 기계·같은 창이면 결과가 픽셀 단위로 같아야 한다(난수 고정, 해상도 960×640 CSS 고정).
`out/`은 배포에서 빠진다(`.vercelignore`의 `tools`).

## 현재 기준
- `out/reference/`: 지금 기준 장면 (굴절 1.2 + 뿌연 정도 연속값 C, 2026-10-07). 렌더링을 고친 뒤 `?regress=<새이름>`으로 찍고 `compare.py reference <새이름>`.
- `out/ior145_before/`: 굴절 1.45 시절, `out/ior120_beforeC/`: C 이전 (비교용). `out/pair_*.png`: 1.45 | 1.2, `out/pairC_*.png`: C 전 | 후 확대 비교.
- 수치는 '얼마나 바뀌었나'만 알려 준다. 좋아졌는지는 `cmp_*` 이미지를 눈으로 본다 (`noise.py` 잔무늬 점수는 비누 기본 점무늬에 묻혀 변별력이 낮았다).
