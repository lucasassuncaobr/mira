// Mapa de coordenadas de questões — ARQUITETURA HÍBRIDA (servidor faz OCR/geometria).
//
// Regras do projeto:
//  - Localização é gravada APENAS como metadado numérico normalizado:
//    y_inicio = porcentagem vertical do topo da questão na página (0..100).
//    NUNCA coordenada fixa em pixels: a página é medida em tempo de execução
//    pelo client (clientHeight) e o percentual é aplicado sobre ela.
//  - Caminho vetorial (pdftotext -bbox) é a triagem instantânea e não custa IA.
//  - PDF escaneado (imagem pura) aciona o fallback PaddleOCR (backend Python),
//    que devolve a mesma estrutura normalizada.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type FocusEntry = {
  page: number;
  y_inicio: number;   // % vertical do topo do bloco (0..100)
  x_center: number;   // % horizontal do centro da coluna (0..100)
  focus_height: number; // % vertical coberto pela questão (0..100)
  focus_scale: number; // dica de zoom normalizada derivada da altura do bloco
};

export type FocusHint = { number: number; pageNumber?: number | null };

type Candidate = {
  number: number;
  page: number;
  yMin: number;
  xMin: number;
  xMax: number;
  pageW: number;
  pageH: number;
  rank: number;
  lineStart: boolean;
};

type BboxLine = {
  page: number;
  text: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  pageW: number;
  pageH: number;
};

const PADDLE_TIMEOUT_MS = Number(process.env.MIRA_PADDLE_TIMEOUT_MS ?? 180_000);
const round2 = (value: number) => Math.round(value * 100) / 100;

/** Interpreta a saída do `pdftotext -bbox` e devolve candidatos a início de questão. */
function parseBboxCandidates(bboxText: string): Candidate[] {
  const candidates: Candidate[] = [];
  let page = 0;
  let pageW = 0;
  let pageH = 0;
  let previousWord = "";
  let previousLineY = Number.NaN;

  const token = /<page\s+width="([\d.]+)"\s+height="([\d.]+)"|<word\s+xMin="([\d.]+)"\s+yMin="([\d.]+)"\s+xMax="([\d.]+)"\s+yMax="([\d.]+)">([^<]*)<\/word>/g;
  for (const match of bboxText.matchAll(token)) {
    if (match[1] !== undefined) {
      page += 1;
      pageW = Number(match[1]);
      pageH = Number(match[2]);
      previousWord = "";
      previousLineY = Number.NaN;
      continue;
    }
    const xMin = Number(match[3]);
    const yMin = Number(match[4]);
    const xMax = Number(match[5]);
    const yMax = Number(match[6]);
    const word = match[7].trim();
    if (!word || !pageW || !pageH) continue;

    const lineStart = !Number.isFinite(previousLineY) || Math.abs(yMin - previousLineY) > Math.max(2.5, (yMax - yMin) * 0.65);
    // Descarta cabeçalho/rodapé (número de página solto) — fora da faixa útil.
    const inBody = yMin > pageH * 0.03 && yMax < pageH * 0.97;
    const numeric = word.match(/^(\d{1,3})([.)])?$/);
    const label = lineStart ? "" : previousWord.replace(/\p{Diacritic}/gu, "").toLowerCase();

    if (numeric && inBody) {
      const hasSeparator = numeric[2] !== undefined;
      const fromLabel = label === "questao" || label === "questão" || label === "q";
      const nearQuestionColumn = xMin < pageW * 0.24;
      candidates.push({
        number: Number(numeric[1]),
        page,
        yMin,
        xMin,
        xMax,
        pageW,
        pageH,
        lineStart,
        // Ranqueamento: "QUESTÃO 05" > início de linha "05" > "05." / "05)" > número solto.
        // Isso evita capturar referências como "questões de 01 a 05" no cabeçalho/texto-base.
        rank: (fromLabel ? 120 : 0) + (lineStart ? 90 : 0) + (nearQuestionColumn ? 20 : 0) + (hasSeparator ? 35 : 0) + (lineStart || fromLabel || hasSeparator ? 20 : 0),
      });
    }
    previousWord = word;
    previousLineY = yMin;
  }
  return candidates;
}

