export type ParsedQuestion = {
  number: number;
  statement: string;
  alternatives: { label: string; text: string }[];
  pageNumber?: number;
  context?: string;
};

export type ParsedAnswer = { number: number; answer: string };

// Sem flag /i: com /i a classe [A-Z...] aceita minúsculas e uma linha de
// continuação tipo "19 maiores economias do mundo" virava uma "questão 19"
// falsa — que cortava o bloco da questão seguinte e a fazia sumir do índice.
// O separador (ex.: "36.") também exige início de enunciado em maiúscula,
// aspa ou parêntese, para não capturar paginação ("15.") ou números decimais.
const questionStart = /(?:^|\n)[ \t]*(?:[Qq][Uu][Ee][Ss][Tt][AaãÃ][Oo][ \t]*)?(\d{1,3})(?:[ \t]*[.\-–):][ \t]*|[ \t]+)(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇN"'“‘(§])/gm;
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

  // Fase 1 — só blocos com alternativas são questões candidatas. Isto descarta
  // cabeçalho, paginação e a lista numerada das INSTRUÇÕES ("1. Confira...",
  // "10. O envelope..."), que aparece antes das questões reais e, sem este
  // filtro, definiria a ordem de leitura e faria as questões 1..9 parecerem
  // regressivas (e fossem descartadas).
  let lastNumber = 0;
  const ordered = matches.filter((match, index) => {
    const number = Number(match[1]);
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? normalized.length;
    const block = normalized.slice(start, end).trim();
    if ([...block.matchAll(alternativeStart)].length < 2) return false;
    // Fase 2 — na ordem de leitura os números só avançam: derruba duplicações
    // e falsos positivos com número regressivo (ex.: a linha de continuação
    // "19 maiores economias..." capturada depois da questão 20), que antes
    // cortavam o bloco da questão seguinte e a faziam sumir do índice.
    if (number <= lastNumber) return false;
    lastNumber = number;
    return true;
  });

  return ordered.flatMap((match, index) => {
    const number = Number(match[1]);
    const pageMatches = [...normalized.slice(0, match.index).matchAll(/\[\[PAGE:(\d+)\]\]/g)];
    const pageNumber = Number(pageMatches.at(-1)?.[1] ?? 1);
    const start = (match.index ?? 0) + match[0].length;
    const end = ordered[index + 1]?.index ?? normalized.length;
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

// Remove o ruído de marca d'água/coluna que o OCR gruda no fim da alternativa
// ("...dez dias. 4 VP"). Só remove quando o ÚLTIMO token é lixo em caixa-alta
// (e o grupo final até a palavra sólida também é suspeito): finais legítimos
// sem pontuação ("igual a 15", "venceu por 15") ficam intactos.
export function stripTrailingOcrNoise(value: string): string {
  const tokens = value.split(/\s+/);
  let start = tokens.length;
  while (start > 0) {
    const token = tokens[start - 1];
    if (/[.,;:!?…)\]]$/.test(token)) break;
    const letters = token.replace(/[^A-Za-zÀ-ÿ]/g, "");
    const compact = token.replace(/[^A-Za-zÀ-ÿ0-9]/g, "");
    const suspicious = (letters !== "" && !/[a-záéíóúâêôãõç]/.test(token)) || compact.length <= 2;
    if (!suspicious) break;
    start -= 1;
  }
  if (start === tokens.length) return value;
  const last = tokens[tokens.length - 1];
  const lastLetters = last.replace(/[^A-Za-zÀ-ÿ]/g, "");
  const isCapsGarbage = lastLetters.length >= 1 && lastLetters.length <= 4
    && lastLetters === lastLetters.toLocaleUpperCase("pt-BR");
  if (!isCapsGarbage) return value;
  return tokens.slice(0, start).join(" ").trimEnd();
}

export function cleanAlternativeText(value: string): string {
  const cleaned = cleanExtractedText(value);
  // Corta no cabeçalho do texto de apoio da PRÓXIMA questão ("Texto base
  // para as questões de 09 a 10", "TEXTO-BASE") e na citação fonte
  // ("Disponível em:") — sem isto, a última alternativa de uma questão
  // engolia o texto-base inteiro da questão seguinte.
  // Regra aprimorada: também corta em "Acesso em:" e em qualquer URL
  // (inclui links quebrados/encodados que o pdftotext espalha em várias linhas).
  let cut = cleaned.split(/(?:\b(?:TEXTO|QUADRO|TABELA|GR[ÁA]FICO|FIGURA)\s+[IVX\d]+\b|\btextos?[\s-]*base\b|\bdispon[íi]vel\s+em\s*[:：]|\bAcesso\s+em\s*[:：]|\bCONHECIMENTOS\s+[A-ZÁÉÍÓÚÇ ]+|\bCreate\s+table\b|\bselect\s+[A-Z_]+\s*\()/i)[0];
  // Segunda barreira: qualquer URL (http, www, .com, ou encodado %2F/%3A) não pertence à alternativa.
  // Usado como split para capturar links que aparecem mesmo sem o rótulo "Disponível em:".
  cut = cut.split(/(?:https?:\/\/|www\.|https?%3A|%2Fwww|\.com(?:\.br)?\b)/i)[0];
  // Remove resíduo de fragmento encodado que sobrevive ao split parcial
  // (ex: "7183654896889861%7Ctwgr%5E02bb..." — linha quebrada do link).
  cut = cut.replace(/\s+[A-Za-z0-9%_\-]{20,}[^\s]*\s*$/g, (m) => /%[0-9A-F]{2}|twsrc|twcamp|tweetembed|ref_url/i.test(m) ? "" : m);
  // Filtra linhas que são só fragmentos de URL
  cut = cut.split("\n").filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (/%[0-9A-F]{2}/i.test(t) && t.replace(/[^A-Za-z0-9%]/g, "").length > 20) return false;
    if (/^(?:https?:\/\/|www\.)/i.test(t)) return false;
    if (/twsrc|twcamp|tweetembed|ref_url/i.test(t)) return false;
    return true;
  }).join("\n");
  return normalizeQuestionFlow(cut);
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
  // Cada página do gabarito traz um cargo diferente ("CARGO / PROVA OBJETIVA /
  // GABARITO OFICIAL"). Responder por cargo — e não por matéria isolada — é o
  // que garante as 40 respostas do cargo certo, com todas as matérias juntas.
  const tabularSections: Array<{ title: string; cargo: string; answers: ParsedAnswer[] }> = [];
  let currentCargo = "";

  for (let index = 0; index < lines.length; index += 1) {
    if (/^gabarito oficial/i.test(lines[index])) {
      for (let back = index - 1; back >= 0 && back >= index - 6; back -= 1) {
        const candidate = lines[back];
        if (!candidate || /^(?:prova\s+|concurso\s+|prefeitura\s+|n[ií]vel\s+)/i.test(candidate)) continue;
        currentCargo = candidate;
        break;
      }
      continue;
    }
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
    // Linha única onde o cabeçalho da matéria encosta na resposta
    // ("06 B D CONHECIMENTOS ESPECÍFICOS", "20 C B") — um só par por linha.
    const hasSoloPair = sameLinePairs.length === 1 && lineDigits.length >= 1 && lineLetters.length >= 2;
    // Format: só letras na linha e números na anterior (já pego como split)
    const hasAnswerRow = lineLetters.length >= 4 && nextLetters.length === 0 && lineDigits.length === 0;

    if (isHeader) continue;
    if (!hasSplitPairs && !hasMixedPairs && !hasSoloPair && !hasAnswerRow) continue;

    let answers: Array<{ number: number; answer: string }> = [];

    if (hasSplitPairs) {
      const answerCells = nextLetters.length ? nextLetters : lineLetters;
      answers = lineDigits.map((num, i) => ({ number: num, answer: answerCells[i] ?? "" })).filter((a) => a.answer);
    } else if (hasMixedPairs || hasSoloPair) {
      answers = sameLinePairs;
    }

    if (answers.length < (hasSoloPair ? 1 : 2)) continue;

    let heading = "";
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (/^[A-E\s]+$/i.test(lines[cursor]) && !/[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-z]/.test(lines[cursor])) continue;
      if (/^Q\s*\d+/i.test(lines[cursor])) continue;
      if ( /^(?:www\.|pcimarkpci|concurso|prefeitura|gabarito|n[ií]vel\b)/i.test(lines[cursor])) continue;
      if (/^\d/.test(lines[cursor])) continue;
      heading = lines[cursor];
      break;
    }
    let section = tabularSections.find((s) => s.title === heading && s.cargo === currentCargo);
    if (!section) { section = { title: heading, cargo: currentCargo, answers: [] }; tabularSections.push(section); }
    for (const a of answers) section.answers.push(a);
  }

  if (tabularSections.length) {
    const cargo = examHint.match(/(?:^|\n)\s*CARGO\s*:\s*([^\n]+)/i)?.[1] ?? examHint.split("\n").slice(0, 25).join(" ");
    const hint = normalizedMatchText(cargo);
    const hintTokens = new Set(hint.split(" ").map((t) => t.replace(/s$/, "")).filter((t) => t.length >= 4));
    // Agrupa TODAS as matérias de cada cargo e ranqueia os grupos pelo cargo
    // da prova: o gabarito com vários cargos deixa de ser escolhido por
    // "maior matéria" e passa a ser escolhido pelo cargo informado no PDF.
    const cargoGroups = new Map<string, ParsedAnswer[]>();
    for (const section of tabularSections) {
      // Sem cabeçalho "GABARITO OFICIAL" o próprio título da seção faz o
      // papel de cargo (formatos legados "Q01 Q02 / A B C D").
      const key = section.cargo || section.title;
      const group = cargoGroups.get(key) ?? [];
      const seen = new Set(group.map((item) => item.number));
      for (const item of section.answers) if (!seen.has(item.number)) { group.push(item); seen.add(item.number); }
      cargoGroups.set(key, group);
    }
    const ranked = [...cargoGroups.entries()].map(([name, answers]) => {
      const tokens = normalizedMatchText(name).split(" ").map((t) => t.replace(/s$/, "")).filter((t) => t.length >= 4);
      const matches = tokens.filter((t) => hintTokens.has(t)).length;
      return { answers, score: matches * 10 - Math.abs(tokens.length - hintTokens.size) };
    }).sort((a, b) => b.score - a.score || b.answers.length - a.answers.length);
    if (ranked[0]) return ranked[0].answers;
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
