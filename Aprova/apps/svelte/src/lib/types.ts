export type Exam = {
  id: number; title: string; filename: string; board?: string; status?: string;
  question_count: number; answered_count?: number; correct_count?: number;
  wrong_count?: number; study_seconds?: number; created_at: string; logo?: string;
};
