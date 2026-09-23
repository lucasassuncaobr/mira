import assert from "node:assert/strict";
import test from "node:test";
import { cleanAlternativeText, cleanExtractedText, formatExamTitle, inferExamBoard, inferExamTitle, parseAnswerKey, parseQuestions, stripTrailingOcrNoise } from "./parser.js";

test("extrai questões e alternativas", () => {
  const result = parseQuestions(`Questão 1. Qual é a capital do Brasil?\nA) Rio de Janeiro\nB) Brasília\nC) Salvador\n2 - A Constituição foi promulgada em:\nA. 1988\nB. 1990`);
  assert.equal(result.length, 2);
  assert.equal(result[0].statement, "Qual é a capital do Brasil?");
  assert.equal(result[0].alternatives[1].text, "Brasília");
  assert.equal(result[1].number, 2);
});

test("reconhece questão sem espaço depois do número", () => {
  const result = parseQuestions("9. Primeira?\nA) Um\nB) Dois\n10.Na segunda questão?\nA) Três\nB) Quatro");
  assert.equal(result.length, 2);
  assert.equal(result[1].number, 10);
  assert.equal(result[1].statement, "Na segunda questão?");
});

test("não vira questão a linha de continuação que começa com número", () => {
  // Regressão: "19 maiores economias..." é continuação do enunciado da 21 e
  // já foi capturada como questão falsa, fazendo a 21 sumir do índice.
  const text = [
    "20 A reunião do G20 é formada pelas",
    "19 maiores economias do mundo e pela União Europeia.",
    "(A) No Pará, em novembro de 2025.",
    "(B) No Rio de Janeiro, em novembro de 2024.",
    "22 Segundo o PNUD, o índice mede",
    "(A) desenvolvimento humano.",
    "(B) produção de energia."
  ].join("\n");
  const result = parseQuestions(text);
  assert.deepEqual(result.map((question) => question.number), [20, 22]);
  assert.equal(result[0].alternatives.length, 2);
});

test("descarta número repetido ou fora de ordem na leitura", () => {
  const text = [
    "5 Qual é o processo de troca de gases?",
    "(A) Fotossíntese.",
    "(B) Respiração.",
    "3 Continuação com número regressivo do texto base.",
    "(C) Transpiração.",
    "(D) Fermentação.",
    "6 Próxima questão válida?",
    "(A) Um.",
    "(B) Dois."
  ].join("\n");
  assert.deepEqual(parseQuestions(text).map((question) => question.number), [5, 6]);
});

test("instruções numeradas antes das questões não descartam a questão 1", () => {
  // Regressão: a lista "1. Confira... 10. O envelope..." do cabeçalho casava
  // como questão e definia a ordem, fazendo as questões reais 1..9 parecerem
  // regressivas e sumirem do índice.
  const text = [
    "INSTRUÇÕES AO CANDIDATO",
    "1. Confira se, além desta PROVA com 40 questões, você recebeu o cartão resposta.",
    "2. Confira se o seu número de inscrição consta no cartão resposta.",
    "10. O envelope deve permanecer embaixo da carteira.",
    "LÍNGUA PORTUGUESA",
    "1 Com base no texto, é correto afirmar?",
    "(A) Item um.",
    "(B) Item dois.",
    "2 No trecho destacado, o autor afirma?",
    "(A) Item três.",
    "(B) Item quatro."
  ].join("\n");
  assert.deepEqual(parseQuestions(text).map((question) => question.number), [1, 2]);
});

test("encerra alternativa antes de um novo texto de apoio", () => {
  assert.equal(cleanAlternativeText("sujeito.\nTexto II\nFuga da Coreia do Norte"), "sujeito.");
});

test("remove letra isolada capturada da coluna vizinha", () => {
  assert.equal(cleanAlternativeText("null. A"), "null.");
});

test("remove ruído de marca d'água no final de alternativa vinda de OCR", () => {
  // Fragmentos lidos da marca d'água diagonal pelo OCR, no fim da linha.
  assert.equal(stripTrailingOcrNoise("trinta dias do encerramento, por pelo menos dez dias. 4 VP"),
    "trinta dias do encerramento, por pelo menos dez dias.");
  assert.equal(stripTrailingOcrNoise("trinta e cinco dias, por pelo menos doze dias. am UU L"),
    "trinta e cinco dias, por pelo menos doze dias.");
  assert.equal(stripTrailingOcrNoise("quarenta e cinco dias, por pelo menos quinze dias. Va é É"),
    "quarenta e cinco dias, por pelo menos quinze dias.");
});

