// Headless Chrome harness for controller.html. Serves the project directory
// on a random port, replaces fetch() with a fake bridge before controller.js
// runs, and lets tests evaluate code in the page. Needs Google Chrome
// (set CHROME=/path/to/chrome if it is not "google-chrome" on PATH).
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHROME = process.env.CHROME || "google-chrome";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_BRIDGE = `
  window.__bridge = { delays: {}, failures: {}, offline: false, calls: [], dialogs: [], pending: new Set() };
  window.alert = (message) => window.__bridge.dialogs.push(String(message));
  window.confirm = () => true;
  window.prompt = (message, value) => value;
  window.fetch = async (url, options = {}) => {
    const b = window.__bridge;
    const path = String(url).split("?")[0];
    const call = { path, body: options.body || null, start: performance.now(), end: null };
    b.calls.push(call);
    if (b.offline) throw new TypeError("Failed to fetch");
    if (path === "/stop-speech" || path === "/stop-motion") {
      b.pending.forEach((finish) => finish());
      b.pending.clear();
    }
    await new Promise((resolve) => {
      const timer = setTimeout(done, b.delays[path] || 0);
      function done() { clearTimeout(timer); b.pending.delete(done); resolve(); }
      b.pending.add(done);
    });
    call.end = performance.now();
    if (b.failures[path]) return new Response(b.failures[path], { status: 500 });
    if (path === "/status") {
      return new Response(JSON.stringify({ connected: false, reconnecting: false, attempts: 0, awake: null,
        battery: null, charging: null, lastError: null, hostIp: null, pepperIp: null }));
    }
    return new Response(JSON.stringify({ success: true }));
  };`;

const PAGE_HELPERS = `
  window.__t = {
    load(steps) {
      timelineSteps = steps.map((step) => step.map((block) => ({ ...block, id: nextBlockId() })));
      resetBlockStates();
      renderTimeline();
      return timelineSteps.map((step) => step.map((block) => block.id));
    },
    shape() {
      return timelineSteps.map((step) => step.map((block) => block.type));
    },
    fire(el, type, dataTransfer) {
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    },
    drag(blockId, target) {
      const source = document.querySelector('.timeline-block[data-id="' + blockId + '"]');
      const dt = new DataTransfer();
      this.fire(source, "dragstart", dt);
      this.fire(target, "dragenter", dt);
      this.fire(target, "dragover", dt);
      const zone = target.closest(".timeline-step, .timeline-gap");
      const classes = zone ? zone.className : "";
      this.fire(target, "drop", dt);
      this.fire(source, "dragend", dt);
      return classes;
    },
    dragForeign(target) {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "photo.png", { type: "image/png" }));
      this.fire(target, "dragenter", dt);
      this.fire(target, "dragover", dt);
      this.fire(target, "drop", dt);
    },
  };`;

function startServer() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^[/\\]+/, "");
    const file = join(ROOT, path || "controller.html");
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function launchChrome() {
  const dir = await mkdtemp(join(tmpdir(), "pepper-page-test-"));
  const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
  proc.on("error", (error) => { throw new Error(`Could not start Chrome (${CHROME}): ${error.message}`); });
  const portFile = join(dir, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) throw new Error("Chrome did not start (no DevToolsActivePort)");
  const port = readFileSync(portFile, "utf8").split("\n")[0].trim();
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    page = targets.find((t) => t.type === "page");
    if (!page) await sleep(100);
  }
  return { proc, dir, wsUrl: page.webSocketDebuggerUrl };
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      data.error ? reject(new Error(data.error.message)) : resolve(data.result);
    } else if (data.method && listeners.has(data.method)) {
      listeners.get(data.method).forEach((listener) => listener(data.params));
    }
  };
  return {
    send(method, params = {}) {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(listener);
    },
    once(method) {
      return new Promise((resolve) => this.on(method, resolve));
    },
    close() {
      ws.close();
    },
  };
}

export async function openControllerPage() {
  const server = await startServer();
  const chrome = await launchChrome();
  const cdp = await connectCdp(chrome.wsUrl);
  const exceptions = [];
  cdp.on("Runtime.exceptionThrown", (p) =>
    exceptions.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text));
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_BRIDGE + PAGE_HELPERS });
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/controller.html` });
  await loaded;

  async function evaluate(source) {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${source} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }

  async function close() {
    cdp.close();
    const exited = new Promise((resolve) => chrome.proc.once("exit", resolve));
    chrome.proc.kill();
    await exited;
    server.close();
    await rm(chrome.dir, { recursive: true, force: true });
  }

  return { evaluate, exceptions, close };
}
