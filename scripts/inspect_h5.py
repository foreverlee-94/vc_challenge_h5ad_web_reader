"""Deep structural inspector for any HDF5 file — classifies the format and
dumps the group/dataset tree with encodings, dtypes, compression and a few
sample values. Works on .h5ad, legacy AnnData .h5, 10x CellRanger .h5, Loom, or
plain HDF5.

    uv run python scripts/inspect_h5.py "<path>" [--values] [--max-depth N]

Written for comparing the challenge's `*.h5` support files against the
`context_*.h5ad` panel files. No dependency on anndata.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import h5py
import numpy as np


def _attr(v):
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    if isinstance(v, np.ndarray):
        return [_attr(x) for x in v.tolist()]
    if isinstance(v, np.generic):
        return v.item()
    return v


def attrs_of(obj) -> dict:
    return {k: _attr(v) for k, v in obj.attrs.items()}


def classify(f: h5py.File) -> str:
    root = attrs_of(f)
    keys = set(f.keys())
    enc = root.get("encoding-type")
    if enc == "anndata":
        ver = root.get("encoding-version", "?")
        # modern spec tags every node; legacy (<=0.6) does not
        tagged = "encoding-type" in f["obs"].attrs if "obs" in f else False
        return f"AnnData .h5ad (spec, root encoding-version {ver}, per-node encodings: {'yes' if tagged else 'no'})"
    if {"matrix"} <= keys and "matrix" in f and {"data", "indices", "indptr", "shape"} <= set(f["matrix"].keys()):
        return "10x Genomics CellRanger HDF5 (/matrix group)"
    if {"X", "obs", "var"} <= keys and enc is None:
        return "Legacy AnnData .h5 (pre-encoding-type spec, ~anndata <= 0.6)"
    if "row_attrs" in keys and "col_attrs" in keys and "matrix" in keys:
        return "Loom file"
    return "Plain / unknown HDF5"


def describe_dataset(ds: h5py.Dataset, want_values: bool) -> dict:
    enc = attrs_of(ds).get("encoding-type")
    info = {
        "kind": "dataset",
        "encoding": enc,
        "shape": list(ds.shape),
        "dtype": str(ds.dtype),
        "compression": ds.compression,
        "chunks": ds.chunks,
    }
    if want_values and ds.size and ds.ndim <= 1:
        try:
            head = ds[: min(5, ds.shape[0] if ds.ndim else 1)]
            info["sample"] = [_attr(x) for x in (head.tolist() if hasattr(head, "tolist") else [head])]
        except Exception as e:  # noqa: BLE001
            info["sample"] = f"<{e}>"
    return info


def walk(obj, depth: int, max_depth: int, want_values: bool):
    out = {"attrs": attrs_of(obj)}
    if isinstance(obj, h5py.Group):
        out["kind"] = "group"
        out["encoding"] = out["attrs"].get("encoding-type")
        if depth >= max_depth:
            out["children"] = f"<{len(obj)} keys, max-depth>"
        else:
            out["children"] = {k: walk(obj[k], depth + 1, max_depth, want_values) for k in obj.keys()}
    else:
        out.update(describe_dataset(obj, want_values))
    return out


def render(node, name: str, indent: str = "") -> None:
    if node["kind"] == "group":
        enc = f"  ({node['encoding']})" if node.get("encoding") else ""
        n = node["children"] if isinstance(node["children"], str) else f"{len(node['children'])} keys"
        print(f"{indent}[G] {name}{enc}  {n}")
        for k, v in (node["attrs"] or {}).items():
            if k not in ("encoding-type", "encoding-version"):
                print(f"{indent}     · {k} = {v}")
        if isinstance(node["children"], dict):
            for k, v in node["children"].items():
                render(v, k, indent + "  ")
    else:
        bits = [f"shape={tuple(node['shape'])}", f"dtype={node['dtype']}"]
        if node.get("encoding"):
            bits.append(f"enc={node['encoding']}")
        bits.append(f"comp={node['compression']}")
        if node.get("sample") is not None:
            s = node["sample"]
            bits.append(f"sample={s}")
        print(f"{indent}[D] {name}  " + "  ".join(bits))


def summary(f: h5py.File) -> None:
    print("\n=== QUICK READ (AnnData-style) ===")
    try:
        X = f["X"]
        if isinstance(X, h5py.Group):
            enc = attrs_of(X).get("encoding-type")
            shape = [int(x) for x in attrs_of(X)["shape"]]
            nnz = int(X["indptr"][-1])
            print(f"X: {enc}  shape={shape}  nnz={nnz}  density={nnz / (shape[0] * shape[1]):.4f}  "
                  f"data.dtype={X['data'].dtype}  compression={X['data'].compression}")
        else:
            print(f"X: dense array  shape={tuple(X.shape)}  dtype={X.dtype}  compression={X.compression}  "
                  f"chunks={X.chunks}")
            block = X[: min(200, X.shape[0]), : min(200, X.shape[1])]
            print(f"   sample block min={block.min():.3f} max={block.max():.3f} "
                  f"mean={block.mean():.3f} zeros={(block == 0).mean():.2%}")
    except Exception as e:  # noqa: BLE001
        print("X: <", e, ">")

    for axis in ("obs", "var"):
        if axis not in f:
            continue
        g = f[axis]
        a = attrs_of(g)
        idx = a.get("_index", "_index")
        cols = a.get("column-order", [])
        cols = [c for c in cols] if isinstance(cols, list) else list(cols)
        node = g[idx] if idx in g else None
        idx_kind = ("group:" + str(attrs_of(node).get("encoding-type"))) if isinstance(node, h5py.Group) else (
            "dataset:" + str(attrs_of(node).get("encoding-type")) if node is not None else "?")
        n = node["values"].shape[0] if isinstance(node, h5py.Group) and "values" in node else (
            node.shape[0] if node is not None else "?")
        print(f"{axis}: index={idx!r} ({idx_kind}) n={n}  columns({len(cols)})={cols}")
        for c in cols:
            if c not in g:
                continue
            cn = g[c]
            if isinstance(cn, h5py.Group):
                ce = attrs_of(cn).get("encoding-type")
                extra = ""
                if ce == "categorical" and "categories" in cn:
                    cats = cn["categories"][:5]
                    extra = f" cats[{cn['categories'].shape[0]}]={[_attr(x) for x in cats.tolist()]}"
                print(f"   - {c}: {ce}{extra}")
            else:
                print(f"   - {c}: {attrs_of(cn).get('encoding-type')} dtype={cn.dtype}")

    for m in ("layers", "obsm", "varm", "obsp", "varp"):
        if m in f and isinstance(f[m], h5py.Group):
            print(f"{m}: {list(f[m].keys()) or '(empty)'}")
    if "uns" in f:
        print(f"uns: {list(f['uns'].keys()) or '(empty)'}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--values", action="store_true", help="include sample values for 1-D datasets")
    ap.add_argument("--max-depth", type=int, default=6)
    args = ap.parse_args()

    p = Path(args.path)
    print(f"# {p}  ({p.stat().st_size / 1e6:.1f} MB)")
    with h5py.File(p, "r") as f:
        print("format:", classify(f))
        print("root attrs:", attrs_of(f))
        print("\n=== TREE ===")
        for k in f.keys():
            render(walk(f[k], 1, args.max_depth, args.values), k)
        summary(f)


if __name__ == "__main__":
    main()
