# Wargame 3D Replay — Demo

three.js 기반 워게임 시뮬레이션 리플레이 데모. 외부 GLTF 모델 없이 프리미티브로 만든 stylized 유닛을 사용합니다 (보병/탱크/드론/포). 더미 시나리오는 런타임에 결정론적으로 생성되며, 추후 실제 시뮬레이션 데이터로 쉽게 교체 가능한 스키마를 사용합니다.

## 실행 방법

ES module과 importmap을 쓰기 때문에 `file://` 로는 동작하지 않습니다. 로컬 HTTP 서버를 띄우세요.

```bash
cd /home/yeongha/pycharm/wargame/demo
python3 -m http.server 8080
```

브라우저에서 http://localhost:8080 접속.

## 컨트롤

- **마우스 드래그**: 카메라 회전 / **휠**: 줌 / **우클릭 드래그**: 팬
- **Space**: 재생/일시정지
- **←/→**: ±2초 점프
- **C**: 시네마틱 카메라 on/off
- **하단 슬라이더**: 시간 스크럽
- **Speed**: 0.5× ~ 4× 재생 속도
- **시네마틱 모드 중 마우스/휠 입력**: 자동으로 free 모드로 전환 (사용자가 직접 카메라 조작)

## 데모 시나리오

60초 길이의 Blue vs Red 교전:

| 진영 | 보병 | 탱크 | 드론 | 자주포 |
|------|-----:|-----:|-----:|------:|
| Blue (남쪽) | 8 | 2 | 2 | 2 |
| Red (북쪽)  | 8 | 2 | 2 | 2 |

- 양측 보병이 중앙으로 진격 → t=20s 부근에서 접촉
- 탱크가 측면에서 진격, 일부 격파 (Blue tank_2 t=38s, Red tank_1 t=40s)
- 드론은 전장 상공을 선회 (Blue drone_2 t=46s, Red drone_1 t=50s 격추)
- 보병 약 절반이 t=42~55s에 사망
- 격파된 유닛은 마지막 위치에 빨간 링 마커로 표시

## 폴더 구조

```
demo/
├── index.html              HUD, importmap, 컨트롤
├── package.json            Node가 .js를 ESM으로 인식하게 함 (브라우저는 무시)
├── data/
│   ├── battle.csv          ★ 유닛 트랙 데이터 (timestamp 정렬)
│   └── cameras.json        ★ 카메라 스케줄 (시네마틱 컷)
├── scripts/
│   └── dump_csv.mjs        scenario.js → battle.csv 재생성
└── src/
    ├── main.js             scene/camera/lights/loop, CSV 로드, 보간 적용
    ├── units.js            보병/탱크/드론/포 모델 팩토리
    ├── csvLoader.js        CSV → scenario 객체 변환
    ├── cinematic.js        카메라 디렉터 (follow/pov/orbit/free)
    ├── effects.js          발사/폭발/연기 이펙트
    └── scenario.js         더미 시나리오 생성기 (덤프 스크립트 전용, 런타임 미사용)
```

## 카메라 스케줄 — `data/cameras.json`

타임스탬프별로 어떤 시점으로 보여줄지 정의합니다. 배열 형태이며 t 오름차순.

```json
[
  { "t": 0,  "mode": "follow", "agent": "blue_tank_1", "offset": [0, 4, -10] },
  { "t": 14, "mode": "pov",    "agent": "blue_drn_1" },
  { "t": 26, "mode": "orbit",  "agent": "blue_art_1", "distance": 11, "height": 5, "speed": 0.5 },
  { "t": 38, "mode": "follow", "agent": "red_tank_2", "offset": [0, 4, -10] },
  { "t": 50, "mode": "free" }
]
```

| 모드 | 동작 | 주요 옵션 |
|---|---|---|
| `follow` | 에이전트의 yaw 기준 로컬 오프셋 위치에서 추격뷰. yaw가 회전하면 카메라도 함께 회전. | `offset: [x, y, z]` (로컬 좌표, +z=전방) |
| `pov`    | 에이전트의 1인칭. yaw 방향으로 멀리 바라봄. | (없음) |
| `orbit`  | 에이전트 주변을 일정 속도로 도는 시네마틱 회전. | `distance`, `height`, `speed`(rad/s), `phase` |
| `free`   | OrbitControls에 카메라 반납. 사용자가 직접 조작. | (없음) |

- 한 shot의 `t` 가 도달하면 다음 shot까지 그 모드를 계속 사용합니다.
- shot이 바뀌는 순간 1초간 부드러운 보간(smoothstep)으로 이전 카메라 상태와 블렌드.
- 스크럽으로 시간을 점프하면 해당 shot이 즉시 활성화되고 보간이 재시작됩니다.
- 사용자가 마우스 드래그/휠을 하면 시네마틱이 자동 OFF되고 OrbitControls로 카메라 반납. 다시 켜려면 `📽 Cinema` 버튼 또는 `C` 키.

### follow 오프셋 좌표계
오프셋은 에이전트 로컬 프레임입니다. `+z`가 전방.
- `[0, 4, -10]` → 4m 위, 10m **뒤**에서 추격
- `[0, 2, 6]`  → 2m 위, 6m **앞**에서 후진하며 정면 응시
- `[5, 3, 0]`  → 우측면 5m, 3m 위 (사이드뷰)
yaw가 π여도 회전이 자동 적용되므로 `[0, 4, -10]`은 항상 "뒤"입니다.

## 데이터 형식 — `data/battle.csv`

