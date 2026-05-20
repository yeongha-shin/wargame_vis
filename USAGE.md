# 사용법 (USAGE)

이 문서는 **현재 코드 기준**으로 화면을 어떻게 조작하고 각 기능이 무엇을 보여주는지를 설명합니다.
데이터 포맷(`battle.csv`/CSV 컬럼)·카메라 스케줄(`cameras.json`)·더미 데이터 재생성은 [README.md](README.md)를 참고하세요.

---

## 1. 실행

ES module + importmap을 쓰므로 `file://` 로는 안 됩니다. 로컬 HTTP 서버로 띄우세요.

```bash
cd /home/yeongha/pycharm/wargame/demo
python3 -m http.server 8080
```

브라우저에서 http://localhost:8080 접속.

> 재생되는 데이터 파일은 `src/main.js` 상단의 `CSV_URL` / `CAMERAS_URL` 로 지정됩니다
> (현재 기본값: `data/kaist_simulation.csv`, `data/cameras.json`). 파일을 바꾸면 새로고침만 하면 됩니다.

---

## 2. 화면 구성

| 위치 | 패널 | 내용 |
|---|---|---|
| 우측 상단 | **Stats** | 시간, 진영/병종별 잔존 수, 강도 바(작전가능=팀색 / 무력화=주황 / 손실=빈 칸) |
| 좌측 상단 | **Inspector** | 유닛 클릭 시 표시 (3절 참고). 평소엔 숨김 |
| 우측 하단 | **Help** | 마우스/단축키 요약 |
| 하단 중앙 | **Controls** | 재생·스크럽·속도·토글 버튼 |
| 화면 중앙 | **Viewer label** | 시네마틱 모드에서 현재 추적 대상 표시 |
| 커서 옆 | **Hover tip** | 유닛에 마우스를 올리면 진영/병종/ID 표시 (3절) |

---

## 3. 마우스 인터랙션

### 카메라 (OrbitControls)
- **드래그**: 회전 · **휠**: 줌 · **우클릭 드래그**: 팬
- 시네마틱 모드 중 드래그/휠을 하면 자동으로 free 모드로 풀립니다.

### 마우스 오버 — 툴팁
유닛 위에 커서를 올리면 커서 옆에 **진영(대문자, 팀 색) / Agent(병종) / ID** 가 뜹니다.
파괴되어 숨겨진 유닛은 잡히지 않습니다. 화면 가장자리에서는 툴팁이 자동으로 반대쪽에 붙습니다.

### 클릭 — Inspector (좌측 상단 고정 카드)
유닛을 **클릭**하면 좌측 상단에 그 유닛 카드가 고정됩니다.

- **Agent / Team / ID**: 정적 정보
- **Status**: 현재 상태가 3단계로 실시간 갱신
  - 🟢 Operational(작전가능) · 🟠 Incapacitated(무력화) · 🔴 Destroyed(파괴)
- **3D 미리보기**: 그 유닛의 모델이 자체 미니 뷰에서 천천히 회전 (전장 유닛과 독립 → 상태 어두워짐/숨김 영향 없음)
- 카드의 **✕** 로 닫기

> 클릭과 카메라 드래그를 구분합니다: 누른 지점에서 6px 이상 움직였으면 "회전"으로 보고 선택하지 않습니다.
> 빈 공간 클릭은 선택을 바꾸지 않습니다(실수 방지). 닫기는 ✕ 로만.

---

## 4. 재생 / 카메라 컨트롤

### 하단 버튼
| 버튼 | 동작 |
|---|---|
| ▶ Play / ❚❚ Pause | 재생·일시정지 |
| ⟲ Restart | 시간 0으로. **정찰 커버리지와 누적 포착 정보(화살표)도 초기화** |
| 📽 Cinema | 시네마틱 카메라 on/off |
| 🔊 Sound | 효과음 on/off |
| 🛰 Detection | 정찰 시각화 on/off (5절) |
| 슬라이더 | 시간 스크럽 (드래그 중 일시정지처럼 동작) |
| Speed | 0.5× / 1× / 2× / 4× / 8× |

### 단축키
| 키 | 동작 |
|---|---|
| `Space` | 재생/일시정지 |
| `←` / `→` | −2초 / +2초 점프 |
| `C` | 시네마틱 on/off |
| `D` | Detection on/off |

스크럽으로 시간을 점프해도 발사/폭발/연기 등 이펙트는 해당 시점 그대로 재현됩니다.

---

## 5. Detection 모드 (🛰 / `D`)

Detection을 켜면 **정찰 관련 시각화 3종**이 함께 표시되고, 끄면 모두 사라집니다.

