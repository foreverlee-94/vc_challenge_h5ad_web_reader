// Headless diagnostic: run the real worker pipeline against ./fixture.h5ad and
// dump every step + any error into #log. Not part of the app.
const logEl = document.getElementById("log");
const log = (...a) => {
  logEl.textContent += a.join(" ") + "\n";
};
window.onerror = (m, s, l, c, e) => log("window.onerror:", m, "@", s + ":" + l, e && e.stack ? e.stack : "");
window.onunhandledrejection = (ev) => log("unhandledrejection:", ev.reason && ev.reason.stack ? ev.reason.stack : ev.reason);

const DONE = () => {
  logEl.textContent += "\n__DIAG_DONE__\n";
};

try {
  log("1. creating worker");
  const worker = new Worker(new URL("./js/worker.mjs", import.meta.url), { type: "module" });
  worker.onerror = (e) => {
    log("worker.onerror:", e.message || "(no message)", "@", (e.filename || "") + ":" + (e.lineno || ""));
    DONE();
  };
  worker.onmessageerror = (e) => log("worker.onmessageerror", JSON.stringify(e.data));

  let bootSeen = false;
  const pending = new Map();
  let seq = 0;
  worker.onmessage = (ev) => {
    const { id, ok, result, error, progress } = ev.data || {};
    if (id == null && progress === undefined) {
      bootSeen = true;
      log("2. worker boot ping:", JSON.stringify(result));
      return;
    }
    if (progress !== undefined) {
      log("   [worker progress]", progress);
      return;
    }
    const p = pending.get(id);
    if (p) {
      pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    }
  };
  const call = (type, payload) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, payload });
    });

  log("3. fetching ./fixture.h5ad");
  const resp = await fetch(new URL("./fixture.h5ad", import.meta.url));
  log("   fetch status", resp.status, resp.headers.get("content-type"), resp.headers.get("content-length"));
  const blob = await resp.blob();
  const file = new File([blob], "fixture.h5ad", { type: "application/octet-stream" });
  log("   File", file.name, file.size, "bytes");

  log("4. calling worker open (timeout 20s)");
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("open() timed out after 20s")), 20000));
  const info = await Promise.race([call("open", { file }), timeout]);
  log("5. open OK");
  log("   n_obs/n_vars:", info.summary.n_obs, "/", info.summary.n_vars);
  log("   X:", JSON.stringify(info.summary.X));
  log("   obs cols:", info.summary.obs.columns.map((c) => c.name + ":" + c.kind).join(", "));
  log("   layers:", Object.keys(info.summary.layers).join(", "));
  log("   obsm:", Object.keys(info.summary.obsm).join(", "));
  log("   uns keys:", Object.keys(info.summary.uns).join(", "));
  log("6. SUCCESS");
} catch (err) {
  log("CAUGHT:", err && err.stack ? err.stack : String(err));
}
DONE();
