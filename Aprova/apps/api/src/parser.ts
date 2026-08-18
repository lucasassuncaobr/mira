export type ParsedQuestion = {
  number: number;
  statement: string;
  alternatives: { label: string; text: string }[];
  pageNumber?: number;
  context?: string;
};

export type ParsedAnswer = { number: number; answer: string };

const questionStart = /(?:^|\n)[ \t]*(?:quest[aã]o[ \t]*)?(\d{1,3})(?:[ \t]*[.\-–):][ \t]*|[ \t]+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇN]))/gim;
const alternativeStart = /(?:^|\n)\s*\(?([A-E])\s*[).\-–]\s+/gim;

export function parseQuestions(text: string): ParsedQuestion[] {
  const normalized = text.replace(/\r/g, "").replace(/[ \t]+/g, " ");
  const matches = [...normalized.matchAll(questionStart)];
  const pageContexts = new Map<number, string>();
  for (const page of normalized.split(/(?=\[\[PAGE:\d+\]\])/)) {
    const pageMatch = page.match(/^\[\[PAGE:(\d+)\]\]/);
    if (!pageMatch) continue;
    const content = page.slice(pageMatch[0].length);
    const firstQuestion = content.search(questionStart);
    const context = cleanExtractedText(firstQuestion >= 0 ? content.slice(0, firstQuestion) : content);
    if (context.length >= 30) pageContexts.set(Number(pageMatch[1]), context);
  }

  return matches.flatMap((match, index) => {
    const number = Number(match[1]);
    const pageMatches = [...normalized.slice(0, match.index).matchAll(/\[\[PAGE:(\d+)\]\]/g)];
    const pageNumber = Number(pageMatches.at(-1)?.[1] ?? 1);
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? normalized.length;
    const block = normalized.slice(start, end).trim();
    const alternatives = [...block.matchAll(alternativeStart)];

    if (!block) return [];
    if (!alternatives.length) {
      return [{ number, statement: normalizeQuestionFlow(cleanExtractedText(block)), alternatives: [], pageNumber, context: pageContexts.get(pageNumber) }];
    }

    const statement = normalizeQuestionFlow(cleanExtractedText(block.slice(0, alternatives[0].index)));
    const options = alternatives.map((alternative, optionIndex) => {
      const optionStart = (alternative.index ?? 0) + alternative[0].length;
      const optionEnd = alternatives[optionIndex + 1]?.index ?? block.length;
      return { label: alternative[1].toUpperCase(), text: cleanAlternativeText(block.slice(optionStart, optionEnd)) };
    });

    return [{ number, statement, alternatives: options, pageNumber, context: pageContexts.get(pageNumber) }];
  });
}

export function cleanAlternativeText(value: string): string {
  const cleaned = cleanExtractedText(value);
  return normalizeQuestionFlow(cleaned.split(/(?:\b(?:TEXTO|QUADRO|TABELA|GR[ÁA]FICO|FIGURA)\s+[IVX\d]+\b|\bCONHECIMENTOS\s+[A-ZÁÉÍÓÚÇ ]+|\bCreate\s+table\b|\bselect\s+[A-Z_]+\s*\()/i)[0]);
}

function normalizeQuestionFlow(value: string): string {
  return value.replace(/-\n(?=\p{Ll})/gu, "-").replace(/\n+/g, " ").replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([.!?])\s+[A-D]$/i, "$1").trim();
}

