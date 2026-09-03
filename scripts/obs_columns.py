"""Audit the `obs` columns of every .h5ad in a folder — metadata only, so it is
fast even on multi-GB files (h5py opens lazily; we read attrs + key names, never
the data).

    uv run python scripts/obs_columns.py "<folder>" [--pattern REGEX]

Default pattern flags per-cell gene/feature count or list columns
(n_genes, n_genes_by_counts, nFeature_RNA, detected_genes, gene_list, …).
Prints, per file, the matching obs columns, then the files with none.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import h5py
import numpy as np

# per-cell "how many / which genes" style obs columns
DEFAULT_PATTERN = re.compile(
    r"""(
        ^n_?genes?(_by_counts)?$ | ^num_?genes?$ | ^gene_?counts?$ | ^count_?genes?$ | ^genes?_?count$ |
        ^n_?features?(_[a-z0-9]+)?$ | ^nfeatures?_?[a-z0-9]* | ^n_?feature$ |
        detected_?genes? | expressed_?genes? | genes?_?detected | ^ngenes?$ |
        ^total_?features?(_by_counts)? |
        ^gene_?list$ | ^genes$ | ^top_?genes? | ^marker_?genes?
    )""",
    re.IGNORECASE | re.VERBOSE,
)


def obs_columns(f: h5py.File) -> list[str]:
    if "obs" not in f:
        return []
    obs = f["obs"]
    order = obs.attrs.get("column-order")
    if order is not None and len(order):
        cols = [c.decode() if isinstance(c, bytes) else str(c) for c in np.asarray(order).tolist()]
        return cols
    idx = obs.attrs.get("_index", "_index")
    idx = idx.decode() if isinstance(idx, bytes) else idx
    return [k for k in obs.keys() if k != idx]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--pattern", default=None, help="override the gene/feature regex")
    ap.add_argument("--show-all", action="store_true", help="also print every obs column per file")
    args = ap.parse_args()

    pat = re.compile(args.pattern, re.IGNORECASE) if args.pattern else DEFAULT_PATTERN
    root = Path(args.folder)
    files = sorted(root.rglob("*.h5ad"))
    if not files:
        sys.exit(f"no .h5ad under {root}")

    missing: list[Path] = []
    errors: list[tuple[Path, str]] = []
    print(f"# {len(files)} files under {root}\n")

    for p in files:
        try:
            with h5py.File(p, "r") as f:
                cols = obs_columns(f)
        except Exception as e:  # noqa: BLE001
            errors.append((p, str(e)))
            print(f"[ERR ] {p.name}\n       {e}")
            continue

        hits = [c for c in cols if pat.search(c)]
        tag = "[ OK ]" if hits else "[MISS]"
        print(f"{tag} {p.name}")
        print(f"       obs {len(cols)} cols; gene/feature-related: {hits or '— none —'}")
        if args.show_all:
            print(f"       all: {cols}")
        if not hits:
            missing.append(p)

    print("\n" + "=" * 70)
    print(f"파일 {len(files)}개 중 obs에 유전자 개수/목록 관련 컬럼이 없는 파일: {len(missing)}개")
    for p in missing:
        print(f"  - {p.name}")
    if errors:
        print(f"\n열지 못한 파일 {len(errors)}개:")
        for p, e in errors:
            print(f"  - {p.name}: {e}")


if __name__ == "__main__":
    main()
