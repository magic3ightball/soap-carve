# 물고기 깎기 자동 플레이 결과 요약: python3 play_report.py <이름>
# out/<이름>/log.json 을 읽어 도구별 횟수, 진행률 곡선, 느린 동작, 헛손질(맞지 않음), 너무 깎음 증가를 찍는다
import sys, os, json
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', sys.argv[1])
d = json.load(open(os.path.join(root, 'log.json')))
S, L = d['summary'], d['log']
print('요약', json.dumps(S['final'], ensure_ascii=False), '획', S['strokes'], '오류', S['errors'], S['gpuErrors'])
print('성능', S['perf'])
tools = {}
for r in L: tools.setdefault(r['tool'], []).append(r)
for t, rs in tools.items():
    miss = sum(1 for r in rs if r['mode'] in ('orbit', None))
    ms = sorted(r['ms'] for r in rs); up = sorted(r['upMs'] for r in rs); fm = sorted(r['frameMax'] for r in rs)
    q = lambda a, f: a[min(len(a) - 1, int(len(a) * f))]
    print(f'{t:6s} {len(rs):4d}회  헛손질 {miss:3d}  동작ms 중앙 {q(ms,.5)} 90% {q(ms,.9)} 최대 {ms[-1]}  '
          f'손뗄때ms 중앙 {q(up,.5)} 최대 {up[-1]}  한프레임최대 중앙 {q(fm,.5)} 최대 {fm[-1]}')
print('진행률 곡선 (동작 번호: 진행률 / 너무 깎음%)')
for r in L[::max(1, len(L) // 20)]: print(f"  {r['i']:4d} {r['tool']:6s} {r['progress']:.3f} / {r['over']*100:.2f}%")
# 너무 깎음이 늘어난 동작
jumps = [(L[i]['over'] - L[i - 1]['over'], L[i]) for i in range(1, len(L))]
jumps = sorted([j for j in jumps if j[0] > 0.0005], key=lambda x: -x[0])[:8]
print('너무 깎음이 크게 늘어난 동작:')
for dv, r in jumps: print(f"  #{r['i']} {r['tool']} +{dv*100:.2f}%p depth {r.get('depth')} tMin {r.get('tMin')} L {r.get('L')} clumsy {r.get('clumsy')} repeat {r.get('repeat', False)}")
slow = sorted(L, key=lambda r: -r['upMs'])[:5]
print('손 뗄 때 가장 느린 동작:', [(r['i'], r['tool'], r['upMs']) for r in slow])
print('캡처 단계:'); [print('  ', s['tag'], s['progress'], s['over'], s.get('band'), '획', s['at']) for s in S['shots']]
# 너무 깎은 복셀이 칼날 기준 어디서 생겼나 (도구별 합계) + 조각이 떨어져 나간 동작
agg = {}
for r in L:
    o = r.get('newOver')
    if not o: continue
    a = agg.setdefault(r['tool'], {'blade': 0, 'column': 0, 'far': 0, 'total': 0, 'dropActs': 0, 'farWithDrop': 0})
    for k in ('blade', 'column', 'far', 'total'): a[k] += o[k]
    if r.get('dropped'): a['dropActs'] += 1; a['farWithDrop'] += o['far']
print('너무 깎음 위치 (복셀 수): blade=날 깊이 안, column=날 위 기둥, far=날에서 먼 곳')
for t, a in agg.items(): print(f'  {t:6s}', a)
