# h5ad 뷰어 — 개발 계획

비전문가가 `.h5ad`(단일세포 AnnData) 파일 안의 데이터를 브라우저에서 확인하는 도구.

## 결정 사항 (확정)

| 항목 | 결정 | 비고 |
|---|---|---|
| 실행 형태 | 100% 정적 사이트, 서버 코드 없음 | |
| 호스팅 | GitHub Pages (`main` 브랜치 `/docs`) | Actions 불필요 |
| 파일 처리 | 브라우저 클라이언트 사이드에서만, 업로드 없음 | 개인정보/대용량 안전 |
| HDF5 파싱 | h5wasm 0.10.3 (WASM), `docs/vendor/h5wasm/`에 벤더링 | 빌드·CDN 불필요, wasm은 JS에 내장 |
| 대용량 파일 | 처음부터 WORKERFS 지연 로딩 (Web Worker + `FileReaderSync`) | 파일 전체를 메모리에 올리지 않음 |
| UI | 연쇄 드롭다운(구성요소 → 키 → 보기)으로 모든 조합 탐색 | |
| 데모 파일 | 없음 (사용자가 자기 파일 선택) | |
| 그래프 | 의존성 0, SVG 직접 렌더 (막대·히스토그램) | |
| 프론트 빌드 | 없음. 순수 HTML + ES 모듈 | |

## 파일 특성 (challenge 데이터 실측)

- 압축: 전부 gzip → h5wasm 기본 지원
- `X`: CSR (`data`/`indices`/`indptr`, `shape` 속성), float32, 밀도 약 32%
  - `X/data` 길이 1.1억 → 전체 통계는 표본만, `nnz`는 `indptr[-1]`로 무료
- `obs/_index`: 데이터셋이 아니라 `nullable-string-array` 그룹 (`values` + `mask`)
- 범주형: `categories`(문자열) + `codes`(int8)
- 빈 `layers`/`obsm`/`varm`/`obsp`/`varp`/`uns` 그룹 존재 → "없음" 처리
- int64 속성/shape는 h5wasm에서 BigInt로 옴 → Number 변환 필요
- `.attrs[name]`는 래퍼 객체, 실제 값은 `.value` 게터 (`X/data`엔 절대 `.value` 금지)

## 아키텍처

```
docs/ (GitHub Pages 루트)
  index.html
  css/style.css
  js/
    app.mjs       메인 스레드 UI + 엔진 선택(worker → main 폴백), 렌더
    worker.mjs    Web Worker 엔진: h5wasm + WORKERFS 지연 마운트
    mainengine.mjs 메인 스레드 폴백 엔진: h5wasm + MEMFS(전체 메모리)
    hdf5tree.mjs  두 엔진 공용: 원본 HDF5 트리 순회
    anndata.mjs   AnnData-on-HDF5 의미 해석 (인코딩 규약)
    stats.mjs     [Phase 2] 수치/범주/문자열 통계, 히스토그램 빈
    charts.mjs    [Phase 3] SVG 막대·히스토그램
  vendor/h5wasm/  hdf5_hl.js, hdf5_util.js (벤더링, 무수정)

scripts/          (개발·검증용, Pages 미포함)
  expected_summary.py   anndata/h5py 기반 정답 요약 → JS 결과 대조
  summary_h5wasm.mjs    브라우저 파서(anndata.mjs)를 Node에서 실행해 대조
  smoke_h5wasm.mjs      벤더링된 h5wasm이 실제 파일을 읽는지 확인
  make_fixture.py       모든 인코딩을 담은 작은 테스트 h5ad 생성(scratchpad/)
  browser_probe.mjs     의존성 없는 CDP 드라이버(헤드리스 Chrome 회귀 테스트)
```

**엔진 폴백**: `app.mjs`가 모듈 Web Worker를 8초 타임아웃 + `onerror`로 부팅
시도 → 실패 시 `mainengine.mjs`(메인 스레드, MEMFS)로 자동 전환. `?engine=main`
으로 강제 가능. 이전에 워커 부팅 실패 시 오류가 표면화되지 않아 "로딩이 안돼"
증상이 있었음 → 수정됨.

