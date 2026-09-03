# h5ad 뷰어

비전문가가 단일세포 데이터 파일(`.h5ad`, AnnData/HDF5) 안에 무엇이 들어있는지
**브라우저에서 바로** 확인하는 도구. 파일은 클라이언트 사이드에서만 열리며 서버로
전송되지 않는다. GitHub Pages 정적 호스팅.

**라이브:** https://foreverlee-94.github.io/vc_challenge_h5ad_web_reader/

개발 계획은 [PLAN.md](PLAN.md) 참고.

## 사용법

파일을 선택하면 상단 탭이 나타난다.

- **개요** — 세포 × 유전자 수, `X`의 형식·밀도, obs/var 컬럼 목록, 레이어·임베딩,
  uns 요약을 일상어로.
- **탐색** — 왼쪽 열에서 시작해 오른쪽으로 파고드는 열(column) 방식 탐색기.
  `obs`/`var`의 컬럼, `layers`/`obsm`/…의 키, `uns`의 중첩 구조를 열을 쌓으며 들어간다.
  잎 항목을 고르면 아래에 값이 표시된다:
  - 범주형 → 빈도 표 / 막대그래프, 수치형 → 요약통계 / 히스토그램, 문자열 → 고유값·빈도
  - 행렬(`X`, 레이어 등) → 구간 미리보기(행·열 시작을 **번호 또는 이름**으로 지정) / 형태·밀도
  - 어떤 표든 **CSV로 저장** 가능
- **구조** — 원본 HDF5 트리(그룹·데이터셋·속성) 그대로.
- **폴더 스캔** — `[폴더 스캔]` 버튼 또는 폴더 드래그. 폴더(하위 폴더 포함)의 모든
  `.h5ad`를 **가볍게**(파일당 수 KB) 읽어 유전자 개수를 모으고, 최소·최대·중앙값과
  개수 분포 히스토그램, 파일별 표(행 클릭 시 그 파일 열기)를 보여줌. RAM은 파일 수와
  무관하게 거의 일정(Web Worker + WORKERFS 기준).

파일은 브라우저 밖으로 나가지 않는다. 기본은 Web Worker(h5wasm + WORKERFS 지연 로딩)
이고, 워커를 못 쓰는 브라우저에서는 자동으로 메인 스레드(파일 전체 메모리 로드)로
전환하며 경고를 표시한다. `?engine=main` 으로 폴백을 강제할 수 있다.

## 구조

```
docs/            GitHub Pages로 배포되는 정적 사이트 (이것만 있으면 동작)
  index.html  css/style.css
  js/  app.mjs          UI 셸: 탑 네비 + 탐색 열 + 상세 패널
       worker.mjs       Web Worker 엔진 (WORKERFS 지연 로딩)
       mainengine.mjs   메인 스레드 폴백 엔진 (MEMFS)
       hdf5tree.mjs      두 엔진 공용 원본 트리 순회
       anndata.mjs       AnnData 인코딩 → 구조 요약
       reads.mjs         값 읽기 (컬럼·행렬 슬라이스·uns·축 인덱스)
       stats.mjs charts.mjs   통계 + 의존성 없는 SVG 차트
  vendor/h5wasm/   HDF5 읽기용 WASM 라이브러리 (벤더링, 무수정)
scripts/         개발·검증용 (배포 대상 아님)
pyproject.toml   uv 환경 — 검증 스크립트 실행용 (런타임 서버 아님)
```

## 로컬에서 보기

```bash
uv run python -m http.server -d docs 8000
# 브라우저에서 http://localhost:8000
```

`file://` 로 직접 열면 ES 모듈/워커가 막히므로 반드시 http 서버로 연다.
표준 라이브러리만 쓰므로 별도 설치는 없다.

## GitHub Pages 배포

이미 설정되어 있다: Source = **Deploy from a branch**, Branch = **main** `/docs`.
`main`에 푸시하면 1~2분 뒤 위 라이브 주소에 반영된다. 빌드 단계 없음(Actions 불필요).

처음부터 다시 설정할 때: 저장소 **Settings → Pages → Build and deployment**에서
Source를 "Deploy from a branch", Branch를 `main` / `/docs`로 지정.

## 개발 환경 (검증용)

```bash
uv sync                                                  # 파이썬 3.12 환경
uv run python scripts/make_fixture.py scratchpad/fixture.h5ad   # 모든 인코딩을 담은 작은 테스트 파일
uv run python scripts/expected_summary.py context_A.h5ad        # anndata 기준 정답 요약(JSON)
node scripts/summary_h5wasm.mjs context_A.h5ad                  # 브라우저 파서를 Node에서 실행 → 대조
node scripts/reads_h5wasm.mjs scratchpad/fixture.h5ad          # 값 읽기 연산 점검
node scripts/browser_probe.mjs http://localhost:8000/          # 실제 헤드리스 Chrome(실시간 CDP) 회귀 테스트
```

파이썬 의존성: `anndata`, `h5py`, `numpy`, `pandas`, `scipy` (웹 앱 런타임과 무관,
브라우저 리더 결과를 대조하기 위한 오라클).

## 라이브러리

HDF5 파싱: [h5wasm](https://github.com/usnistgov/h5wasm) 0.10.3.
`docs/vendor/h5wasm/`에 두 개의 ES 모듈로 벤더링되어 있고 wasm 바이너리는 JS에
내장되어 있어 별도 호스팅/CDN이 필요 없다. 자세한 내용은
[docs/vendor/h5wasm/README.md](docs/vendor/h5wasm/README.md).
