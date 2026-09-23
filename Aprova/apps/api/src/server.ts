import cors from "cors";
import express from "express";
import multer from "multer";
import pdf from "pdf-parse/lib/pdf-parse.js";
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createWorker, PSM } from "tesseract.js";
import porData from "@tesseract.js-data/por";
import { z } from "zod";
import { db, questionRow } from "./db.js";
import { buildFocusMap, buildFocusMapFromPdf, type FocusHint } from "./focus.js";
import { formatExamTitle, inferExamBoard, inferExamTitle, parseAnswerKey, parseQuestions, stripTrailingOcrNoise } from "./parser.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const port = Number(process.env.PORT ?? 3333);
const execFileAsync = promisify(execFile);
const examAssets = path.resolve(process.cwd(), "data", "exam-assets");

async function extractWithPortugueseOcr(buffer: Buffer): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aprova-ocr-"));
  try {
    const source = path.join(tempDir, "source.pdf");
    await writeFile(source, buffer);
    await execFileAsync("pdftoppm", ["-png", "-r", "260", source, path.join(tempDir, "page")]);
    const images = (await readdir(tempDir)).filter((file) => /^page-\d+\.png$/.test(file)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const worker = await createWorker("por", 1, { langPath: porData.langPath, gzip: porData.gzip, cacheMethod: "readOnly" });
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: "1" });
    const pages: string[] = [];
    try { for (const [index, image] of images.entries()) { const result = await worker.recognize(path.join(tempDir, image)); pages.push(`[[PAGE:${index + 1}]]\n${result.data.text}`); } } finally { await worker.terminate(); }
    return pages.join("\n").replace(/\n\s*[.·]\s*([A-D])\)/g, "\n$1)").replace(/\n\s*A([A-D])\)/g, "\n$1)");
  } finally { await rm(tempDir, { recursive: true, force: true }); }
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) { let previous = row[0]; row[0] = i; for (let j = 1; j <= b.length; j += 1) { const saved = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = saved; } }
  return row[b.length];
}

function mergeOcrQuestions(nativeQuestions: ReturnType<typeof parseQuestions>, ocrQuestions: ReturnType<typeof parseQuestions>) {
  const ocrMap = new Map(ocrQuestions.map((question) => [question.number, question]));
  return nativeQuestions.map((question) => {
    const ocr = ocrMap.get(question.number); if (!ocr || ocr.alternatives.length !== question.alternatives.length) return question;
    const alternatives = question.alternatives.map((alternative, index) => {
      const candidate = ocr.alternatives[index]; if (!candidate || candidate.label !== alternative.label) return alternative;
      // O OCR lê a marca d'água diagonal no fim da linha e gruda fragmentos
      // ("...dez dias. 4 VP"). Limpa ANTES de comparar: com o lixo fora, o
      // texto do OCR só vence o nativo se realmente trouxe mais conteúdo.
      const ocrText = stripTrailingOcrNoise(candidate.text);
      const compactNative = alternative.text.normalize("NFD").replace(/\p{M}|[^\p{L}\p{N}]/gu, "").toLowerCase();
      const compactOcr = ocrText.normalize("NFD").replace(/\p{M}|[^\p{L}\p{N}]/gu, "").toLowerCase();
      const similarity = 1 - editDistance(compactNative, compactOcr) / Math.max(1, compactNative.length, compactOcr.length);
      const nativeWords = alternative.text.split(/\s+/).length; const ocrWords = ocrText.split(/\s+/).length;
      return similarity >= .82 && ocrWords >= nativeWords + 2 ? { ...alternative, text: ocrText } : alternative;
    });
    return { ...question, alternatives };
  });
}

// PDF escaneado sem texto nativo: o OCR vira a fonte — mas com o mesmo corte
// de ruído do fim das alternativas.
function sanitizeOcrAlternatives(questions: ReturnType<typeof parseQuestions>) {
  return questions.map((question) => ({
    ...question,
    alternatives: question.alternatives.map((alternative) => ({ ...alternative, text: stripTrailingOcrNoise(alternative.text) }))
  }));
}

