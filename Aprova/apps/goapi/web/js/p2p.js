// Entrega P2P (PeerJS / WebRTC DataChannel) com FALLBACK HTTP RÍGIDO DE 3 SEGUNDOS.
// Porte vanilla de apps/web/src/p2p.ts — mesma semântica, sem TypeScript.
// O PeerJS (UMD global `Peer`) carrega sob demanda para o bundle inicial
// permanecer ultraleve.

const API = window.__MIRA_API__ || "http://localhost:3333/api";
const HOST_PREFIX = "mira-exam-";

export const P2P_FALLBACK_MS = 3000;
const HOST_PAGE_CACHE_LIMIT = 40;

let configPromise = null;
let clientPeerPromise = null;
let clientPeer = null;
let hostPeer = null;
let hostingExamId = null;
let connection = null;
let connecting = null;
let activeExamId = 0;
const linkFailed = new Set();

const pending = new Map();
let requestSeq = 0;

const focusCache = new Map();
const pageSrcCache = new Map();
const hostFocusCache = new Map();
const hostPageCache = new Map();

function withTimeout(promise, ms = P2P_FALLBACK_MS) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`P2P: limite de ${ms}ms atingido`)), ms);
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); }
    );
  });
}

async function loadConfig() {
  configPromise ??= fetch(`${API}/p2p/config`)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  return configPromise;
}

function loadPeerCtor() {
  if (window.Peer) return Promise.resolve(window.Peer);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/assets/vendor/peerjs.min.js";
    script.onload = () => resolve(window.Peer);
    script.onerror = () => reject(new Error("peerjs indisponível"));
    document.head.appendChild(script);
  });
}

async function getClientPeer() {
  if (clientPeer && !clientPeer.destroyed) return clientPeer;
  clientPeerPromise ??= (async () => {
    const config = await loadConfig();
    if (!config) return null;
    try {
      const PeerCtor = await loadPeerCtor();
      const peer = new PeerCtor({ host: config.host, port: config.port, path: config.path, secure: false, debug: 0 });
      const opened = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => { if (settled) return; settled = true; window.clearTimeout(timer); resolve(value); };
        const timer = window.setTimeout(() => finish(false), P2P_FALLBACK_MS);
        peer.once("open", () => finish(true));
        peer.on("error", () => { if (!settled) { try { peer.destroy(); } catch { /* já destruído */ } finish(false); } });
      });
      if (!opened) { try { peer.destroy(); } catch { /* já destruído */ } return null; }
      clientPeer = peer;
      peer.on("close", () => { clientPeer = null; clientPeerPromise = null; connection = null; connecting = null; });
      return peer;
    } catch { return null; }
  })();
  return clientPeerPromise;
}

function ensureConnection(examId) {
  if (connection?.open) return Promise.resolve(connection);
  if (activeExamId === examId && connecting) return connecting;
  activeExamId = examId;
  connecting = (async () => {
    const peer = await getClientPeer();
    if (!peer || hostingExamId === examId || linkFailed.has(examId)) return null;
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        peer.off("error", onPeerError);
        resolve(value);
      };
      const timer = window.setTimeout(() => finish(null), P2P_FALLBACK_MS);
      const onPeerError = (error) => {
        const type = error?.type;
        if (type === "peer-unavailable" || type === "network" || type === "server-error") finish(null);
      };
      peer.on("error", onPeerError);
      let conn;
      try {
        conn = peer.connect(`${HOST_PREFIX}${examId}`, { reliable: true });
      } catch { finish(null); return; }
      conn.once("open", () => {
        if (settled) { try { conn.close(); } catch { /* já fechado */ } return; }
        connection = conn;
        attachInbox(conn, () => { if (connection === conn) connection = null; });
        finish(conn);
      });
      conn.once("error", () => finish(null));
      conn.once("close", () => { if (connection === conn) connection = null; finish(null); });
    });
  })();
  return connecting;
}

function attachInbox(conn, onDead) {
  const drain = (reason) => {
    onDead();
    for (const [, waiter] of pending) waiter.reject(reason ?? new Error("conexão P2P encerrada"));
    pending.clear();
  };
  conn.on("data", (raw) => {
    const message = raw;
    if (!message || typeof message.reqId !== "number") return;
    const waiter = pending.get(message.reqId);
    if (!waiter) return;
    pending.delete(message.reqId);
    if (message.ok) waiter.resolve(message.payload);
    else waiter.reject(new Error(message.error ?? "recusado pelo anfitrião"));
  });
  conn.on("close", () => drain());
  conn.on("error", (error) => drain(error));
}

