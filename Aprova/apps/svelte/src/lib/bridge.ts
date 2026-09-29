// Ponte tipada para os módulos vanilla em ./vendor (p2p/pdfcache/pdfmodal).
// Nenhuma lógica duplicada aqui: o Svelte atua como compilador,
// o runtime continua o mesmo.
import type { DayActivity, FocusEntry, PerfDay, SolveExam } from './solve-types';
import type { Exam } from './types';

// @ts-ignore — módulo JS sem tipos; contrato verificado contra vendor/p2p.js
import { getFocusMap, getPageSrc, hostExam, shutdownP2P } from './vendor/p2p.js';
// @ts-ignore — módulo JS sem tipos; contrato verificado contra vendor/pdfcache.js
import { warmPdfReader } from './vendor/pdfcache.js';
// @ts-ignore — módulo JS sem tipos; contrato verificado contra vendor/pdfmodal.js
import { PdfModal } from './vendor/pdfmodal.js';

export const API: string =
  (window as unknown as { __MIRA_API__?: string }).__MIRA_API__ ||
  (location.protocol.startsWith('http') ? `${location.origin}/api` : 'http://localhost:3333/api');

export async function fetchFocusMap(examId: number): Promise<Record<string, FocusEntry>> {
  return (await getFocusMap(examId)) as Record<string, FocusEntry>;
}

export async function fetchPageSrc(examId: number, page: number): Promise<string> {
  return (await getPageSrc(examId, page)) as string;
}

export function hostExamP2P(examId: number): void {
  void hostExam(examId);
}

export function shutdownP2PSafe(): void {
  void shutdownP2P();
}

export function warmPdf(examId: number, full = false): void {
  warmPdfReader(examId, full);
}

export function openPdfModal(examId: number, title: string, onClose: () => void): void {
  PdfModal.open(examId, title, onClose);
}

export async function postAnswer(
  questionId: number,
  answer: string,
): Promise<{ isCorrect?: boolean | null; correctAnswer?: string }> {
  const res = await fetch(`${API}/questions/${questionId}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer, elapsedSeconds: 0 }),
  });
  return (await res.json()) as { isCorrect?: boolean | null; correctAnswer?: string };
}

export function assetURL(path: string | null | undefined): string {
  const value = String(path ?? '');
  return value.startsWith('/') ? `${location.origin}${value}` : `${API}/${value}`;
}

export async function fetchExams(): Promise<Exam[]> {
  const response = await fetch(`${API}/exams`);
  return (await response.json()) as Exam[];
}

export async function fetchExam(id: number): Promise<SolveExam> {
  const response = await fetch(`${API}/exams/${id}`);
  const exam = (await response.json()) as SolveExam;
  // O banco pode trazer as alternativas em ordem invertida (D→A);
  // normaliza para ordem crescente de rótulo (A→D) na exibição.
  for (const q of exam.questions ?? []) {
    q.alternatives = [...(q.alternatives ?? [])].sort((a, b) =>
      String(a.label).localeCompare(String(b.label), 'pt-BR'),
    );
  }
  return exam;
}

export async function deleteExam(id: number): Promise<boolean> {
  const response = await fetch(`${API}/exams/${id}`, { method: 'DELETE' });
  return response.ok;
}

export async function fetchActivity(): Promise<DayActivity[]> {
  const response = await fetch(`${API}/activity`);
  return (await response.json()) as DayActivity[];
}

export async function fetchPerformance(): Promise<PerfDay[]> {
  const response = await fetch(`${API}/performance`);
  return (await response.json()) as PerfDay[];
}

export async function importExams(examFile: File, answerFile: File): Promise<{ id?: number; error?: string; status: number }> {
  const body = new FormData();
  body.append('exam', examFile);
  body.append('answerKey', answerFile);
  const response = await fetch(`${API}/exams/import`, { method: 'POST', body });
  const data = (await response.json().catch(() => ({}))) as { id?: number; error?: string };
  return { ...data, status: response.status };
}

export async function updateExamMeta(id: number, title: string, board: string, logo: File | null): Promise<boolean> {
  const fd = new FormData();
  fd.append('title', title);
  fd.append('board', board);
  if (logo) fd.append('logo', logo);
  const response = await fetch(`${API}/exams/${id}`, { method: 'PUT', body: fd });
  return response.ok;
}

export async function saveQuestion(q: {
  id: number;
  statement?: string;
  alternatives: { label: string; text: string }[];
  correct_answer?: string;
  subject?: string;
  topic?: string;
}): Promise<void> {
  await fetch(`${API}/questions/${q.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      statement: q.statement,
      alternatives: q.alternatives,
      correctAnswer: q.correct_answer,
      subject: q.subject,
      topic: q.topic,
    }),
  });
}

export function formatStudyTime(totalSeconds: number): string {
  const seconds = Number(totalSeconds ?? 0);
  if (seconds < 60) return '0min';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}min`;
}

export function formatTimer(totalSeconds: number): string {
  const s = Number(totalSeconds ?? 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return [h, m, r].map((v) => String(v).padStart(2, '0')).join(':');
}
