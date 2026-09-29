// Tipos do Solver — espelham o contrato JSON da API Go (Fiber).
// Geometria do foco sempre em % normalizada (0..100), nunca pixels.

export type Alternative = { label: string; text: string };

export type Question = {
  id: number;
  number: number;
  page_number?: number;
  statement?: string;
  context?: string;
  alternatives: Alternative[];
  correct_answer?: string;
  subject?: string;
  topic?: string;
};

export type DayActivity = { date?: string; label?: string; count?: number };

export type PerfDay = { day?: string; answered?: number };

export type SolveExam = {
  id: number;
  title: string;
  questions: Question[];
};

export type FocusEntry = {
  page?: number;
  y_inicio?: number | null;
  x_center?: number;
  focus_height?: number;
  focus_scale?: number;
};

export type Feedback = {
  correct: boolean;
  correctAnswer: string;
  unknown?: boolean;
};