test("preserva finais legítimos sem pontuação", () => {
  assert.equal(stripTrailingOcrNoise("igual a 15"), "igual a 15");
  assert.equal(stripTrailingOcrNoise("venceu por 15"), "venceu por 15");
  assert.equal(stripTrailingOcrNoise("igual a, podendo aumentar de acordo com a arrecadação municipal"),
    "igual a, podendo aumentar de acordo com a arrecadação municipal");
  assert.equal(stripTrailingOcrNoise("respeitados os limites constitucionais."), "respeitados os limites constitucionais.");
});

test("corta o texto-base da questão seguinte capturado pela alternativa", () => {
  const polluted = [
    "ocorre uma relação de concordância entre o sujeito oculto “eu” e o verbo “acabei”.",
    "Texto base para as questões de 09 a 10.",
    "Post KIRIDINinha @OlhaKiridinha",
    "Disponível em: https://x.com/OlhaKiridinha/status/1347183654896889861. Acesso em: 29 jul. 2024."
  ].join("\n");
  assert.equal(
    cleanAlternativeText(polluted),
    "ocorre uma relação de concordância entre o sujeito oculto “eu” e o verbo “acabei”."
  );
});

test("normaliza títulos legados", () => {
  assert.equal(formatExamTitle("analista_de_sistemas"), "Analista de Sistemas");
});

test("remove links, códigos e cabeçalhos das alternativas", () => {
  assert.equal(cleanExtractedText("apenas em V.\npcimarkpci\nMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw\nwww.pciconcursos.com.br\n~ 3 ~\nCARGO: ANALISTA"), "apenas em V.");
});

test("extrai respostas do gabarito", () => {
  assert.deepEqual(parseAnswerKey("1. B  2 - A  Questão 3: D"), [{ number: 1, answer: "B" }, { number: 2, answer: "A" }, { number: 3, answer: "D" }]);
});

test("seleciona o cargo correto em gabarito tabular", () => {
  const text = `AUXILIAR ADMINISTRATIVO\nQ01 Q02 Q03 Q04\nA B C D\nANALISTA DE SISTEMAS\nQ01 Q02 Q03 Q04\nC A B D`;
  assert.deepEqual(parseAnswerKey(text, "CARGO: ANALISTA DE SISTEMA"), [
    { number: 1, answer: "C" }, { number: 2, answer: "A" }, { number: 3, answer: "B" }, { number: 4, answer: "D" }
  ]);
});

test("sugere título usando o conteúdo", () => {
  assert.equal(inferExamTitle("PROVA\nAnalista de Sistemas - 2026\nQuestão 1. Texto", "arquivo.pdf"), "Analista de Sistemas - 2026");
});

test("identifica banca pelo texto extraído do PDF", () => {
  assert.equal(inferExamBoard("Concurso público\nBanca: AUJURI\nCargo: Professor"), "AUJURI");
  assert.equal(inferExamBoard("Caderno de prova elaborado pela Fundação VUNESP para o edital."), "VUNESP");
});

test("extrai respostas do formato misto 01 D B 21 B C", () => {
  const text = `ANALISTA DE SISTEMAS\n01 D B 21 B C\n02 C A 22 A D\n03 B D 23 C A\n04 A C 24 D B`;
  const answers = parseAnswerKey(text, "CARGO: ANALISTA DE SISTEMAS").sort((a, b) => a.number - b.number);
  assert.equal(answers.length, 8);
  assert.deepEqual(answers[0], { number: 1, answer: "D" });
  assert.deepEqual(answers[1], { number: 2, answer: "C" });
  assert.deepEqual(answers[3], { number: 4, answer: "A" });
  assert.deepEqual(answers[4], { number: 21, answer: "B" });
});

test("extrai respostas do formato misto sem hint", () => {
  const text = `01 D B 21 B C\n02 C A 22 A D\n03 B D 23 C A\n04 A C 24 D B`;
  const answers = parseAnswerKey(text, "").sort((a, b) => a.number - b.number);
  assert.equal(answers.length, 8);
  assert.deepEqual(answers[0], { number: 1, answer: "D" });
});
