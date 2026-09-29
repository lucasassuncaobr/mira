// Porte vanilla de apps/web/src/pdf-cache.ts — caches de bytes/info/texto.
// pdf.js carrega sob demanda via importmap ("pdfjs-dist" → /assets/vendor/pdf.mjs).

const API = window.__MIRA_API__ || (location.protocol.startsWith("http") ? location.origin + "/api" : "http://localhost:3333/api");

const bytesReady = new Map();
const bytesPending = new Map();
const infoCache = new Map();
const textCache = new Map();
let workerReady = false;

export function prefetchExamPdf(examId) {
  const hit = bytesReady.get(examId);
  if (hit) return Promise.resolve(hit);
  const inflight = bytesPending.get(examId);
  if (inflight) return inflight;
  const request = fetch(`${API}/exams/${examId}/source`).then(async (response) => {
    if (!response.ok) throw new Error(`PDF indisponível (HTTP ${response.status})`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength < 100) throw new Error("PDF vazio ou inválido");
    bytesReady.set(examId, buffer);
    bytesPending.delete(examId);
    return buffer;
  }).catch((error) => {
    bytesPending.delete(examId);
    throw error;
  });
  bytesPending.set(examId, request);
  return request;
}

export function getCachedExamPdf(examId) {
  return bytesReady.get(examId);
}

export function fetchExamInfo(examId) {
  const hit = infoCache.get(examId);
  if (hit) return hit;
  const request = fetch(`${API}/exams/${examId}/info`).then(async (response) => {
    if (!response.ok) throw new Error(`Prova indisponível (HTTP ${response.status})`);
    return await response.json();
  }).catch((error) => {
    infoCache.delete(examId);
    throw error;
  });
  infoCache.set(examId, request);
  return request;
}

export function preloadExamPages(examId, count = 3) {
  for (let n = 1; n <= count; n += 1) {
    const img = new Image();
    img.src = `${API}/exams/${examId}/pages/${n}`;
  }
}

export function warmPdfReader(examId, full = false) {
  if (full) prefetchExamPdf(examId).catch(() => undefined);
  fetchExamInfo(examId)
    .then(({ pages }) => preloadExamPages(examId, Math.min(3, pages)))
    .catch(() => undefined);
}

export function fetchPageText(examId, page) {
  const key = `${examId}:${page}`;
  const hit = pageTextCache.get(key);
  if (hit) return hit;
  const request = fetch(`${API}/exams/${examId}/pages/${page}/text`).then(async (response) => {
    if (!response.ok) throw new Error(`Texto indisponível (HTTP ${response.status})`);
    return await response.json();
  }).catch((error) => {
    pageTextCache.delete(key);
    throw error;
  });
  pageTextCache.set(key, request);
  return request;
}

const pageTextCache = new Map();

async function ensurePdfJs() {
  const pdfjs = await import("pdfjs-dist");
  if (!workerReady) {
    pdfjs.GlobalWorkerOptions.workerSrc = "/assets/vendor/pdf.worker.min.mjs";
    workerReady = true;
  }
  return pdfjs;
}

export async function extractExamText(examId) {
  const hit = textCache.get(examId);
  if (hit) return hit;
  const pdfjs = await ensurePdfJs();
  const task = pdfjs.getDocument({ data: (await prefetchExamPdf(examId)).slice(0) });
  try {
    const doc = await task.promise;
    const texts = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      texts.push(content.items.map((item) => ("str" in item ? String(item.str) : "")).join(" "));
    }
    textCache.set(examId, texts);
    return texts;
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