/** Agrupa palavras do bbox em linhas de leitura para estimar o fim real do bloco. */
function parseBboxLines(bboxText: string): BboxLine[] {
  const lines: BboxLine[] = [];
  let page = 0;
  let pageW = 0;
  let pageH = 0;
  let current: BboxLine | null = null;

  const token = /<page\s+width="([\d.]+)"\s+height="([\d.]+)"|<word\s+xMin="([\d.]+)"\s+yMin="([\d.]+)"\s+xMax="([\d.]+)"\s+yMax="([\d.]+)">([^<]*)<\/word>/g;
  const flush = () => {
    if (current?.text.trim()) lines.push({ ...current, text: current.text.trim() });
    current = null;
  };

  for (const match of bboxText.matchAll(token)) {
    if (match[1] !== undefined) {
      flush();
      page += 1;
      pageW = Number(match[1]);
      pageH = Number(match[2]);
      continue;
    }
    const xMin = Number(match[3]);
    const yMin = Number(match[4]);
    const xMax = Number(match[5]);
    const yMax = Number(match[6]);
    const word = match[7].trim();
    if (!word || !pageW || !pageH) continue;

    const sameLine = current && current.page === page && Math.abs(yMin - current.yMin) <= Math.max(2.5, (yMax - yMin) * 0.65);
    if (!sameLine) {
      flush();
      current = { page, text: word, xMin, xMax, yMin, yMax, pageW, pageH };
    } else {
      const line = current as BboxLine;
      line.text += ` ${word}`;
      line.xMin = Math.min(line.xMin, xMin);
      line.xMax = Math.max(line.xMax, xMax);
      line.yMin = Math.min(line.yMin, yMin);
      line.yMax = Math.max(line.yMax, yMax);
    }
  }
  flush();
  return lines;
}

function isSectionHeading(line: BboxLine): boolean {
  const letters = line.text.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}]/gu, "");
  if (letters.length < 6) return false;
  const uppercase = letters.replace(/[^\p{Lu}]/gu, "").length / letters.length;
  const centered = line.xMin > line.pageW * 0.08 && line.xMax < line.pageW * 0.92;
  return centered && uppercase > 0.86;
}

function estimateQuestionBottom(best: Candidate, next: Candidate | undefined, lines: BboxLine[]): number {
  const limit = next ? next.yMin - best.pageH * 0.012 : best.yMin + best.pageH * 0.42;
  const relevant = lines
    .filter((line) => line.page === best.page && line.yMax >= best.yMin - 2 && line.yMin < limit)
    .sort((a, b) => a.yMin - b.yMin);
  let started = false;
  let lastY = best.yMin;
  for (const line of relevant) {
    const startsQuestion = new RegExp(`^\\s*${best.number}(?:[.)]\\s*|\\s+)`).test(line.text);
    if (!started && !startsQuestion) continue;
    started = true;
    if (!startsQuestion && isSectionHeading(line)) break;
    lastY = Math.max(lastY, line.yMax);
  }
  return Math.min(best.pageH, Math.max(best.yMin + best.pageH * 0.08, lastY + best.pageH * 0.012));
}