1. **드론 정찰 원형 음영 (현재 위치만)**
   작전가능 상태 드론 아래 지면이 팀 색으로 음영 처리됩니다.
   - 지형을 따라 굴곡에 밀착(평면 아님)
   - Red = 붉은색, Blue = 파란색, 양 팀 겹침 = 보라색
   - **누적 아님**: 매 프레임 현재 위치만 표시(이전 궤적은 남지 않음). 얇은 외곽 링도 함께 표시
   - 누적 방문 영역은 화면엔 안 그려지지만 내부적으로는 추적되어 아래 3번에 쓰입니다

2. **지휘소(빌딩) 관측 원뿔**
   `building` 형상으로 설정된 지휘소에 한해, 건물 최고점(안테나 끝)에서 지면 반경까지
   반투명 팀 색 원뿔이 표시됩니다. 파괴되면 사라집니다.

3. **정찰 → 지휘소 포물선 화살표**
   해당 팀의 드론이 **누적으로 방문한 영역 안에 상대 자주포가 있었던** 경우,
   그 팀 색의 반투명 포물선 화살표가 **자기 지휘소 → 적 자주포** 방향으로 그려집니다(화살촉이 자주포에 꽂힘).
   - 한 번 포착되면 계속 유지(누적 정보) — 단, 자주포가 파괴되거나 Detection을 끄면 숨김
   - ⟲ Restart 시 초기화

---

## 6. 자주 바꾸는 설정 (코드 상단 토글)

### 지휘소 형상 — `src/units.js` 상단
```js
const COMMAND_POST_SHAPE = 'building';          // 'tent' | 'building'
const COMMAND_POST_BUILDING_TEAMS = ['red'];    // ['red'] | ['blue'] | ['red','blue']
```
- `SHAPE`가 `'building'` **이고** 그 팀이 `BUILDING_TEAMS`에 포함될 때만 빌딩(고층) 형상.
- 그 외에는 기존 텐트형 지휘소.
- 빌딩 지휘소만 5-2의 관측 원뿔과 5-3 화살표의 시작점(건물 정점)을 가집니다.

### 정찰 반경 / 화살표 투명도 — `src/main.js`
```js
const DETECTION_RADIUS = 8.0;          // 드론 정찰 원 반경(월드 m)
const COMMAND_DETECTION_RADIUS = 14.0; // 지휘소 관측 원뿔의 지면 반경
```
정찰→지휘소 화살표의 진하기는 `makeIntelArrow()` 안 머티리얼 `opacity`(현재 `0.6`)로 조절합니다.

---

## 7. 배경 지도 다른 좌표로 재생성

`scripts/rebuild_terrain.sh` 한 번이면 위·경도 bbox만 바꿔 배경 지도용 두 PNG를 같이 다시 만듭니다. 같은 경로로 덮어쓰므로 코드 수정은 없고, 브라우저만 강제 새로고침(Ctrl+Shift+R)하면 새 지형이 보입니다.

```bash
scripts/rebuild_terrain.sh <south> <west> <north> <east>
# 예: 현재 적용된 AOI 재빌드
scripts/rebuild_terrain.sh 48.8711945 38.2002615 48.8868365 38.2384235
```

생성/덮어쓰는 파일:
- `outputs/vuhledar_terrain_overlay.png` — 색상 오버레이 (urban/forest/open_field/water/railway)
- `data/vuhledar_height_grid.png` — grayscale 높이맵

내부 동작: `build_vuhledar_terrain.py`로 OSM + Copernicus DEM(자동 다운로드)을 받아 50 m 격자를 분류·표고 샘플링하고, 이어서 `scripts/dump_height_overlay.py`가 격자 CSV에서 높이 PNG를 뽑습니다.

주의:
- 셀 크기는 **50 m 고정** — `dump_height_overlay.py`가 `data_processed/terrain_grid_50m.csv`를 이름으로 읽기 때문. 다른 해상도가 필요하면 그 스크립트도 같이 손봐야 합니다.
- Python은 기본 `/home/yeongha/anaconda3/envs/geo_env/bin/python` (osmnx · geopandas · rasterio · rioxarray · folium 필요). 다른 환경이면 `PYTHON=/path/to/python scripts/rebuild_terrain.sh ...`.
- DEM 타일을 새로 받으면 영역에 따라 수십 MB / 1~2분. OSM에 빌딩이 없는 시골 지역이면 buildings 레이어는 0개로 잡혀도 정상.
- 지형 PNG는 고정된 120 m × 120 m 게임 평면 위에 입히는 스킨일 뿐 — 유닛 위치(`data/kaist_simulation.csv`)는 자동으로 새 좌표로 이동하지 않습니다.

---

## 8. 참고

- 코드 변경 후 문법 점검: `node --check src/<파일>.js` (이 프로젝트는 별도 빌드/테스트 도구 없음 — 동작 확인은 브라우저 새로고침).
- 데이터 스키마·카메라 스케줄·실제 시뮬레이션 연동·GLTF 교체는 [README.md](README.md) 참고.
