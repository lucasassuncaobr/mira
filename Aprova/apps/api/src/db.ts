import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const dataDir = path.resolve(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(dataDir, "aprova.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    board TEXT,
    status TEXT NOT NULL DEFAULT 'review',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    statement TEXT NOT NULL,
    alternatives TEXT NOT NULL DEFAULT '[]',
    correct_answer TEXT,
    subject TEXT,
    topic TEXT
  );
  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL REFERENCES questions(id),
    answer TEXT NOT NULL,
    is_correct INTEGER,
    elapsed_seconds INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

try { db.exec("ALTER TABLE questions ADD COLUMN page_number INTEGER"); } catch { /* coluna já existe */ }
try { db.exec("ALTER TABLE questions ADD COLUMN context TEXT"); } catch { /* coluna já existe */ }
try { db.exec("ALTER TABLE exams ADD COLUMN board TEXT"); } catch { /* coluna já existe */ }
try { db.exec("ALTER TABLE exams ADD COLUMN logo TEXT"); } catch { /* coluna já existe */ }

export function questionRow(row: Record<string, unknown>) {
  return { ...row, alternatives: JSON.parse(String(row.alternatives ?? "[]")) };
}
