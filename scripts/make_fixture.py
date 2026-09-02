"""Build a tiny .h5ad exercising many AnnData encodings, for reader tests.

  uv run python scripts/make_fixture.py scratchpad/fixture.h5ad

Small (a few hundred KB) so it can be fetched by the browser diagnostic and
round-tripped in CI. NOT shipped on the Pages site.
"""

from __future__ import annotations

import sys
from pathlib import Path

import anndata as ad
import numpy as np
import pandas as pd
import scipy.sparse as sp

rng = np.random.default_rng(0)
N, G = 200, 120

X = sp.random(N, G, density=0.2, format="csr", dtype=np.float32, random_state=0)
X.data = np.ceil(X.data * 10).astype(np.float32)

obs = pd.DataFrame(
    {
        "cell_type": pd.Categorical(rng.choice(["T", "B", "NK", "Mono"], N)),
        "batch": pd.Categorical(rng.choice(["b1", "b2"], N), ordered=True),
        "n_counts": rng.integers(500, 5000, N).astype("int32"),
        "qc_frac": rng.random(N).astype("float64"),
        "flagged": rng.random(N) > 0.7,
        "score_nullable": pd.array(
            rng.integers(0, 5, N).astype("float64"), dtype="Int32"
        ),
    },
    index=[f"cell_{i:04d}" for i in range(N)],
)
obs.loc[obs.index[:5], "score_nullable"] = pd.NA

var = pd.DataFrame(
    {
        "gene_symbol": [f"GENE{i}" for i in range(G)],
        "highly_variable": rng.random(G) > 0.5,
    },
    index=[f"ENSG{i:06d}" for i in range(G)],
)

adata = ad.AnnData(X=X, obs=obs, var=var)
adata.layers["counts"] = X.copy()
adata.layers["dense_log1p"] = np.log1p(X.toarray()).astype(np.float32)
adata.obsm["X_pca"] = rng.random((N, 10)).astype("float32")
adata.obsm["X_umap"] = rng.random((N, 2)).astype("float32")
adata.varm["loadings"] = rng.random((G, 10)).astype("float32")
adata.obsp["distances"] = sp.random(N, N, density=0.05, format="csr", dtype=np.float32)
adata.uns["title"] = "fixture dataset"
adata.uns["n_neighbors"] = 15
adata.uns["params"] = {"method": "umap", "seed": 0, "alpha": 1.5}
adata.uns["color_map"] = np.array(["#ff0000", "#00ff00", "#0000ff"])

out = Path(sys.argv[1] if len(sys.argv) > 1 else "scratchpad/fixture.h5ad")
out.parent.mkdir(parents=True, exist_ok=True)
adata.write_h5ad(out, compression="gzip")
print(f"wrote {out} ({out.stat().st_size / 1024:.1f} KB)")
