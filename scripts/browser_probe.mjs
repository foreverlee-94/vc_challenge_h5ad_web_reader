// Minimal headless-Chrome driver over CDP (no deps; Node global WebSocket).
// Opens a dedicated tab, streams console/errors/exceptions, waits, prints #log.
//
//   node scripts/browser_probe.mjs http://localhost:8199/diag.html [waitMs]

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2];
const waitMs = Number(process.argv[3] || 30000);
if (!url) {
  console.error("usage: node scripts/browser_probe.mjs <url> [waitMs]");
  process.exit(1);
}

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const port = 9222 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "cdp-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--disable-extensions",
   `--window-size=${process.env.WIN || "1440,960"}`,
   `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"],
  { stdio: "ignore" },
);

async function http(path, method = "GET") {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method });
      return await r.json();
    } catch (_) {
      await sleep(200);
    }
  }
  throw new Error("devtools endpoint unreachable: " + path);
}

// wait for devtools, then open a tab for our url
await http("/json/version");
let tab;
try {
  tab = await http(`/json/new?${encodeURIComponent(url)}`, "PUT");
} catch (_) {
  tab = await http(`/json/new?${encodeURIComponent(url)}`, "GET");
}
if (!tab.webSocketDebuggerUrl) throw new Error("no ws url for tab: " + JSON.stringify(tab));

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("ws connect failed"));
});

let id = 0;
const pendings = new Map();
function cmd(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res) => pendings.set(mid, res));
}

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pendings.has(m.id)) {
    pendings.get(m.id)(m.result);
    pendings.delete(m.id);
    return;
  }
  if (m.method === "Runtime.consoleAPICalled") {
    const a = (m.params.args || []).map((x) => (x.value !== undefined ? x.value : x.description ?? "")).join(" ");
    console.log(`  [console.${m.params.type}] ${a}`);
  } else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    console.log(`  [exception] ${d.exception?.description || d.text}`);
  } else if (m.method === "Log.entryAdded") {
    console.log(`  [log.${m.params.entry.level}] ${m.params.entry.text}`);
  }
};

await cmd("Runtime.enable");
await cmd("Log.enable");
await cmd("Page.enable");
await cmd("DOM.enable");

const setFile = process.env.SETFILE;
console.log(`opened ${url} ; waiting ${waitMs}ms` + (setFile ? ` ; will set #file=${setFile}` : ""));

if (setFile) {
  await sleep(3000);
  const { root } = await cmd("DOM.getDocument", { depth: -1 });
  const { nodeId } = await cmd("DOM.querySelector", { nodeId: root.nodeId, selector: "#file" });
  await cmd("DOM.setFileInputFiles", { files: [setFile.replace(/\//g, "\\")], nodeId });
  console.log("  set #file input");
  await sleep(waitMs - 3000);
} else {
  await sleep(waitMs);
}

const dump = async (sel) => {
  const r = await cmd("Runtime.evaluate", {
    expression: `(document.querySelector(${JSON.stringify(sel)})||{}).textContent || "(no ${sel})"`,
    returnByValue: true,
  });
  return r?.result?.value ?? "(nothing)";
};
console.log("\n===== #log =====\n" + (await dump("#log")));
console.log("\n===== #status =====\n" + (await dump("#status")));

if (process.env.EVAL) {
  const r = await cmd("Runtime.evaluate", { expression: process.env.EVAL, returnByValue: true, awaitPromise: true });
  console.log("\n===== EVAL =====\n" + JSON.stringify(r?.result?.value ?? r?.exceptionDetails ?? "(nothing)", null, 2));
} else {
  console.log("\n===== #report =====\n" + (await dump("#report")));
}

if (process.env.SHOT) {
  const { writeFileSync } = await import("node:fs");
  const r = await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  if (r && r.data) {
    writeFileSync(process.env.SHOT, Buffer.from(r.data, "base64"));
    console.log("\nscreenshot -> " + process.env.SHOT);
  }
}

ws.close();
chrome.kill();
process.exit(0);
