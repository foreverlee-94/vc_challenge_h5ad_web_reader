# h5ad 뷰어

비전문가가 단일세포 데이터 파일(`.h5ad`, AnnData/HDF5) 안에 무엇이 들어있는지
**브라우저에서 바로** 확인하는 도구. 파일은 클라이언트 사이드에서만 열리며 서버로
전송되지 않는다. GitHub Pages 정적 호스팅.

개발 계획은 [PLAN.md](PLAN.md) 참고.

## 구조

```
docs/            GitHub Pages로 배포되는 정적 사이트 (이것만 있으면 동작)
  index.html
  css/ js/
  vendor/h5wasm/  HDF5 읽기용 WASM 라이브러리 (벤더링, 무수정)
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

1. 이 저장소를 GitHub에 푸시.
2. 저장소 **Settings → Pages → Build and deployment**
   - Source: **Deploy from a branch**
   - Branch: **main**, 폴더: **/docs**
3. 몇 분 뒤 `https://<사용자>.github.io/<저장소>/` 에서 접속.

빌드 단계가 없으므로 Actions 설정은 필요 없다.

## 개발 환경 (검증용)

```bash
uv sync                                    # 파이썬 3.12 환경
uv run python scripts/expected_summary.py context_A.h5ad   # 정답 요약(JSON)
node scripts/smoke_h5wasm.mjs context_A.h5ad               # 벤더 라이브러리 동작 확인
```

파이썬 의존성: `anndata`, `h5py`, `numpy`, `pandas`, `scipy` (웹 앱 런타임과 무관,
브라우저 리더 결과를 대조하기 위한 오라클).

## 라이브러리

HDF5 파싱: [h5wasm](https://github.com/usnistgov/h5wasm) 0.10.3.
`docs/vendor/h5wasm/`에 두 개의 ES 모듈로 벤더링되어 있고 wasm 바이너리는 JS에
내장되어 있어 별도 호스팅/CDN이 필요 없다. 자세한 내용은
[docs/vendor/h5wasm/README.md](docs/vendor/h5wasm/README.md).
