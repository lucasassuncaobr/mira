import assert from "node:assert/strict";
import test from "node:test";
import { cleanAlternativeText, cleanExtractedText, formatExamTitle, inferExamBoard, inferExamTitle, parseAnswerKey, parseQuestions } from "./parser.js";

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

test("encerra alternativa antes de um novo texto de apoio", () => {
  assert.equal(cleanAlternativeText("sujeito.\nTexto II\nFuga da Coreia do Norte"), "sujeito.");
});

test("remove letra isolada capturada da coluna vizinha", () => {
  assert.equal(cleanAlternativeText("null. A"), "null.");
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
