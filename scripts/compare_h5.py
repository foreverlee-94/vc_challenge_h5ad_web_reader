"""Side-by-side format comparison of two or more HDF5 / h5ad files.

    uv run python scripts/compare_h5.py context_A.h5ad "C:/.../hepg2.h5"

Reports the AnnData-spec facts that actually differ between files: X storage,
compression, index encoding, dtypes, column counts. Uses h5py only.
"""

from __future__ import annotations

import sys
from pathlib import Path

import h5py
import numpy as np


def _a(v):
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    if isinstance(v, np.ndarray):
        return [_a(x) for x in v.tolist()]
    if isinstance(v, np.generic):
        return v.item()
    return v


def attrs(o):
    return {k: _a(v) for k, v in o.attrs.items()}


def compression_set(f: h5py.File) -> set[str]:
    seen: set[str] = set()

    def visit(_name, obj):
        if isinstance(obj, h5py.Dataset):
            seen.add(str(obj.compression))

    f.visititems(visit)
    return seen


def index_encoding(g: h5py.Group):
    name = attrs(g).get("_index", "_index")
    if name not in g:
        return name, "missing"
    node = g[name]
    if isinstance(node, h5py.Group):
        return name, "group:" + str(attrs(node).get("encoding-type"))
    return name, "dataset:" + str(attrs(node).get("encoding-type"))


def profile(path: str) -> dict:
    p = Path(path)
    with h5py.File(p, "r") as f:
        root = attrs(f)
        X = f["X"] if "X" in f else None
        if isinstance(X, h5py.Group):
            xenc = attrs(X).get("encoding-type")
            xshape = [int(x) for x in attrs(X)["shape"]]
            xd = X["data"]
            xdesc = f"{xenc}  data.dtype={xd.dtype}  chunks={xd.chunks}"
            nnz = int(X["indptr"][-1])
            dens = f"{nnz / (xshape[0] * xshape[1]):.3f}"
        elif isinstance(X, h5py.Dataset):
            xenc = attrs(X).get("encoding-type")
            xshape = list(X.shape)
            xdesc = f"{xenc} (dense)  dtype={X.dtype}  chunks={X.chunks}"
            nnz = dens = "-"
        else:
            xenc = xshape = xdesc = nnz = dens = "-"

        obs = f["obs"] if "obs" in f else None
        var = f["var"] if "var" in f else None
        obs_i = index_encoding(obs) if obs is not None else ("-", "-")
        var_i = index_encoding(var) if var is not None else ("-", "-")
        obs_cols = list(_a(attrs(obs).get("column-order", []))) if obs is not None else []
        var_cols = list(_a(attrs(var).get("column-order", []))) if var is not None else []

        mappings = {
            m: (list(f[m].keys()) if m in f and isinstance(f[m], h5py.Group) else "-")
            for m in ("layers", "obsm", "varm", "obsp", "varp", "uns")
        }

        return {
            "file": p.name,
            "size_mb": round(p.stat().st_size / 1e6, 1),
            "root_encoding": f"{root.get('encoding-type')} {root.get('encoding-version')}",
            "X": xdesc,
            "X_shape": xshape,
            "X_nnz": nnz,
            "X_density": dens,
            "compression": sorted(compression_set(f)),
            "obs_index": f"{obs_i[0]!r} → {obs_i[1]}",
            "var_index": f"{var_i[0]!r} → {var_i[1]}",
            "n_obs_cols": len(obs_cols),
            "obs_cols": obs_cols,
            "n_var_cols": len(var_cols),
            "nonempty_mappings": [m for m, v in mappings.items() if v not in ("-", [], None)],
            "raw": "raw" in f,
        }


ROWS = [
    ("file", "file"),
    ("size", "size_mb"),
    ("root encoding", "root_encoding"),
    ("X storage", "X"),
    ("X shape", "X_shape"),
    ("X nnz", "X_nnz"),
    ("X density", "X_density"),
    ("compression (all datasets)", "compression"),
    ("obs index encoding", "obs_index"),
    ("var index encoding", "var_index"),
    ("# obs columns", "n_obs_cols"),
    ("obs columns", "obs_cols"),
    ("# var columns", "n_var_cols"),
    ("non-empty layers/obsm/…", "nonempty_mappings"),
    ("raw present", "raw"),
]


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit("usage: compare_h5.py <fileA> <fileB> [<fileC> ...]")
    profs = [profile(p) for p in sys.argv[1:]]
    label_w = max(len(lbl) for lbl, _ in ROWS)
    for lbl, key in ROWS:
        print(lbl.ljust(label_w), end="  ")
        print("   |   ".join(str(pr.get(key)) for pr in profs))


if __name__ == "__main__":
    main()
