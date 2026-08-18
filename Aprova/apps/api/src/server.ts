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
import { formatExamTitle, inferExamBoard, inferExamTitle, parseAnswerKey, parseQuestions } from "./parser.js";

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
      const compactNative = alternative.text.normalize("NFD").replace(/\p{M}|[^\p{L}\p{N}]/gu, "").toLowerCase();
      const compactOcr = candidate.text.normalize("NFD").replace(/\p{M}|[^\p{L}\p{N}]/gu, "").toLowerCase();
      const similarity = 1 - editDistance(compactNative, compactOcr) / Math.max(1, compactNative.length, compactOcr.length);
      const nativeWords = alternative.text.split(/\s+/).length; const ocrWords = candidate.text.split(/\s+/).length;
      return similarity >= .82 && ocrWords >= nativeWords + 2 ? { ...alternative, text: candidate.text } : alternative;
    });
    return { ...question, alternatives };
  });
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
app.use("/api", (_req, res, next) => { res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate"); next(); });
app.use("/api/exam-assets", express.static(examAssets));

app.get("/api/health", (_req, res) => res.json({ status: "ok", name: "Mira API" }));

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
  res.sendFile(target);
});

app.get("/api/exams/:id/pages/:page/focus/:question", async (req, res, next) => {
  try {
    const source = path.join(examAssets, req.params.id, "source.pdf");
    if (!existsSync(source)) return res.status(404).json({ error: "PDF original não encontrado" });
    const page = String(Math.max(1, Number(req.params.page)));
    const { stdout } = await execFileAsync("pdftotext", ["-f", page, "-l", page, "-bbox", source, "-"]);
    const pageTag = stdout.match(/<page\s+width="([\d.]+)"\s+height="([\d.]+)"/);
    if (!pageTag) return res.json({ x: .5, y: .15 });
    const words = [...stdout.matchAll(/<word\s+xMin="([\d.]+)"\s+yMin="([\d.]+)"\s+xMax="([\d.]+)"\s+yMax="([\d.]+)">([^<]+)<\/word>/g)];
    const pageWidth = Number(pageTag[1]);
    const pageHeight = Number(pageTag[2]);
    const questionWords = words.filter((word) => /^\d{1,3}[.)]?$/.test(word[5]));
    const target = questionWords.find((word) => word[5].replace(/[.)]/g, "") === req.params.question);
    if (!target) return res.json({ x: .5, y: .15 });
    const startX = Number(target[1]);
    const startY = Number(target[2]);
    const sameColumn = questionWords
      .filter((word) => Number(word[2]) > startY + 4 && Math.abs(Number(word[1]) - startX) < pageWidth * .12)
      .sort((a, b) => Number(a[2]) - Number(b[2]))[0];
    const columnLeft = startX < pageWidth / 2 ? Math.max(0, startX - 18) : Math.max(pageWidth / 2, startX - 18);
    const columnRight = startX < pageWidth / 2 ? pageWidth / 2 : pageWidth;
    const top = Math.max(0, startY - 20);
    const bottom = Math.min(pageHeight, sameColumn ? Number(sameColumn[2]) - 10 : startY + pageHeight * .42);
    const width = Math.max(.28, (columnRight - columnLeft) / pageWidth);
    const height = Math.max(.16, (bottom - top) / pageHeight);
    res.json({
      x: (columnLeft + columnRight) / 2 / pageWidth,
      y: (top + bottom) / 2 / pageHeight,
      width,
      height,
      scale: Math.min(3.2, Math.max(1.65, Math.min(.94 / width, .86 / height)))
    });
  } catch (error) { next(error); }
});

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
    const questions = mergeOcrQuestions(nativeQuestions, ocrQuestions);
    const update = db.prepare("UPDATE questions SET statement=?, alternatives=?, page_number=?, context=? WHERE exam_id=? AND number=?");
    db.exec("BEGIN");
    try {
      for (const question of questions) update.run(question.statement, JSON.stringify(question.alternatives), question.pageNumber ?? 1, question.context ?? null, req.params.id, question.number);
      db.prepare("UPDATE exams SET board = COALESCE(?, board) WHERE id = ?").run(inferExamBoard(marked), req.params.id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    res.json({ ok: true, questionCount: questions.length });
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
      questions = questions.length ? mergeOcrQuestions(questions, ocrQuestions) : ocrQuestions;
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
    const result = db.prepare("INSERT INTO exams (title, filename, board) VALUES (?, ?, ?)").run(title, examFile.originalname, board);
    const insert = db.prepare("INSERT INTO questions (exam_id, number, statement, alternatives, correct_answer, page_number, context) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const question of questions) insert.run(result.lastInsertRowid, question.number, question.statement, JSON.stringify(question.alternatives), answerMap.get(question.number) ?? null, question.pageNumber ?? 1, question.context ?? null);
    const assetDir = path.join(examAssets, String(result.lastInsertRowid));
    await mkdir(assetDir, { recursive: true });
    const sourcePath = path.join(assetDir, "source.pdf");
    await writeFile(sourcePath, examFile.buffer);
    await writeFile(path.join(assetDir, "answer-key.pdf"), answerFile.buffer);
    try { await execFileAsync("pdftoppm", ["-jpeg", "-r", "110", sourcePath, path.join(assetDir, "page")]); } catch (error) { console.warn("Não foi possível renderizar as páginas", error); }
    res.status(201).json({ id: Number(result.lastInsertRowid), title, board, questionCount: questions.length });
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