function adoptOcrQuestions(nativeQuestions: ReturnType<typeof parseQuestions>, ocrQuestions: ReturnType<typeof parseQuestions>) {
  return nativeQuestions.length ? mergeOcrQuestions(nativeQuestions, ocrQuestions) : sanitizeOcrAlternatives(ocrQuestions);
}

function pageInReadingOrder(pageText: string): string {
  const lines = pageText.split("\n");
  const candidates: number[] = [];
  for (const line of lines) for (const match of line.matchAll(/ {8,}/g)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end >= 55 && end <= 120 && line.slice(end).trim()) candidates.push(end);
  }
  const frequencies = new Map<number, number>();
  for (const value of candidates) for (let column = value - 2; column <= value + 2; column += 1) frequencies.set(column, (frequencies.get(column) ?? 0) + 1);
  const split = [...frequencies].sort((a, b) => b[1] - a[1])[0];
  if (!split || split[1] < 4) return pageText;
  const column = split[0];
  const left: string[] = []; const right: string[] = [];
  for (const line of lines) { left.push(line.slice(0, column).trimEnd()); right.push(line.slice(column).trim()); }
  return `${left.join("\n").trim()}\n${right.filter(Boolean).join("\n").trim()}`;
}

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  // Permite <img>/fetch cross-origin mesmo com COEP require-corp no web.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});
app.use("/api/exam-assets", express.static(examAssets));

app.get("/api/health", (_req, res) => res.json({ status: "ok", name: "Mira API" }));

// Config do servidor de sinalização PeerJS para o cliente P2P (fallback HTTP em seguida).
app.get("/api/p2p/config", (_req, res) => {
  res.json({
    host: process.env.P2P_HOST ?? "localhost",
    port: Number(process.env.P2P_PORT ?? 9000),
    path: process.env.P2P_PATH ?? "/sinalizar",
  });
});