컬럼 순서는 헤더 기준으로 매칭되므로 자유롭게 바꿔도 됩니다. 헤더 이름은 고정.

```csv
timestamp,team,agent_type,agent_id,x,y,z,yaw,alive,event,target
0,blue,artillery,blue_art_1,-8,0,-48,0,1,,
0,blue,drone,blue_drn_1,8,7,-10,1.5708,1,,
37.6,red,tank,red_tank_2,18.04,0,6,3.1416,1,fire,blue_tank_2     ← 발사 이벤트
38,blue,tank,blue_tank_2,18,0,-6,0,0,,                            ← 사망 (alive=0) 키프레임
60,red,tank,red_tank_2,18,0,6,3.1416,1,,
```

| 컬럼 | 의미 | 비고 |
|---|---|---|
| `timestamp` | 초 단위 시간 | **오름차순 정렬 권장** (loader가 방어적으로 재정렬하긴 함) |
| `team` | `blue` / `red` | |
| `agent_type` | `infantry` / `tank` / `drone` / `artillery` | `units.js`의 팩토리 키와 일치 |
| `agent_id` | 유닛 고유 ID | 같은 ID의 행들이 한 트랙으로 묶임 |
| `x, y, z` | 월드 좌표 (미터) | y는 고도 — 드론은 `>0`, 지상 유닛은 0 |
| `yaw` | 라디안, +Z를 0으로 | 선형 보간됨 |
| `alive` | `1`/`0` 또는 `true`/`false` | 키프레임 사이에서 보간되지 않고 다음 키프레임에 도달하면 전환 |
| `event` | 빈 값 또는 `fire` | (선택) 행이 발사 이벤트도 겸함 |
| `target` | `event=fire` 일 때 대상 `agent_id` | (선택) |

키프레임 사이 위치/yaw는 **선형 보간**, alive는 **순간 전환**(다음 키프레임에 도달 시).

### 발사 이벤트 — `event=fire`

`event` 컬럼에 `fire`가 적힌 행은 **그 행의 agent_id가 target을 향해 발사**한 것을 의미합니다. 같은 행이 발사자의 트랙 키프레임 역할도 동시에 합니다 (좌표가 발사자 위치).

이펙트 진행 (시나리오 시간 기준):

| 단계 | 구간 | 시각 효과 |
|---|---|---|
| 머즐 플래시 | `t .. t+0.15s` | 포구에서 노란빛 sprite |
| 트레이서 비행 | `t .. t+0.4s` | 발광체가 발사자 → 표적 위치로 직진 |
| 명중 폭발 | `t+0.4s .. t+1.4s` | 점점 커지면서 페이드되는 주황 구체 + 흰색 플래시 |
| 연기 | `t+0.4s .. t+4.4s` | 검은 sprite 3개가 천천히 상승하며 페이드 |

각 이벤트의 phase가 **시나리오 시간 기준**이므로 슬라이더로 스크럽해도 정확히 그 순간의 이펙트가 재현됩니다.

표적 위치는 `t + 0.4s` (명중 시점) 시점의 표적 트랙에서 보간됩니다 — 표적이 움직이고 있어도 자연스럽게 따라잡습니다.

### 더미 데이터에서의 자동 추론

`scenario.js` 의 더미 생성기는 모든 사망 키프레임에 대해:
1. `t_fire = t_death - 0.4s` 산정
2. 같은 시점에 살아있는 적 중 **거리 × 무기 가중치**가 최소인 유닛을 발사자로 선정 (탱크/포 우선)
3. fire 이벤트 한 줄을 CSV에 추가

→ 12명 사망 시나리오에서 12개 fire 이벤트가 자동 생성됩니다. 실제 시뮬에선 이 추론 단계를 건너뛰고 정확한 발사 로그를 그대로 쓰면 됩니다.

## 더미 데이터 재생성

시나리오 파라미터를 바꿔서 CSV를 다시 만들고 싶을 때:

```bash
node scripts/dump_csv.mjs              # seed=7, duration=60 (기본값)
node scripts/dump_csv.mjs 42 90        # seed=42, duration=90초
```

→ `data/battle.csv` 가 덮어써집니다.

## 실제 시뮬레이션과 연결

Python 시뮬에서 같은 스키마로 CSV를 떨어뜨리면 끝입니다. 예시:

```python
import csv
with open('demo/data/battle.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['timestamp','team','agent_type','agent_id','x','y','z','yaw','alive'])
    for row in sorted(events, key=lambda r: r['t']):
        w.writerow([row['t'], row['team'], row['type'], row['id'],
                    row['x'], row['y'], row['z'], row['yaw'], int(row['alive'])])
```

브라우저 새로고침만 하면 새 데이터로 재생됩니다.

## GLTF 모델로 업그레이드

`src/units.js`의 `FACTORIES` 맵 항목을 GLTF 로더 기반 함수로 교체하면 됩니다:

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const loader = new GLTFLoader();
const cache = {};
async function loadModel(url) {
  if (!cache[url]) cache[url] = (await loader.loadAsync(url)).scene;
  return cache[url].clone(true);
}
```

추천 무료 모델 출처: [Kenney.nl](https://kenney.nl/) (저폴리 밀리터리 팩), [Poly Pizza](https://poly.pizza/), [Sketchfab](https://sketchfab.com/) (CC0 검색).

같은 모델 인스턴스가 100+ 개로 늘어나면 `THREE.InstancedMesh`로 교체하는 것이 60fps 유지에 유리합니다.
