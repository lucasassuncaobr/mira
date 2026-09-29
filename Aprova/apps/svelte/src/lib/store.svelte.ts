// Store global + roteamento por hash (#view, #solve/id):
// replaceState no boot, pushState só em troca real de view, popstate
// restaura, e fallback de 500ms abre a primeira prova em solve órfão.
import type { Exam } from './types';
import type { SolveExam } from './solve-types';
import { deleteExam, fetchExam, fetchExams } from './bridge';

export type View = 'dashboard' | 'exams' | 'performance' | 'import' | 'review' | 'solve';

const VIEWS: View[] = ['exams', 'performance', 'import', 'review', 'solve'];

const TITLES: Record<View, string> = {
  dashboard: 'Sua preparação, em um só lugar',
  exams: 'Suas provas',
  performance: 'Seu desempenho',
  import: 'Importar nova prova',
  review: 'Revisar questões',
  solve: 'Resolver prova',
};

class AppStore {
  view = $state<View>('exams');
  exams = $state<Exam[]>([]);
  exam = $state<SolveExam | null>(null);
  loading = $state(false);
  error = $state('');

  historyView: View | null = null;
  fallbackAttempted = false;
  private fallbackTimer: number | undefined = undefined;

  titleOf(view: View): string {
    return TITLES[view] ?? TITLES.exams;
  }

  async refresh(): Promise<void> {
    this.exams = await fetchExams();
    this.error = '';
  }

  setView(view: View): void {
    this.view = view;
    if (this.historyView === view) return;
    const currentHash = window.location.hash.replace('#', '');
    const hashMatch = currentHash.match(/^(solve)(?:\/(\d+))?$/);
    const examId = hashMatch?.[2];
    window.history.pushState(
      { view, examId: examId ? Number(examId) : undefined },
      '',
      `${window.location.pathname}#${view}${examId ? `/${examId}` : ''}`,
    );
    this.historyView = view;
  }

  async openExam(id: number, nextView: View): Promise<void> {
    this.exam = await fetchExam(id);
    this.view = nextView;
    window.history.replaceState({ view: nextView, examId: id }, '', `${window.location.pathname}#${nextView}/${id}`);
    this.historyView = nextView;
  }

  async removeExam(id: number): Promise<void> {
    if (!window.confirm('Remover esta prova e todo o histórico dela?')) return;
    const ok = await deleteExam(id);
    if (!ok) {
      this.error = 'Não foi possível remover a prova.';
      return;
    }
    await this.refresh();
  }

  initRouter(): () => void {
    void this.refresh().catch(() => {
      this.error = 'A API não está disponível.';
    });
    const hash = window.location.hash.replace('#', '');
    const match = hash.match(/^(solve)(?:\/(\d+))?$/);
    const plainView = (VIEWS as string[]).includes(hash);
    const initialView: View = match ? 'solve' : plainView ? (hash as View) : 'exams';
    const examId = match?.[2];
    this.historyView = initialView;
    this.view = initialView;
    if (examId) {
      fetchExam(Number(examId))
        .then((e) => {
          this.exam = e;
        })
        .catch(() => undefined);
    }
    window.history.replaceState(
      { view: initialView, examId: examId ? Number(examId) : undefined },
      '',
      `${window.location.pathname}#${initialView}${examId ? `/${examId}` : ''}`,
    );
    const onPopState = (event: PopStateEvent) => {
      const state = event.state as { view?: string; examId?: number } | null;
      const target = state?.view;
      const restoredView: View =
        target && (VIEWS as string[]).includes(target) ? (target as View) : 'exams';
      this.historyView = restoredView;
      this.view = restoredView;
      if (state?.examId && restoredView === 'solve') {
        fetchExam(state.examId)
          .then((e) => {
            this.exam = e;
          })
          .catch(() => undefined);
      } else {
        this.exam = null;
      }
    };
    window.addEventListener('popstate', onPopState);
    this.fallbackTimer = window.setInterval(() => {
      if (this.view === 'solve' && !this.exam && !this.fallbackAttempted && this.exams.length > 0) {
        this.fallbackAttempted = true;
        const fallbackId = this.exams[0].id;
        window.history.replaceState(
          { view: 'solve', examId: fallbackId },
          '',
          `${window.location.pathname}#solve/${fallbackId}`,
        );
        fetchExam(fallbackId)
          .then((e) => {
            this.exam = e;
          })
          .catch(() => undefined);
      }
    }, 500);
    return () => {
      window.removeEventListener('popstate', onPopState);
      if (this.fallbackTimer !== undefined) window.clearInterval(this.fallbackTimer);
    };
  }
}

export const app = new AppStore();