/** Lê o mapa de foco já persistido; se faltar, calcula (vetorial → PaddleOCR) e grava. */
async function loadOrBuildFocusMap(examId: string) {
  const rows = db.prepare("SELECT number, page_number, y_inicio, x_center, focus_height, focus_scale FROM questions WHERE exam_id = ? ORDER BY number").all(examId) as Array<{ number: number; page_number: number | null; y_inicio: number | null; x_center: number | null; focus_height: number | null; focus_scale: number | null }>;
  const map = new Map<number, { page: number; y_inicio: number; x_center: number; focus_height: number; focus_scale: number }>();
  const missing = rows.filter((row) => row.y_inicio === null || row.focus_height === null);
  if (missing.length) {
    const source = path.join(examAssets, examId, "source.pdf");
    if (existsSync(source)) {
      const hints: FocusHint[] = rows.map((row) => ({ number: row.number, pageNumber: row.page_number }));
      const built = await buildFocusMapFromPdf(source, hints);
      if (built.size) {
        const persist = db.prepare("UPDATE questions SET y_inicio = ?, x_center = ?, focus_height = ?, focus_scale = ?, page_number = ? WHERE exam_id = ? AND number = ?");
        db.exec("BEGIN");
        try {
          for (const [number, entry] of built) persist.run(entry.y_inicio, entry.x_center, entry.focus_height, entry.focus_scale, entry.page, examId, number);
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
    }
  }
  const fresh = db.prepare("SELECT number, page_number, y_inicio, x_center, focus_height, focus_scale FROM questions WHERE exam_id = ? ORDER BY number").all(examId) as typeof rows;
  for (const row of fresh) {
    if (row.y_inicio === null || row.x_center === null) continue;
    map.set(row.number, { page: row.page_number ?? 1, y_inicio: row.y_inicio, x_center: row.x_center, focus_height: row.focus_height ?? 18, focus_scale: row.focus_scale ?? 2 });
  }
  return map;
}

// Mapa COMPLETO de metadados normalizados da prova (JSON pequeno — é o que o
// P2P/PeerJS transfere entre usuários antes do fallback HTTP de 3s).
app.get("/api/exams/:id/focus", async (req, res, next) => {
  try {
    const exam = db.prepare("SELECT id FROM exams WHERE id = ?").get(req.params.id);
    if (!exam) return res.status(404).json({ error: "Prova não encontrada" });
    const map = await loadOrBuildFocusMap(String(req.params.id));
    const payload: Record<string, unknown> = {};
    for (const [number, entry] of map) payload[String(number)] = entry;
    res.json(payload);
  } catch (error) { next(error); }
});

app.get("/api/exams", (_req, res) => {
  const rows = db.prepare(`
    SELECT e.*, COUNT(q.id) AS question_count,
      SUM(CASE WHEN la.id IS NOT NULL THEN 1 ELSE 0 END) AS answered_count,
      SUM(CASE WHEN la.is_correct = 1 THEN 1 ELSE 0 END) AS correct_count,
      SUM(CASE WHEN la.is_correct = 0 THEN 1 ELSE 0 END) AS wrong_count,
      COALESCE(SUM(la.elapsed_seconds), 0) AS study_seconds
    FROM exams e
    LEFT JOIN questions q ON q.exam_id = e.id
    LEFT JOIN attempts la ON la.id = (SELECT a.id FROM attempts a WHERE a.question_id = q.id ORDER BY a.id DESC LIMIT 1)
    GROUP BY e.id ORDER BY e.id DESC
  `).all();
  res.json(rows.map((row) => ({ ...(row as Record<string, unknown>), title: formatExamTitle(String((row as Record<string, unknown>).title)) })));
});

app.get("/api/performance", (_req, res) => {
  const rows = db.prepare(`WITH RECURSIVE dates(day, offset) AS (SELECT date('now','localtime','-6 days'), 0 UNION ALL SELECT date(day,'+1 day'), offset + 1 FROM dates WHERE offset < 6) SELECT strftime('%d/%m', dates.day) day, COUNT(a.id) answered, COALESCE(SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END), 0) correct, COALESCE(SUM(CASE WHEN a.is_correct = 0 THEN 1 ELSE 0 END), 0) wrong, COALESCE(SUM(a.elapsed_seconds), 0) seconds FROM dates LEFT JOIN attempts a ON date(a.created_at, 'localtime') = dates.day GROUP BY dates.day ORDER BY dates.day`).all();
  res.json(rows);
});

app.get("/api/activity", (_req, res) => {
  const rows = db.prepare(`WITH RECURSIVE dates(day, offset) AS (SELECT date('now','localtime','-83 days'), 0 UNION ALL SELECT date(day,'+1 day'), offset + 1 FROM dates WHERE offset < 83) SELECT dates.day date, strftime('%d/%m/%Y', dates.day) label, COUNT(a.id) count FROM dates LEFT JOIN attempts a ON date(a.created_at, 'localtime') = dates.day GROUP BY dates.day ORDER BY dates.day`).all();
  res.json(rows);
});

app.delete("/api/exams/:id", (req, res) => {
  const exam = db.prepare("SELECT id FROM exams WHERE id = ?").get(req.params.id);
  if (!exam) return res.status(404).json({ error: "Prova não encontrada" });
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM attempts WHERE question_id IN (SELECT id FROM questions WHERE exam_id = ?)").run(req.params.id);
    db.prepare("DELETE FROM questions WHERE exam_id = ?").run(req.params.id);
    db.prepare("DELETE FROM exams WHERE id = ?").run(req.params.id);
    db.exec("COMMIT");
    res.status(204).end();
  } catch (error) { db.exec("ROLLBACK"); throw error; }
});

app.put("/api/exams/:id", upload.single("logo"), async (req, res, next) => {
  try {
    const exam = db.prepare("SELECT id FROM exams WHERE id = ?").get(String(req.params.id));
    if (!exam) return res.status(404).json({ error: "Prova não encontrada" });
    const title = typeof req.body.title === "string" ? req.body.title : undefined;
    const board = typeof req.body.board === "string" ? req.body.board : undefined;
    const updates: string[] = [];
    const values: (string | number | null)[] = [];
    if (title !== undefined) { updates.push("title = ?"); values.push(title); }
    if (board !== undefined) { updates.push("board = ?"); values.push(board || null); }
    if (req.file) {
      const logoDir = path.join(examAssets, String(req.params.id));
      await mkdir(logoDir, { recursive: true });
      const ext = req.file.mimetype === "image/png" ? ".png" : ".jpg";
      const logoPath = path.join(logoDir, `logo${ext}`);
      await writeFile(logoPath, req.file.buffer);
      updates.push("logo = ?");
      values.push(`/api/exams/${req.params.id}/logo`);
    }
    if (updates.length === 0) return res.status(400).json({ error: "Nenhuma alteração enviada" });
    values.push(Number(req.params.id));
    db.prepare(`UPDATE exams SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    const updated = db.prepare("SELECT * FROM exams WHERE id = ?").get(String(req.params.id));
    res.json(updated);
  } catch (error) { next(error); }
});

app.get("/api/exams/:id/logo", (req, res) => {
  const exam = db.prepare("SELECT logo FROM exams WHERE id = ?").get(String(req.params.id)) as { logo?: string } | undefined;
  if (!exam?.logo) return res.status(404).json({ error: "Logo não encontrada" });
  const logoDir = path.join(examAssets, String(req.params.id));
  const jpgPath = path.join(logoDir, "logo.jpg");
  const pngPath = path.join(logoDir, "logo.png");
  if (existsSync(pngPath)) return res.sendFile(pngPath);
  if (existsSync(jpgPath)) return res.sendFile(jpgPath);
  res.status(404).json({ error: "Arquivo de logo não encontrado" });
});

app.get("/api/exams/:id", (req, res) => {
  const exam = db.prepare("SELECT * FROM exams WHERE id = ?").get(req.params.id);
  if (!exam) return res.status(404).json({ error: "Prova não encontrada" });
  const questions = db.prepare("SELECT * FROM questions WHERE exam_id = ? ORDER BY number").all(req.params.id).map((row) => questionRow(row as Record<string, unknown>));
  res.json({ ...exam, questions });
});

app.get("/api/exams/:id/pages/:page", (req, res) => {
  const base = path.join(examAssets, req.params.id, `page-${String(req.params.page).padStart(2, "0")}.jpg`);
  const fallback = path.join(examAssets, req.params.id, `page-${req.params.page}.jpg`);
  const target = existsSync(base) ? base : fallback;
  if (!existsSync(target)) return res.status(404).json({ error: "Imagem da página não encontrada" });
  // Imagens JPEG compactas ficam cacheadas: o lazy loading do <img> reaproveita
  // entre trocas de questão sem bater no servidor.
  res.setHeader("Cache-Control", "public, max-age=86400, immutable");
  res.sendFile(target);
});

app.get("/api/exams/:id/source", (req, res) => {
  const source = path.join(examAssets, req.params.id, "source.pdf");
  if (!existsSync(source)) return res.status(404).json({ error: "PDF original não encontrado" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="prova-${req.params.id}.pdf"`);
  res.sendFile(source);
});

app.get("/api/exams/:id/info", async (req, res, next) => {
  try {
    const dir = path.join(examAssets, req.params.id);
    const files = await readdir(dir);
    const pages = files.filter((file) => /^page-.*\.jpg$/i.test(file)).length;
    if (!pages) return res.status(404).json({ error: "Páginas da prova não encontradas" });
    res.json({ pages });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return res.status(404).json({ error: "Prova não encontrada" });
    next(error);
  }
});

type TextLine = { x: number; y: number; w: number; h: number; text: string };
const textCache = new Map<string, { width: number; height: number; lines: TextLine[] }>();

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/** Linhas de texto com coordenadas normalizadas (0..1) para a camada
 *  invisível de seleção/busca do front-end. Cache em memória (source.pdf
 *  é imutável após a importação). */
app.get("/api/exams/:id/pages/:page/text", async (req, res, next) => {
  try {
    const key = `${req.params.id}:${req.params.page}`;
    const hit = textCache.get(key);
    if (hit) return res.json(hit);
    const source = path.join(examAssets, req.params.id, "source.pdf");
    if (!existsSync(source)) return res.status(404).json({ error: "PDF original não encontrado" });
    const page = String(Math.max(1, Number(req.params.page)));
    const { stdout } = await execFileAsync("pdftotext", ["-f", page, "-l", page, "-bbox", source, "-"]);
    const pageTag = stdout.match(/<page\s+width="([\d.]+)"\s+height="([\d.]+)"/);
    if (!pageTag) return res.json({ width: 0, height: 0, lines: [] });
    const width = Number(pageTag[1]);
    const height = Number(pageTag[2]);
    const words: { x0: number; y0: number; x1: number; y1: number; text: string }[] = [];
    const wordRe = /<word\s+xMin="([\d.]+)"\s+yMin="([\d.]+)"\s+xMax="([\d.]+)"\s+yMax="([\d.]+)">([^<]*)<\/word>/g;
    let match: RegExpExecArray | null;
    while ((match = wordRe.exec(stdout)) !== null) {
      words.push({
        x0: Number(match[1]),
        y0: Number(match[2]),
        x1: Number(match[3]),
        y1: Number(match[4]),
        text: decodeEntities(match[5]),
      });
    }
    // Agrupa palavras em linhas pela proximidade vertical.
    words.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const medianH = words.length
      ? words.map((w) => w.y1 - w.y0).sort((a, b) => a - b)[Math.floor(words.length / 2)]
      : 0;
    const tolerance = Math.max(1, medianH * 0.4);
    const rows: typeof words[] = [];
    for (const word of words) {
      const row = rows[rows.length - 1];
      const rowY = row ? (row[0].y0 + row[0].y1) / 2 : 0;
      const wordY = (word.y0 + word.y1) / 2;
      if (row && Math.abs(wordY - rowY) <= tolerance) row.push(word);
      else rows.push([word]);
    }
    const lines: TextLine[] = rows.map((row) => {
      const sorted = [...row].sort((a, b) => a.x0 - b.x0);
      const x0 = Math.min(...sorted.map((w) => w.x0));
      const y0 = Math.min(...sorted.map((w) => w.y0));
      const x1 = Math.max(...sorted.map((w) => w.x1));
      const y1 = Math.max(...sorted.map((w) => w.y1));
      return {
        x: x0 / width,
        y: y0 / height,
        w: (x1 - x0) / width,
        h: (y1 - y0) / height,
        text: sorted.map((w) => w.text).join(" "),
      };
    });
    const result = { width, height, lines };
    if (textCache.size > 500) textCache.clear();
    textCache.set(key, result);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Foco de uma questão (compat): metadado normalizado do banco, com cálculo
// sob demanda caso a prova seja anterior à coluna y_inicio.
app.get("/api/exams/:id/pages/:page/focus/:question", async (req, res, next) => {
  try {
    const stored = db.prepare("SELECT page_number, y_inicio, x_center, focus_height, focus_scale FROM questions WHERE exam_id = ? AND number = ?").get(req.params.id, req.params.question) as { page_number: number | null; y_inicio: number | null; x_center: number | null; focus_height: number | null; focus_scale: number | null } | undefined;
    let entry = stored && stored.y_inicio !== null && stored.x_center !== null
      ? { page: stored.page_number ?? Number(req.params.page), y_inicio: stored.y_inicio, x_center: stored.x_center, focus_height: stored.focus_height ?? 18, focus_scale: stored.focus_scale ?? 2 }
      : undefined;
    if (!entry) {
      const map = await loadOrBuildFocusMap(String(req.params.id));
      entry = map.get(Number(req.params.question));
    }
    if (!entry) return res.json({ x: .5, y: .15 });
    res.json({
      y_inicio: entry.y_inicio,
      x_center: entry.x_center,
      focus_height: entry.focus_height,
      scale: entry.focus_scale,
      x: entry.x_center / 100,
      y: entry.y_inicio / 100
    });
  } catch (error) { next(error); }
});

// Lacunas no parse (ex.: questão 21 que nunca foi identificada, ou o começo
// inteiro da prova) são expostas na resposta para nunca passarem em silêncio
// por uma importação/reprocesso. O intervalo parte SEMPRE de 1: uma prova que
// começa na questão 10 tem lacunas de 1 a 9, não está "completa".
function missingNumbers(numbers: number[]): number[] {
  if (!numbers.length) return [];
  const present = new Set(numbers);
  const max = Math.max(...numbers);
  const missing: number[] = [];
  for (let number = 1; number <= max; number += 1)
    if (!present.has(number)) missing.push(number);
  return missing;
}

app.post("/api/exams/:id/reprocess", async (req, res, next) => {
  try {
    const source = path.join(examAssets, req.params.id, "source.pdf");
    if (!existsSync(source)) return res.status(404).json({ error: "O PDF original desta prova não está disponível" });
    const buffer = await readFile(source);
    const preciseText = spawnSync("pdftotext", ["-raw", "-", "-"], { input: buffer, encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
    if (preciseText.status !== 0 || !preciseText.stdout.trim()) return res.status(422).json({ error: "Não foi possível reler o PDF" });
    const marked = preciseText.stdout.split("\f").map((pageText, index) => `[[PAGE:${index + 1}]]\n${pageText}`).join("\n");
    const nativeQuestions = parseQuestions(marked).filter((question) => question.alternatives.length >= 2);
    const ocrQuestions = parseQuestions(await extractWithPortugueseOcr(buffer)).filter((question) => question.alternatives.length >= 2);
    const questions = adoptOcrQuestions(nativeQuestions, ocrQuestions);
    const focusMap = await buildFocusMap(buffer, questions.map((question) => ({ number: question.number, pageNumber: question.pageNumber ?? 1 })));
    // Reconcilia o conjunto INTEIRO em vez de atualizar por número: corrige
    // questão duplicada, reinsere número que sumiu e completa respostas que o
    // gabarito ainda não tinha ligado — o índice volta a bater com o gabarito.
    const answerMap = new Map<number, string>();
    const answerKeyPath = path.join(examAssets, req.params.id, "answer-key.pdf");
    if (existsSync(answerKeyPath)) {
      try {
        const keyText = spawnSync("pdftotext", ["-raw", "-", "-"], { input: await readFile(answerKeyPath), encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
        if (keyText.status === 0 && keyText.stdout.trim())
          for (const item of parseAnswerKey(keyText.stdout, marked)) answerMap.set(item.number, item.answer);
      } catch (error) { console.warn("Não foi possível reler o gabarito desta prova", error); }
    }
    const existing = db.prepare("SELECT id, number, correct_answer FROM questions WHERE exam_id = ? ORDER BY number, id").all(req.params.id) as { id: number; number: number; correct_answer: string | null }[];
    const byNumber = new Map<number, { id: number; correct_answer: string | null }[]>();
    for (const row of existing) byNumber.set(row.number, [...(byNumber.get(row.number) ?? []), { id: row.id, correct_answer: row.correct_answer }]);
    const update = db.prepare("UPDATE questions SET statement=?, alternatives=?, page_number=?, context=?, y_inicio=COALESCE(?, y_inicio), x_center=COALESCE(?, x_center), focus_height=COALESCE(?, focus_height), focus_scale=COALESCE(?, focus_scale), correct_answer=? WHERE id=?");
    const insert = db.prepare("INSERT INTO questions (exam_id, number, statement, alternatives, correct_answer, page_number, context, y_inicio, x_center, focus_height, focus_scale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const moveAttempts = db.prepare("UPDATE attempts SET question_id = ? WHERE question_id = ?");
    const dropAttempts = db.prepare("DELETE FROM attempts WHERE question_id = ?");
    const dropQuestion = db.prepare("DELETE FROM questions WHERE id = ?");
    const seen = new Set<number>();
    let added = 0;
    let repaired = 0;
    let removed = 0;
    db.exec("BEGIN");
    try {
      for (const question of questions) {
        const focus = focusMap.get(question.number) ?? null;
        const rows = byNumber.get(question.number) ?? [];
        const keeper = rows[0];
        const correct = answerMap.get(question.number) ?? keeper?.correct_answer ?? null;
        if (keeper) {
          update.run(question.statement, JSON.stringify(question.alternatives), question.pageNumber ?? 1, question.context ?? null, focus?.y_inicio ?? null, focus?.x_center ?? null, focus?.focus_height ?? null, focus?.focus_scale ?? null, correct, keeper.id);
          for (const duplicate of rows.slice(1)) {
            moveAttempts.run(keeper.id, duplicate.id);
            dropQuestion.run(duplicate.id);
            repaired += 1;
          }
        } else {
          insert.run(req.params.id, question.number, question.statement, JSON.stringify(question.alternatives), correct, question.pageNumber ?? 1, question.context ?? null, focus?.y_inicio ?? null, focus?.x_center ?? null, focus?.focus_height ?? null, focus?.focus_scale ?? null);
          added += 1;
        }
        seen.add(question.number);
      }
      for (const [number, rows] of byNumber) {
        if (seen.has(number)) continue;
        for (const row of rows) {
          dropAttempts.run(row.id);
          dropQuestion.run(row.id);
          removed += 1;
        }
      }
      db.prepare("UPDATE exams SET board = COALESCE(?, board) WHERE id = ?").run(inferExamBoard(marked), req.params.id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    const missing = missingNumbers(questions.map((question) => question.number));
    if (missing.length) console.warn(`[reprocess] prova ${req.params.id}: lacunas no parse das questões: ${missing.join(", ")}`);
    res.json({ ok: true, questionCount: questions.length, added, repaired, removed, missing });
  } catch (error) { next(error); }
});

app.post("/api/exams/import", upload.fields([{ name: "exam", maxCount: 1 }, { name: "answerKey", maxCount: 1 }]), async (req, res, next) => {
  try {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const examFile = files?.exam?.[0];
    const answerFile = files?.answerKey?.[0];
    if (!examFile || !answerFile || examFile.mimetype !== "application/pdf" || answerFile.mimetype !== "application/pdf") return res.status(400).json({ error: "Envie os PDFs da prova e do gabarito" });
    let pageNumber = 0;
    const preciseText = spawnSync("pdftotext", ["-raw", "-", "-"], { input: examFile.buffer, encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
    const precisePages = preciseText.status === 0 && preciseText.stdout.trim() ? preciseText.stdout.split("\f").map((pageText, index) => `[[PAGE:${index + 1}]]\n${pageText}`).join("\n") : "";
    const parsePdfWithOptions = pdf as unknown as (buffer: Buffer, options: Record<string, unknown>) => Promise<{ text: string }>;
    const extractedFallback = await parsePdfWithOptions(examFile.buffer, { pagerender: async (page: any) => {
      pageNumber += 1;
      const content = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
      let lastY: number | undefined;
      const rendered = content.items.map((item: any) => {
        const y = Number(item.transform?.[5] ?? 0);
        const separator = lastY !== undefined && Math.abs(y - lastY) > 2 ? "\n" : " ";
        lastY = y;
        return separator + item.str;
      }).join("");
      return `\n[[PAGE:${pageNumber}]]\n${rendered}`;
    }});
    let extracted = { text: precisePages || extractedFallback.text };
    let questions = parseQuestions(extracted.text).filter((question) => question.alternatives.length >= 2);
    const usableNativeRatio = questions.length ? questions.filter((question) => question.alternatives.length >= 4 && question.alternatives.every((alternative) => alternative.text.trim().length > 0)).length / questions.length : 0;
    // PDFs digitais já trazem texto mais fiel que OCR. O OCR integral fica reservado
    // a documentos escaneados ou extrações realmente incompletas.
    if (questions.length < 3 || usableNativeRatio < .75) {
      const ocrText = await extractWithPortugueseOcr(examFile.buffer);
      const ocrQuestions = parseQuestions(ocrText).filter((question) => question.alternatives.length >= 2);
      questions = adoptOcrQuestions(questions, ocrQuestions);
    }
    const preciseAnswers = spawnSync("pdftotext", ["-raw", "-", "-"], { input: answerFile.buffer, encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
    const extractedAnswers = preciseAnswers.status === 0 && preciseAnswers.stdout.trim() ? { text: preciseAnswers.stdout } : await pdf(answerFile.buffer);
    if (!questions.length) return res.status(422).json({ error: "Nenhuma questão foi identificada. PDFs escaneados precisarão do módulo de OCR." });
    const nativeAnswers = parseAnswerKey(extractedAnswers.text, extracted.text);
    const answerMap = new Map(nativeAnswers.map((item) => [item.number, item.answer]));
    const expectedAnswers = questions.length;
    if (nativeAnswers.length < Math.max(3, Math.ceil(expectedAnswers * .75))) {
      const ocrAnswerText = await extractWithPortugueseOcr(answerFile.buffer);
      const ocrAnswers = parseAnswerKey(ocrAnswerText, extracted.text);
      for (const item of ocrAnswers) if (!answerMap.has(item.number)) answerMap.set(item.number, item.answer);
    }
    if (answerMap.size < Math.ceil(questions.length * .75)) return res.status(422).json({ error: "Não foi possível localizar no gabarito a seção correspondente ao cargo desta prova." });

    const title = String(req.body.title || inferExamTitle(extracted.text, examFile.originalname));
    const board = inferExamBoard(extracted.text);
    // Metadados de localização: o SERVIDOR faz OCR/geometria e persiste apenas
    // percentuais normalizados (y_inicio/x_center) — nunca pixel fixo.
    const focusMap = await buildFocusMap(examFile.buffer, questions.map((question) => ({ number: question.number, pageNumber: question.pageNumber ?? 1 })));
    const result = db.prepare("INSERT INTO exams (title, filename, board) VALUES (?, ?, ?)").run(title, examFile.originalname, board);
    const insert = db.prepare("INSERT INTO questions (exam_id, number, statement, alternatives, correct_answer, page_number, context, y_inicio, x_center, focus_height, focus_scale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const question of questions) {
      const focus = focusMap.get(question.number) ?? null;
      insert.run(result.lastInsertRowid, question.number, question.statement, JSON.stringify(question.alternatives), answerMap.get(question.number) ?? null, focus?.page ?? question.pageNumber ?? 1, question.context ?? null, focus?.y_inicio ?? null, focus?.x_center ?? null, focus?.focus_height ?? null, focus?.focus_scale ?? null);
    }
    const assetDir = path.join(examAssets, String(result.lastInsertRowid));
    await mkdir(assetDir, { recursive: true });
    const sourcePath = path.join(assetDir, "source.pdf");
    await writeFile(sourcePath, examFile.buffer);
    await writeFile(path.join(assetDir, "answer-key.pdf"), answerFile.buffer);
    // Páginas como JPEG compacto: 150 DPI / qualidade 75 — o frontend só
    // consome imagem leve via <img loading="lazy">, sem renderizar PDF.
    try { await execFileAsync("pdftoppm", ["-jpeg", "-r", "150", "-jpegopt", "quality=75", sourcePath, path.join(assetDir, "page")]); } catch (error) { console.warn("Não foi possível renderizar as páginas", error); }
    const missing = missingNumbers(questions.map((question) => question.number));
    if (missing.length) console.warn(`[import] lacunas no parse das questões: ${missing.join(", ")}`);
    res.status(201).json({ id: Number(result.lastInsertRowid), title, board, questionCount: questions.length, missing });
  } catch (error) { next(error); }
});

const updateSchema = z.object({
  statement: z.string().min(1),
  alternatives: z.array(z.object({ label: z.string().min(1).max(2), text: z.string().min(1) })),
  correctAnswer: z.string().max(2).nullable().optional(),
  subject: z.string().nullable().optional(),
  topic: z.string().nullable().optional()
});

app.put("/api/questions/:id", (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados da questão inválidos", details: parsed.error.issues });
  const q = parsed.data;
  db.prepare("UPDATE questions SET statement=?, alternatives=?, correct_answer=?, subject=?, topic=? WHERE id=?")
    .run(q.statement, JSON.stringify(q.alternatives), q.correctAnswer ?? null, q.subject ?? null, q.topic ?? null, req.params.id);
  res.json({ ok: true });
});

app.post("/api/questions/:id/answer", (req, res) => {
  const answer = z.object({ answer: z.string().min(1).max(2), elapsedSeconds: z.number().int().min(0).default(0) }).safeParse(req.body);
  if (!answer.success) return res.status(400).json({ error: "Resposta inválida" });
  const question = db.prepare("SELECT correct_answer FROM questions WHERE id=?").get(req.params.id) as { correct_answer?: string } | undefined;
  if (!question) return res.status(404).json({ error: "Questão não encontrada" });
  const isCorrect = question.correct_answer ? Number(question.correct_answer === answer.data.answer) : null;
  db.prepare("INSERT INTO attempts (question_id, answer, is_correct, elapsed_seconds) VALUES (?, ?, ?, ?)")
    .run(req.params.id, answer.data.answer, isCorrect, answer.data.elapsedSeconds);
  res.json({ correctAnswer: question.correct_answer ?? null, isCorrect: isCorrect === null ? null : Boolean(isCorrect) });
});

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: "Não foi possível concluir a operação" });
});

app.listen(port, () => console.log(`Mira API em http://localhost:${port}`));
