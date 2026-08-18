import { FileText } from "lucide-react";
import "./MiraCard.css";

type ApiAlternative = { label: string; text: string };
type ApiQuestion = { id: number; number: number; statement: string; alternatives: ApiAlternative[]; correct_answer: string | null; page_number?: number | null };
type ApiExam = { id: number; title: string; questions?: ApiQuestion[] };

export function MiraCard({ exam, renderPdf }: { exam?: ApiExam | null; renderPdf?: (page: number, questionNumber: number) => React.ReactNode }) {
  const questions = exam?.questions ?? [];
  const question = questions[0];
  const displayNumber = question?.number ?? 1;
  const page = question?.page_number ?? 1;

  return (
    <div className="mira-solve">
      <aside className="mira-pdf-panel">
        {renderPdf ? (
          renderPdf(page, displayNumber)
        ) : (
          <>
            <div className="mira-pdf-header">
              <svg className="mira-pdf-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className="mira-pdf-title">Questão {displayNumber} no PDF</span>
            </div>
            <div className="mira-pdf-viewer">
              <div className="mira-pdf-content">
                <div className="mira-pdf-page">
                  <p><strong>{displayNumber}.</strong> {question?.statement}</p>
                </div>
              </div>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