/** Escolhe, para cada questão, o candidato mais plausível (página dica + rank). */
function selectEntries(candidates: Candidate[], lines: BboxLine[], hints: FocusHint[]): Map<number, FocusEntry> {
  const entries = new Map<number, FocusEntry>();

  for (const hint of hints) {
    if (entries.has(hint.number)) continue;
    const found = candidates.filter((candidate) => candidate.number === hint.number);
    if (!found.length) continue;
    const onPage = hint.pageNumber ? found.filter((candidate) => candidate.page === hint.pageNumber) : [];
    const pool = onPage.length ? onPage : found;
    const best = pool.sort((a, b) => b.rank - a.rank || a.page - b.page || a.yMin - b.yMin)[0];

    // Bloco: próxima questão da mesma coluna abaixo; senão, estimativa de 42% da página.
    const next = candidates
      .filter((candidate) => candidate.page === best.page && candidate.yMin > best.yMin + 4 && Math.abs(candidate.xMin - best.xMin) < best.pageW * 0.12)
      .sort((a, b) => a.yMin - b.yMin)[0];
    const top = Math.max(0, best.yMin - best.pageH * 0.01);
    const bottom = estimateQuestionBottom(best, next, lines);

    const columnLeft = best.xMin < best.pageW / 2 ? Math.max(0, best.xMin - best.pageW * 0.03) : Math.max(best.pageW / 2, best.xMin - best.pageW * 0.03);
    const columnRight = best.xMin < best.pageW / 2 ? best.pageW / 2 : best.pageW;
    const width = Math.max(0.28, (columnRight - columnLeft) / best.pageW);
    const height = Math.max(0.16, (bottom - top) / best.pageH);

    entries.set(hint.number, {
      page: best.page,
      y_inicio: round2((top / best.pageH) * 100),
      x_center: round2((((best.xMin + best.xMax) / 2) / best.pageW) * 100),
      focus_height: round2(Math.max(4, ((bottom - top) / best.pageH) * 100)),
      focus_scale: Math.min(3.2, Math.max(1.65, Math.min(0.94 / width, 0.86 / height))),
    });
  }
  return entries;
}

/**
 * Fallback PaddleOCR (backend Python) para PDFs escaneados.
 * Roda `python/ocr_map.py <pdf>` e devolve [{questao, pagina, y_inicio, x_centro}].
 * Qualquer falha (Python/Paddle ausente, timeout) devolve mapa vazio — nunca
 * derruba o import: a prova continua funcionando sem o metadado de foco.
 */
async function focusMapFromPaddle(buffer: Buffer): Promise<Map<number, FocusEntry>> {
  const script = path.join(process.cwd(), "python", "ocr_map.py");
  if (!existsSync(script)) return new Map();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aprova-paddle-"));
  const pdfPath = path.join(tempDir, "source.pdf");
  try {
    await writeFile(pdfPath, buffer);
    const { stdout } = await execFileAsync("python3", [script, pdfPath], {
      timeout: PADDLE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      cwd: path.dirname(script),
    });
    const rows = JSON.parse(stdout) as Array<{ questao: number; pagina: number; y_inicio: number; x_centro?: number }>;
    const map = new Map<number, FocusEntry>();
    for (const row of rows) {
      if (!Number.isFinite(row.questao) || !Number.isFinite(row.y_inicio)) continue;
      map.set(row.questao, {
        page: Math.max(1, Number(row.pagina) || 1),
        y_inicio: round2(Math.min(100, Math.max(0, row.y_inicio))),
        x_center: round2(Math.min(100, Math.max(0, row.x_centro ?? 50))),
        focus_height: 18,
        focus_scale: 2.2,
      });
    }
    return map;
  } catch (error) {
    console.warn("[focus] PaddleOCR indisponível:", error instanceof Error ? error.message : error);
    return new Map();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Constrói o mapa híbrido de uma prova:
 * 1) Vetorial instantâneo via pdftotext -bbox;
 * 2) Se o PDF for escaneado (pouco/no texto), fallback PaddleOCR.
 */
export async function buildFocusMap(buffer: Buffer, hints: FocusHint[]): Promise<Map<number, FocusEntry>> {
  const precise = spawnSync("pdftotext", ["-bbox", "-", "-"], { input: buffer, encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
  let map = new Map<number, FocusEntry>();
  if (precise.status === 0 && precise.stdout.trim()) {
    map = selectEntries(parseBboxCandidates(precise.stdout), parseBboxLines(precise.stdout), hints);
  }

  const expected = hints.length;
  const insufficient = map.size < Math.min(3, expected) || (expected >= 3 && map.size < Math.ceil(expected * 0.5));
  if (expected && insufficient) {
    console.log("[focus] PDF sem texto vetorizado (escaneado?). Acionando PaddleOCR...");
    const ocrMap = await focusMapFromPaddle(buffer);
    for (const [number, entry] of ocrMap) map.set(number, entry);
  }
  return map;
}

/** Variante para já-conhecido em disco (reprocessamento / reparo sob demanda). */
export async function buildFocusMapFromPdf(pdfPath: string, hints: FocusHint[]): Promise<Map<number, FocusEntry>> {
  return buildFocusMap(await readFile(pdfPath), hints);
}