export function cleanExtractedText(value: string): string {
  const noise = [
    /^\[\[PAGE:\d+\]\]$/i, /^~?\s*\d+\s*~?$/, /^(?:https?:\/\/|www\.)\S+/i,
    /^pci(?:markpci|concursos)/i, /^cargo\s*:/i, /^p[aá]gina\s+\d+/i,
    /^[A-Za-z0-9+/=_-]{35,}$/, /(?:www\.|https?:\/\/|\.com\.br\b)/i
  ];
  return value.split("\n").map((line) => line.trim()).filter((line) => line && !noise.some((pattern) => pattern.test(line))).join("\n").trim()
    .replace(/[ \t]+([,.;:!?])/g, "$1").replace(/([“‘(])\s+/g, "$1").replace(/\s+([”’])/g, "$1");
}

function normalizedMatchText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeOcrDigits(value: string): string {
  return value
    .replace(/[Oo](?=\d)/g, "0")
    .replace(/(?<=\d)[lL]/g, "1")
    .replace(/(?<=\b\d)[lL](?=\s)/g, "1")
    .replace(/(?<=\bQ(?:uest[aã]o)?\s*)\d*[lL]/gi, (m) => m.replace(/[lL]/g, "1"))
    .replace(/(?<=\bQ(?:uest[aã]o)?\s*)O+(?=\s)/gi, (m) => m.replace(/O/gi, "0"));
}

function extractSameLinePairs(line: string): Array<{ number: number; answer: string }> {
  const cleaned = normalizeOcrDigits(line);
  return [...cleaned.matchAll(/\b(\d{1,3})\s+([A-E])\b/gi)]
    .map((m) => ({ number: Number(m[1]), answer: m[2].toUpperCase() }));
}

export function parseAnswerKey(text: string, examHint = ""): ParsedAnswer[] {
  const rawLines = text.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  const lines = rawLines.map((l) => l.replace(/\s+/g, " "));
  const tabularSections: Array<{ title: string; answers: ParsedAnswer[] }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const cleanLine = lines[index].replace(/\bQ(?=\s*\d)/gi, "");
    const lineDigits = [...cleanLine.matchAll(/\b(\d{1,3})\b/g)].map((m) => Number(m[1]));
    const lineLetters = [...lines[index].matchAll(/\b([A-E])\b/gi)].map((m) => m[1].toUpperCase());
    const nextLetters = index < lines.length - 1 ? [...lines[index + 1].matchAll(/\b([A-E])\b/gi)].map((m) => m[1].toUpperCase()) : [];
    const isHeader = /(?:quest[aã]o|prova\s+tipo|tipo\s+\d)/i.test(lines[index]);
    const sameLinePairs = extractSameLinePairs(lines[index]);

    // Format: números puros na linha + letras na linha seguinte (Q01 Q02 / A B)
    const hasSplitPairs = lineDigits.length >= 3 && nextLetters.length >= 2 && lineDigits.every((n) => n >= 1 && n <= 99);
    // Format: números e letras mesclados na mesma linha (01 D B 21 B C)
    const hasMixedPairs = sameLinePairs.length >= 2 && lineDigits.length >= 2 && lineLetters.length >= 2;
    // Format: só letras na linha e números na anterior (já pego como split)
    const hasAnswerRow = lineLetters.length >= 4 && nextLetters.length === 0 && lineDigits.length === 0;

    if (isHeader) continue;
    if (!hasSplitPairs && !hasMixedPairs && !hasAnswerRow) continue;

    let answers: Array<{ number: number; answer: string }> = [];

    if (hasSplitPairs) {
      const answerCells = nextLetters.length ? nextLetters : lineLetters;
      answers = lineDigits.map((num, i) => ({ number: num, answer: answerCells[i] ?? "" })).filter((a) => a.answer);
    } else if (hasMixedPairs) {
      answers = sameLinePairs;
    }

    if (answers.length < 2) continue;

    let heading = "";
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (/^[A-E\s]+$/i.test(lines[cursor]) && !/[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-z]/.test(lines[cursor])) continue;
      if (/^Q\s*\d+/i.test(lines[cursor])) continue;
      if (/^(?:www\.|pcimarkpci|concurso|prefeitura|gabarito|n[ií]vel\b)/i.test(lines[cursor])) continue;
      if (/^\d/.test(lines[cursor])) continue;
      heading = lines[cursor];
      break;
    }
    let section = tabularSections.find((s) => s.title === heading);
    if (!section) { section = { title: heading, answers: [] }; tabularSections.push(section); }
    for (const a of answers) section.answers.push(a);
  }

  if (tabularSections.length) {
    const cargo = examHint.match(/(?:^|\n)\s*CARGO\s*:\s*([^\n]+)/i)?.[1] ?? examHint.split("\n").slice(0, 25).join(" ");
    const hint = normalizedMatchText(cargo);
    const hintTokens = new Set(hint.split(" ").map((t) => t.replace(/s$/, "")).filter((t) => t.length >= 4));

    if (hintTokens.size > 0) {
      const ranked = tabularSections.map((section) => {
        const tokens = normalizedMatchText(section.title).split(" ").map((t) => t.replace(/s$/, "")).filter((t) => t.length >= 4);
        const matches = tokens.filter((t) => hintTokens.has(t)).length;
        return { section, score: matches * 10 - Math.abs(tokens.length - hintTokens.size) };
      }).sort((a, b) => b.score - a.score || b.section.answers.length - a.section.answers.length);
      if (ranked[0] && (ranked[0].score > 0 || tabularSections.length === 1))
        return [...new Map(ranked[0].section.answers.map((item) => [item.number, item])).values()];
    }
    const best = tabularSections.sort((a, b) => b.answers.length - a.answers.length)[0];
    if (best) return [...new Map(best.answers.map((item) => [item.number, item])).values()];
  }

  const normalized = normalizeOcrDigits(text.replace(/\r/g, " ").replace(/\s+/g, " "));
  const patterns = [
    /(?:quest[aã]o\s*)?(\d{1,3})\s*[.\-–):]?\s*([A-E])\b/gi,
    /\b(\d{1,3})\s+([A-E])\b/gi
  ];
  for (const pattern of patterns) {
    const answers = [...normalized.matchAll(pattern)].map((match) => ({ number: Number(match[1]), answer: match[2].toUpperCase() }));
    if (answers.length) return [...new Map(answers.map((item) => [item.number, item])).values()];
  }
  return [];
}

