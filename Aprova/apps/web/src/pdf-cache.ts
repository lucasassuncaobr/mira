export const API = "http://localhost:3333/api";

const bytesReady = new Map<number, ArrayBuffer>();
const bytesPending = new Map<number, Promise<ArrayBuffer>>();
const infoCache = new Map<number, Promise<{ pages: number }>>();
const textCache = new Map<number, string[]>();
let workerReady = false;

/** Bytes do PDF original (para exportar com pdf-lib e extrair texto). */
export function prefetchExamPdf(examId: number): Promise<ArrayBuffer> {
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

/** Bytes já baixados, se houver. */
export function getCachedExamPdf(examId: number): ArrayBuffer | undefined {
  return bytesReady.get(examId);
}

/** Quantidade de páginas (conta os JPGs pré-renderizados no servidor). */
export function fetchExamInfo(examId: number): Promise<{ pages: number }> {
  const hit = infoCache.get(examId);
  if (hit) return hit;
  const request = fetch(`${API}/exams/${examId}/info`).then(async (response) => {
    if (!response.ok) throw new Error(`Prova indisponível (HTTP ${response.status})`);
    return (await response.json()) as { pages: number };
  }).catch((error) => {
    infoCache.delete(examId);
    throw error;
  });
  infoCache.set(examId, request);
  return request;
}

/** Pré-carrega as primeiras páginas como imagem para pintura instantânea. */
export function preloadExamPages(examId: number, count = 3): void {
  for (let n = 1; n <= count; n += 1) {
    const img = new Image();
    img.src = `${API}/exams/${examId}/pages/${n}`;
  }
}

/** Pré-aquece tudo ao montar a tela: bytes + info + primeiras páginas. */
export function warmPdfReader(examId: number): void {
  prefetchExamPdf(examId).catch(() => undefined);
  fetchExamInfo(examId)
    .then(({ pages }) => preloadExamPages(examId, Math.min(3, pages)))
    .catch(() => undefined);
}

export type TextLine = { x: number; y: number; w: number; h: number; text: string };
const pageTextCache = new Map<string, Promise<{ lines: TextLine[] }>>();

/** Linhas de texto com coordenadas (para seleção nativa e Ctrl+F). */
export function fetchPageText(examId: number, page: number): Promise<{ lines: TextLine[] }> {
  const key = `${examId}:${page}`;
  const hit = pageTextCache.get(key);
  if (hit) return hit;
  const request = fetch(`${API}/exams/${examId}/pages/${page}/text`).then(async (response) => {
    if (!response.ok) throw new Error(`Texto indisponível (HTTP ${response.status})`);
    return (await response.json()) as { lines: TextLine[] };
  }).catch((error) => {
    pageTextCache.delete(key);
    throw error;
  });
  pageTextCache.set(key, request);
  return request;
}

async function ensurePdfJs() {
  const pdfjs = await import("pdfjs-dist");
  if (!workerReady) {
    const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    workerReady = true;
  }
  return pdfjs;
}

/** Extrai o texto de cada página com pdf.js (para a busca local). */
export async function extractExamText(examId: number): Promise<string[]> {
  const hit = textCache.get(examId);
  if (hit) return hit;
  const pdfjs = await ensurePdfJs();
  const task = pdfjs.getDocument({ data: (await prefetchExamPdf(examId)).slice(0) });
  try {
    const doc = await task.promise;
    const texts: string[] = [];
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