function request(conn, body) {
  const reqId = ++requestSeq;
  const waiter = new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    try {
      conn.send({ ...body, reqId });
    } catch (error) {
      pending.delete(reqId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const cleanup = window.setTimeout(() => pending.delete(reqId), P2P_FALLBACK_MS);
  return waiter
    .catch((error) => {
      pending.delete(reqId);
      throw error;
    })
    .finally(() => window.clearTimeout(cleanup));
}

export async function getFocusMap(examId) {
  const cached = focusCache.get(examId);
  if (cached) return cached;
  try {
    const map = await withTimeout(
      (async () => {
        const conn = await ensureConnection(examId);
        if (!conn) throw new Error("sem anfitrião P2P");
        return await request(conn, { kind: "focus" });
      })()
    );
    if (!map || typeof map !== "object") throw new Error("mapa inválido");
    focusCache.set(examId, map);
    return map;
  } catch {
    linkFailed.add(examId);
    const map = (await fetch(`${API}/exams/${examId}/focus`).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }));
    focusCache.set(examId, map);
    return map;
  }
}

export async function getPageSrc(examId, page) {
  const key = `${examId}:${page}`;
  const cached = pageSrcCache.get(key);
  if (cached) return cached;
  if (linkFailed.has(examId)) return `${API}/exams/${examId}/pages/${page}`;
  try {
    const bytes = await withTimeout(
      (async () => {
        const conn = await ensureConnection(examId);
        if (!conn) throw new Error("sem anfitrião P2P");
        return await request(conn, { kind: "page", page });
      })()
    );
    if (!bytes || !bytes.byteLength) throw new Error("pacote vazio");
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    pageSrcCache.set(key, url);
    return url;
  } catch {
    linkFailed.add(examId);
    return `${API}/exams/${examId}/pages/${page}`;
  }
}

function hostFocus(examId) {
  const cached = hostFocusCache.get(examId);
  if (cached) return cached;
  const req = fetch(`${API}/exams/${examId}/focus`).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  });
  hostFocusCache.set(examId, req);
  req.catch(() => hostFocusCache.delete(examId));
  return req;
}

function hostPage(examId, page) {
  const key = `${examId}:${page}`;
  const cached = hostPageCache.get(key);
  if (cached) return cached;
  if (hostPageCache.size >= HOST_PAGE_CACHE_LIMIT) {
    const oldest = hostPageCache.keys().next().value;
    if (oldest !== undefined) hostPageCache.delete(oldest);
  }
  const req = fetch(`${API}/exams/${examId}/pages/${page}`)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    });
  hostPageCache.set(key, req);
  req.catch(() => hostPageCache.delete(key));
  return req;
}

function serveConnection(conn, examId) {
  conn.on("data", (raw) => {
    const message = raw;
    if (!message || typeof message.reqId !== "number") return;
    void (async () => {
      try {
        if (message.kind === "focus") {
          conn.send({ reqId: message.reqId, ok: true, payload: await hostFocus(examId) });
        } else if (message.kind === "page") {
          conn.send({ reqId: message.reqId, ok: true, payload: await hostPage(examId, Number(message.page) || 1) });
        } else {
          conn.send({ reqId: message.reqId, ok: false, error: "tipo desconhecido" });
        }
      } catch (error) {
        try { conn.send({ reqId: message.reqId, ok: false, error: error instanceof Error ? error.message : "falha" }); } catch { /* fechou */ }
      }
    })();
  });
}

export async function hostExam(examId) {
  if (hostingExamId === examId && hostPeer && !hostPeer.destroyed) return true;
  await shutdownHost();
  const config = await loadConfig();
  if (!config) return false;
  try {
    const PeerCtor = await loadPeerCtor();
    const peer = new PeerCtor(`${HOST_PREFIX}${examId}`, { host: config.host, port: config.port, path: config.path, secure: false, debug: 0 });
    const opened = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (settled) return; settled = true; window.clearTimeout(timer); resolve(value); };
      const timer = window.setTimeout(() => finish(false), P2P_FALLBACK_MS);
      peer.once("open", () => finish(true));
      peer.once("error", () => { try { peer.destroy(); } catch { /* já destruído */ } finish(false); });
    });
    if (!opened) { try { peer.destroy(); } catch { /* já destruído */ } return false; }
    peer.on("connection", (conn) => serveConnection(conn, examId));
    hostPeer = peer;
    hostingExamId = examId;
    linkFailed.delete(examId);
    return true;
  } catch {
    return false;
  }
}

async function shutdownHost() {
  if (hostPeer) { try { hostPeer.destroy(); } catch { /* já destruído */ } }
  hostPeer = null;
  hostingExamId = null;
}

export async function shutdownP2P() {
  await shutdownHost();
  if (connection) { try { connection.close(); } catch { /* já fechado */ } }
  connection = null;
  connecting = null;
  activeExamId = 0;
  linkFailed.clear();
  for (const waiter of pending.values()) waiter.reject(new Error("P2P encerrado"));
  pending.clear();
  if (clientPeer) { try { clientPeer.destroy(); } catch { /* já destruído */ } }
  clientPeer = null;
  clientPeerPromise = null;
  for (const url of pageSrcCache.values()) URL.revokeObjectURL(url);
  pageSrcCache.clear();
}