**주의**: 헤드리스 Chrome의 `--virtual-time-budget`은 워커 내 WASM 인스턴스화를
멈추게 함(실제 브라우저 버그 아님). 회귀 테스트는 `browser_probe.mjs`(실시간 CDP)
로만 신뢰할 것.

메시지 프로토콜(app ↔ worker): `{id, type, payload}` 요청 / `{id, ok, result|error}` 응답.
연산: `open`, `summary`, `column`, `matrixSlice`, `unsNode`.

## 처리할 AnnData 인코딩

`anndata`, `dataframe`, `categorical`, `nullable-integer`, `nullable-boolean`,
`string-array` / `nullable-string-array`, `csr_matrix` / `csc_matrix`, `array`,
`dict`(uns), 스칼라(`string`, `numeric-scalar`).

## 드롭다운 UI

1. **구성요소**: `X` / `obs` / `var` / `layers` / `obsm` / `varm` / `obsp` / `varp` / `uns` / `raw` — 존재하는 것만
2. **항목(키)**: obs·var→컬럼명, mapping→키, `uns`→중첩 경로 단계 선택, `X`→없음
3. **보기 방식** (leaf 타입별):
   - 범주형 1D → 값 표 / 빈도 막대 / 요약
   - 수치형 1D → 값 표 / 히스토그램 / 요약통계
   - 문자열 1D → 값 표 / 고유값·빈도
   - 2D 행렬 → 구간 미리보기(행·열 범위 + 유전자명/세포 인덱스 선택) / 행 통계 / 열 통계 / 형태·밀도
   - uns leaf → 스칼라 / 배열 미리보기 / 딕셔너리 트리

항상 보이는 개요 패널: 세포×유전자 수, 컬럼·자료형, mapping 키, X 밀도·nnz, 일상어 요약.

## 단계

- **Phase 0 — 스캐폴드 (완료)**: git init, `docs/` 골격, h5wasm 벤더링, uv 의존성 정리,
  검증 스크립트, 원본 HDF5 트리를 보여주는 최소 수직 슬라이스 (WORKERFS 마운트 포함).
- **Phase 1 — 파서 (완료)**: `anndata.mjs`로 구조 → 요약 객체, 일상어 개요 UI.
  `expected_summary.py`와 대조(context_A/B/C + fixture). 엔진 폴백 + 오류 표면화 추가,
  헤드리스 Chrome 실시간 CDP로 워커/폴백/225MB 파일 검증.
- **Phase 2 — 읽기 연산**: `readColumn`(코드→라벨), `readMatrixSlice`(CSR), `readUnsNode`, 통계.
- **Phase 3 — 드롭다운 UI**: 연쇄 셀렉터 + 보기별 렌더 + 개요 패널 + 차트.
- **Phase 4 — 마무리**: 로딩/에러 표시, 대용량·Safari 경고, README, 첫 Pages 배포 확인.
- **후속**: 현재 보기 CSV 내보내기, Playwright 스모크 테스트, IDBFS 캐시.

## 로컬 미리보기

```
uv run python -m http.server -d docs 8000   # http://localhost:8000
```
(표준 라이브러리, 추가 의존성 없음. WORKERFS·모듈 워커는 http:// 에서 정상 동작.)

## 리스크 / 검증 항목

1. h5wasm 가변길이 UTF-8 문자열 읽기 — 실측 OK (`obs/_index/values`, categories)
2. `_index`가 그룹인 경우 — 파서에서 데이터셋/그룹 두 형태 대응
3. 대용량 파일 메모리 — WORKERFS로 완화, 그래도 Safari 한도 경고 필요
4. GitHub Pages `.wasm` MIME — wasm이 JS 내장이라 해당 없음. 모듈 워커만 첫 배포 후 확인
5. `uns` 재귀 깊이/크기 — 트리 순회에 depth/child 상한 적용
