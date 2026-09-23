// Entrega P2P (PeerJS / WebRTC DataChannel) com FALLBACK HTTP RÍGIDO DE 3 SEGUNDOS.
//
// Arquitetura híbrida do Mira:
//   - Servidor: OCR + geometria + imagens JPEG (única fonte de dados).
//   - P2P: transferência do JSON de metadados (y_inicio normalizado) e dos
//     pacotes de imagens entre usuários, direto pelo DataChannel.
//   - Se o P2P falhar (firewall/NAT/sinalização fora), tudo cai no HTTP do
//     servidor em no máximo 3s — nunca trava a prova.
//
// O PeerJS é importado dinamicamente: o bundle inicial do frontend permanece
// ultraleve (o chunk do WebRTC só baixa quando há tentativa P2P).

import type { DataConnection, Peer } from "peerjs";

export type FocusEntry = { page: number; y_inicio: number; x_center: number; focus_scale: number };
export type FocusMap = Record<string, FocusEntry>;

const API = "http://localhost:3333/api";
const HOST_PREFIX = "mira-exam-";

/** Prazo rígido: depois disso, resposta HTTP do servidor. */
export const P2P_FALLBACK_MS = 3000;

/** Cache do lado anfitrião: limite de pacotes de imagem mantidos em memória. */
const HOST_PAGE_CACHE_LIMIT = 40;

type P2PConfig = { host: string; port: number; path: string };
type Pending = { resolve: (value: unknown) => void; reject: (reason?: unknown) => void };
type InboxMessage = { reqId?: number; ok?: boolean; payload?: unknown; error?: string };

let configPromise: Promise<P2PConfig | null> | null = null;
let clientPeerPromise: Promise<Peer | null> | null = null;
let clientPeer: Peer | null = null;
let hostPeer: Peer | null = null;
let hostingExamId: number | null = null;
let connection: DataConnection | null = null;
let connecting: Promise<DataConnection | null> | null = null;
let activeExamId = 0;
/** Falha de ligação neste exame? Se sim, os próximos pedidos vão direto ao HTTP. */
const linkFailed = new Set<number>();

const pending = new Map<number, Pending>();
let requestSeq = 0;

const focusCache = new Map<number, FocusMap>();
const pageSrcCache = new Map<string, string>();
const hostFocusCache = new Map<number, Promise<FocusMap>>();
const hostPageCache = new Map<string, Promise<ArrayBuffer>>();

function withTimeout<T>(promise: Promise<T>, ms: number = P2P_FALLBACK_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`P2P: limite de ${ms}ms atingido`)), ms);
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); }
    );
  });
}

async function loadConfig(): Promise<P2PConfig | null> {
  configPromise ??= fetch(`${API}/p2p/config`)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  return configPromise;
}

