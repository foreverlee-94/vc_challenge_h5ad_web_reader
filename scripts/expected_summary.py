"""Reference summary of an .h5ad file, computed with anndata/h5py.

Used as the oracle for validating the browser-side reader (docs/js/anndata.mjs).
Run:  uv run python scripts/expected_summary.py context_A.h5ad
Output: JSON on stdout.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import h5py
import numpy as np


def describe_dataset(ds: h5py.Dataset) -> dict:
    return {
        "kind": "dataset",
        "shape": list(ds.shape),
        "dtype": str(ds.dtype),
        "compression": ds.compression,
    }


def summarize_dataframe(grp: h5py.Group) -> dict:
    attrs = dict(grp.attrs)
    index_key = attrs.get("_index", "_index")
    if isinstance(index_key, bytes):
        index_key = index_key.decode()
    col_order = [c.decode() if isinstance(c, bytes) else c for c in attrs.get("column-order", [])]

    cols = {}
    for name in grp.keys():
        node = grp[name]
        enc = node.attrs.get("encoding-type")
        if isinstance(enc, bytes):
            enc = enc.decode()
        info: dict = {"encoding": enc}
        if isinstance(node, h5py.Group):
            if enc == "categorical":
                cats = node["categories"][:]
                cats = [c.decode() if isinstance(c, bytes) else c for c in cats]
                codes = node["codes"][:]
                counts = np.bincount(codes[codes >= 0], minlength=len(cats)).tolist()
                info.update(
                    n_categories=len(cats),
                    categories=cats[:50],
                    value_counts=dict(zip(cats[:50], counts[:50])),
                    n_missing=int((codes < 0).sum()),
                )
            elif enc in ("nullable-integer", "nullable-boolean", "nullable-string-array", "string-array"):
                values = node["values"]
                info.update(length=int(values.shape[0]), values_dtype=str(values.dtype))
                if "mask" in node:
                    info["n_missing"] = int(np.asarray(node["mask"][:]).sum())
            else:
                info["keys"] = list(node.keys())
        else:  # plain dataset column
            info.update(describe_dataset(node))
            if np.issubdtype(node.dtype, np.number):
                arr = node[:]
                info["stats"] = {
                    "min": float(np.nanmin(arr)),
                    "max": float(np.nanmax(arr)),
                    "mean": float(np.nanmean(arr)),
                }
        cols[name] = info

    return {
        "encoding": "dataframe",
        "index_key": index_key,
        "column_order": col_order,
        "n_rows": grp[col_order[0]]["codes"].shape[0]
        if col_order and isinstance(grp[col_order[0]], h5py.Group) and "codes" in grp[col_order[0]]
        else None,
        "columns": cols,
    }


def summarize_matrix(node) -> dict:
    if isinstance(node, h5py.Group):
        enc = node.attrs.get("encoding-type")
        if isinstance(enc, bytes):
            enc = enc.decode()
        shape = [int(x) for x in node.attrs["shape"]]
        indptr = node["indptr"]
        nnz = int(indptr[-1])
        return {
            "encoding": enc,
            "shape": shape,
            "nnz": nnz,
            "density": nnz / (shape[0] * shape[1]),
            "data_dtype": str(node["data"].dtype),
        }
    return {
        "encoding": "array",
        "shape": list(node.shape),
        "dtype": str(node.dtype),
    }


def summarize_mapping(grp: h5py.Group) -> dict:
    out = {}
    for name in grp.keys():
        node = grp[name]
        if isinstance(node, h5py.Group):
            enc = node.attrs.get("encoding-type")
            if isinstance(enc, bytes):
                enc = enc.decode()
            if enc in ("csr_matrix", "csc_matrix"):
                out[name] = summarize_matrix(node)
            else:
                out[name] = {"encoding": enc or "group", "keys": list(node.keys())}
        else:
            out[name] = describe_dataset(node)
    return out


def walk_uns(grp, depth=0, max_depth=6):
    if depth >= max_depth:
        return "<max-depth>"
    if isinstance(grp, h5py.Group):
        return {k: walk_uns(grp[k], depth + 1, max_depth) for k in grp.keys()}
    if grp.shape == ():
        v = grp[()]
        return v.decode() if isinstance(v, bytes) else v.item() if hasattr(v, "item") else v
    return {"kind": "dataset", "shape": list(grp.shape), "dtype": str(grp.dtype)}


def main(path: str) -> None:
    p = Path(path)
    with h5py.File(p, "r") as f:
        out = {
            "file": {"name": p.name, "size": p.stat().st_size},
            "encoding": f.attrs.get("encoding-type", b"").decode()
            if isinstance(f.attrs.get("encoding-type"), bytes)
            else f.attrs.get("encoding-type"),
            "X": summarize_matrix(f["X"]) if "X" in f else None,
            "obs": summarize_dataframe(f["obs"]) if "obs" in f else None,
            "var": summarize_dataframe(f["var"]) if "var" in f else None,
        }
        for key in ("layers", "obsm", "varm", "obsp", "varp"):
            if key in f and isinstance(f[key], h5py.Group):
                out[key] = summarize_mapping(f[key])
        if "uns" in f:
            out["uns"] = walk_uns(f["uns"])
        if out.get("X") and out["obs"]:
            out["n_obs"], out["n_vars"] = out["X"]["shape"]

    json.dump(out, sys.stdout, indent=2, default=str)
    print()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python scripts/expected_summary.py <file.h5ad>")
    main(sys.argv[1])