export function inferExamTitle(text: string, filename: string): string {
  const lines = text.replace(/\r/g, "").split("\n").map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 4 && line.length <= 100 && /[A-Za-zÀ-ÿ]/.test(line));
  const ignored = /^(?:p[aá]gina|quest[aã]o|instru[cç][oõ]es|leia|nome|assinatura|dura[cç][aã]o|marque|aguarde)\b/i;
  const signals = /\b(?:prefeitura|munic[ií]pio|estado|tribunal|universidade|instituto|concurso|processo seletivo|vestibular|gurupi|palmas|cargo|analista|professor|t[eé]cnico|agente)\b/i;
  const ranked = lines.filter((line) => !ignored.test(line)).map((line, index) => ({ line, score: (signals.test(line) ? 5 : 0) + (/\b20\d{2}\b/.test(line) ? 2 : 0) + (index < 12 ? 2 : 0) + (line.length < 65 ? 1 : 0) }));
  const candidate = ranked.sort((a, b) => b.score - a.score)[0]?.line;
  const fallback = filename.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return formatExamTitle(candidate || fallback || "Prova sem título");
}

export function inferExamBoard(text: string): string | null {
  const normalized = text.replace(/\r/g, "\n").replace(/[ \t]+/g, " ");
  const explicit = normalized.match(/\b(?:banca|organizadora|institui[cç][aã]o\s+organizadora|executor[ao]|respons[aá]vel)\s*[:\-–]\s*([^\n]{2,80})/i)?.[1];
  const cleanedExplicit = explicit ? cleanBoardName(explicit) : "";
  if (cleanedExplicit) return cleanedExplicit;

  const knownBoards = [
    "CEBRASPE", "CESPE", "FGV", "FCC", "VUNESP", "IBFC", "INSTITUTO AOCP", "AOCP", "IDECAN",
    "QUADRIX", "FUNDATEC", "FADESP", "CONSULPLAN", "IBADE", "FUNCERN", "CETAP", "SELECON",
    "IESES", "OBJETIVA", "LEGALLE", "AVANÇA SP", "FUMARC", "CONSULPAM", "INSTITUTO MAIS",
    "FEPESE", "COPESE", "COPEVE", "NC-UFPR", "FAUEL", "AUJURI"
  ];
  const searchable = normalized.toLocaleUpperCase("pt-BR");
  return knownBoards.find((board) => new RegExp(`(?:^|[^A-ZÀ-Ú0-9])${escapeRegExp(board)}(?:$|[^A-ZÀ-Ú0-9])`, "u").test(searchable)) ?? null;
}

function cleanBoardName(value: string): string {
  return value
    .split(/\s{2,}|(?:\s+-\s+)|(?:\s+–\s+)|\b(?:prova|cargo|edital|concurso|data)\b/i)[0]
    .replace(/[.;,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleUpperCase("pt-BR")
    .slice(0, 40);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatExamTitle(title: string): string {
  const minor = new Set(["a", "as", "o", "os", "da", "das", "de", "do", "dos", "e", "em", "para"]);
  return title.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().toLocaleLowerCase("pt-BR").split(" ")
    .map((word, index) => index && minor.has(word) ? word : word.replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase("pt-BR"))).join(" ");
}