/** Peer cliente compartilhado (id automático) — só para CONNECTIONS de saída. */
async function getClientPeer(): Promise<Peer | null> {
  if (clientPeer && !clientPeer.destroyed) return clientPeer;
  clientPeerPromise ??= (async () => {
    const config = await loadConfig();
    if (!config) return null;
    try {
      const { Peer: PeerCtor } = await import("peerjs");
      const peer = new PeerCtor({ host: config.host, port: config.port, path: config.path, secure: false, debug: 0 });
      const opened = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean) => { if (settled) return; settled = true; window.clearTimeout(timer); resolve(value); };
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

/** Conexão de dados (reutilizada) com o anfitrião desta prova. */
function ensureConnection(examId: number): Promise<DataConnection | null> {
  if (connection?.open) return Promise.resolve(connection);
  if (activeExamId === examId && connecting) return connecting;
  activeExamId = examId;
  connecting = (async () => {
    const peer = await getClientPeer();
    // Somos o anfitrião desta prova? Evita loopback: direto ao HTTP.
    if (!peer || hostingExamId === examId || linkFailed.has(examId)) return null;
    return await new Promise<DataConnection | null>((resolve) => {
      let settled = false;
      const finish = (value: DataConnection | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        peer.off("error", onPeerError);
        resolve(value);
      };
      const timer = window.setTimeout(() => finish(null), P2P_FALLBACK_MS);
      // peer-unavailable = ninguém hospedando / NAT bloqueou → fallback HTTP.
      const onPeerError = (error: unknown) => {
        const type = (error as { type?: string } | null)?.type;
        if (type === "peer-unavailable" || type === "network" || type === "server-error") finish(null);
      };
      peer.on("error", onPeerError);
      let conn: DataConnection;
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

/** Despacha respostas recebidas para o pedido correspondente. */
function attachInbox(conn: DataConnection, onDead: () => void): void {
  const drain = (reason?: unknown) => {
    onDead();
    for (const [, waiter] of pending) waiter.reject(reason ?? new Error("conexão P2P encerrada"));
    pending.clear();
  };
  conn.on("data", (raw) => {
    const message = raw as InboxMessage;
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

/** Pedido com prazo rígido: o cache `pending` é limpo mesmo no estouro do tempo. */
function request<T>(conn: DataConnection, body: Record<string, unknown>): Promise<T> {
  const reqId = ++requestSeq;
  const waiter = new Promise<T>((resolve, reject) => {
    pending.set(reqId, { resolve: resolve as (value: unknown) => void, reject });
    try {
      conn.send({ ...body, reqId });
    } catch (error) {
      pending.delete(reqId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  // Auto-limpeza: se a resposta nunca chegar, o `pending` não vaza memória.
  const cleanup = window.setTimeout(() => pending.delete(reqId), P2P_FALLBACK_MS);
  return waiter
    .catch((error) => {
      pending.delete(reqId);
      throw error;
    })
    .finally(() => window.clearTimeout(cleanup));
}

/** JSON de metadados normalizados da prova: P2P → fallback HTTP (3s). */
export async function getFocusMap(examId: number): Promise<FocusMap> {
  const cached = focusCache.get(examId);
  if (cached) return cached;
  try {
    const map = await withTimeout(
      (async () => {
        const conn = await ensureConnection(examId);
        if (!conn) throw new Error("sem anfitrião P2P");
        return await request<FocusMap>(conn, { kind: "focus" });
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
    })) as FocusMap;
    focusCache.set(examId, map);
    return map;
  }
}

/**
 * Pacote de imagem da página: DataChannel P2P (ArrayBuffer via BinaryPack) →
 * fallback HTTP rígido de 3s, devolvendo a URL direta do servidor.
 */
export async function getPageSrc(examId: number, page: number): Promise<string> {
  const key = `${examId}:${page}`;
  const cached = pageSrcCache.get(key);
  if (cached) return cached;
  if (linkFailed.has(examId)) return `${API}/exams/${examId}/pages/${page}`;
  try {
    const bytes = await withTimeout(
      (async () => {
        const conn = await ensureConnection(examId);
        if (!conn) throw new Error("sem anfitrião P2P");
        return await request<ArrayBuffer>(conn, { kind: "page", page });
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

// ---------------------------------------------------------------------------
// Lado ANFITRIÃO: serve o JSON de metadados e os pacotes de imagens aos peers.
// ---------------------------------------------------------------------------

function hostFocus(examId: number): Promise<FocusMap> {
  const cached = hostFocusCache.get(examId);
  if (cached) return cached;
  const request = fetch(`${API}/exams/${examId}/focus`).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as Promise<FocusMap>;
  });
  hostFocusCache.set(examId, request);
  request.catch(() => hostFocusCache.delete(examId));
  return request;
}

function hostPage(examId: number, page: number): Promise<ArrayBuffer> {
  const key = `${examId}:${page}`;
  const cached = hostPageCache.get(key);
  if (cached) return cached;
  if (hostPageCache.size >= HOST_PAGE_CACHE_LIMIT) {
    const oldest = hostPageCache.keys().next().value;
    if (oldest !== undefined) hostPageCache.delete(oldest);
  }
  const request = fetch(`${API}/exams/${examId}/pages/${page}`)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    });
  hostPageCache.set(key, request);
  request.catch(() => hostPageCache.delete(key));
  return request;
}

function serveConnection(conn: DataConnection, examId: number): void {
  conn.on("data", (raw) => {
    const message = raw as InboxMessage & { kind?: string; page?: number };
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

/**
 * Tenta hospedar esta prova no servidor de sinalização (id fixo
 * `mira-exam-<id>`). Se outro usuário já hospeda ou a sinalização estiver
 * fora do ar, devolve false e este cliente usa HTTP normalmente.
 */
export async function hostExam(examId: number): Promise<boolean> {
  if (hostingExamId === examId && hostPeer && !hostPeer.destroyed) return true;
  await shutdownHost();
  const config = await loadConfig();
  if (!config) return false;
  try {
    const { Peer: PeerCtor } = await import("peerjs");
    const peer = new PeerCtor(`${HOST_PREFIX}${examId}`, { host: config.host, port: config.port, path: config.path, secure: false, debug: 0 });
    const opened = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => { if (settled) return; settled = true; window.clearTimeout(timer); resolve(value); };
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

async function shutdownHost(): Promise<void> {
  if (hostPeer) { try { hostPeer.destroy(); } catch { /* já destruído */ } }
  hostPeer = null;
  hostingExamId = null;
}

/** Encerra tudo ao sair da tela de resolução: memória zero no frontend. */
export async function shutdownP2P(): Promise<void> {
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
