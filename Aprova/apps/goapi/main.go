// Mira API — versão Go pura (sem Python).
//
// Mesma API do Express (apps/api/src/server.ts), usando PDF Oxide
// e tesseract-ocr como binários CLI nativos. Sem runtime Python ou Node.
package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/compress"
	"github.com/gofiber/fiber/v2/middleware/cors"
	_ "modernc.org/sqlite"
)

const schema = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    board TEXT,
    status TEXT NOT NULL DEFAULT 'review',
    sha256 TEXT,
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
  );`

var migrations = []string{
	"ALTER TABLE questions ADD COLUMN page_number INTEGER",
	"ALTER TABLE questions ADD COLUMN context TEXT",
	"ALTER TABLE questions ADD COLUMN y_inicio REAL",
	"ALTER TABLE questions ADD COLUMN x_center REAL",
	"ALTER TABLE questions ADD COLUMN focus_height REAL",
	"ALTER TABLE questions ADD COLUMN focus_scale REAL",
	"ALTER TABLE exams ADD COLUMN board TEXT",
	"ALTER TABLE exams ADD COLUMN logo TEXT",
	"ALTER TABLE exams ADD COLUMN sha256 TEXT",
	"CREATE UNIQUE INDEX IF NOT EXISTS idx_exams_sha256 ON exams(sha256)",
}

func exeSibling(dir, sibling string) string {
	if exe, err := os.Executable(); err == nil {
		cand := filepath.Join(filepath.Dir(exe), "..", sibling)
		if st, err := os.Stat(cand); err == nil && st.IsDir() {
			return cand
		}
	}
	return filepath.Join(dir, "..", sibling)
}

var dataDirUsed string

func openDB() *sql.DB {
	dataDir := os.Getenv("MIRA_DATA_DIR")
	if dataDir == "" {
		dataDir = exeSibling("..", filepath.Join("api", "data"))
	}
	dataDirUsed = dataDir
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(dataDir, "aprova.db"))
	if err != nil {
		log.Fatal(err)
	}
	// Conexão única: BEGIN/COMMIT manuais exigem o mesmo handle (igual ao Node).
	db.SetMaxOpenConns(1)
	// Leveza: menos fsync (WAL é seguro em NORMAL), espera em lock em vez
	// de SQLITE_BUSY imediato, cache e mmap generosos para um banco minúsculo.
	for _, pragma := range []string{
		"PRAGMA synchronous = NORMAL",
		"PRAGMA busy_timeout = 5000",
		"PRAGMA cache_size = -16000",
		"PRAGMA mmap_size = 67108864",
		"PRAGMA temp_store = MEMORY",
	} {
		if _, err := db.Exec(pragma); err != nil {
			log.Fatal(err)
		}
	}
	if _, err := db.Exec(schema); err != nil {
		log.Fatal(err)
	}
	for _, m := range migrations {
		_, _ = db.Exec(m) // coluna já existe → ignora
	}
	// Backfill do sha256 para provas importadas antes da coluna existir.
	if rows, err := db.Query("SELECT id FROM exams WHERE sha256 IS NULL OR sha256 = ''"); err == nil {
		var ids []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err == nil {
				ids = append(ids, id)
			}
		}
		rows.Close()
		for _, id := range ids {
			buf, err := os.ReadFile(filepath.Join(dataDir, "exam-assets", strconv.FormatInt(id, 10), "source.pdf"))
			if err != nil || len(buf) == 0 {
				continue
			}
			sum := sha256.Sum256(buf)
			_, _ = db.Exec("UPDATE exams SET sha256 = ? WHERE id = ?", hex.EncodeToString(sum[:]), id)
		}
	}
	return db
}

// Checkpoint periódico do WAL: devolve as páginas ao db principal e impede
// o arquivo -wal de crescer sem limite em uso contínuo. Conexão única, então
// nunca concorre com outra escrita (busy_timeout cobre o resto).
func periodicCheckpoint(db *sql.DB) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		if _, err := db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
			log.Printf("wal checkpoint: %v", err)
		}
	}
}

func main() {
	db := openDB()
	defer db.Close()
	if _, err := db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		log.Printf("wal checkpoint inicial: %v", err)
	}
	go periodicCheckpoint(db)
	gdb = db
	if err := prepareHot(); err != nil {
		log.Fatal(err)
	}
	assetsDir = filepath.Join(dataDirUsed, "exam-assets")

	app := fiber.New(fiber.Config{DisableStartupMessage: true, BodyLimit: 22 * 1024 * 1024})
	app.Use(cors.New())
	// Brotli/gzip negociado (fasthttp): bundle JS/CSS e JSON menores
	// para redes lentas; custo irrelevante no servidor local.
	app.Use(compress.New())
	app.Use(func(c *fiber.Ctx) error {
		c.Set("Cache-Control", "no-store, no-cache, must-revalidate")
		c.Set("Cross-Origin-Resource-Policy", "cross-origin")
		return c.Next()
	})

	app.Get("/api/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok", "name": "Mira API"})
	})

	registerRoutes(app)
	registerWeb(app)

	app.Get("/api/exams", func(c *fiber.Ctx) error {
		rows, err := db.Query(`
    SELECT e.id, e.title, e.filename, e.board, e.status, e.created_at, e.logo, COUNT(q.id) AS question_count,
      SUM(CASE WHEN la.id IS NOT NULL THEN 1 ELSE 0 END) AS answered_count,
      SUM(CASE WHEN la.is_correct = 1 THEN 1 ELSE 0 END) AS correct_count,
      SUM(CASE WHEN la.is_correct = 0 THEN 1 ELSE 0 END) AS wrong_count,
      COALESCE(SUM(la.elapsed_seconds), 0) AS study_seconds
    FROM exams e
    LEFT JOIN questions q ON q.exam_id = e.id
    LEFT JOIN attempts la ON la.id = (SELECT a.id FROM attempts a WHERE a.question_id = q.id ORDER BY a.id DESC LIMIT 1)
    GROUP BY e.id ORDER BY e.id DESC`)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "Não foi possível concluir a operação"})
		}
		defer rows.Close()
		out := []fiber.Map{}
		for rows.Next() {
			var id int64
			var title, filename, createdAt string
			var board, status, logo sql.NullString
			var qc int64
			var answered, correct, wrong sql.NullInt64
			var study int64
			if err := rows.Scan(&id, &title, &filename, &board, &status, &createdAt, &logo,
				&qc, &answered, &correct, &wrong, &study); err != nil {
				return c.Status(500).JSON(fiber.Map{"error": "Não foi possível concluir a operação"})
			}
			item := fiber.Map{
				"id": id, "title": title, "filename": filename,
				"created_at": createdAt, "question_count": qc, "study_seconds": study,
			}
			if logo.Valid {
				item["logo"] = logo.String
			} else {
				item["logo"] = nil
			}
			if board.Valid {
				item["board"] = board.String
			} else {
				item["board"] = nil
			}
			if status.Valid {
				item["status"] = status.String
			} else {
				item["status"] = nil
			}
			if answered.Valid {
				item["answered_count"] = answered.Int64
			} else {
				item["answered_count"] = nil
			}
			if correct.Valid {
				item["correct_count"] = correct.Int64
			} else {
				item["correct_count"] = nil
			}
			if wrong.Valid {
				item["wrong_count"] = wrong.Int64
			} else {
				item["wrong_count"] = nil
			}
			out = append(out, item)
		}
		return c.JSON(out)
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "3344"
	}
	log.Printf("Mira Go API em http://localhost:%s", port)
	log.Fatal(app.Listen(":" + port))
}
