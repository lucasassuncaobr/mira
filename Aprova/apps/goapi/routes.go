package main

// Rotas restantes da fase 2 — mesmo contrato do Express em server.ts.
// pythonDir: scripts pdf_extract.py/pdf_render.py (default ../api/python).

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"

	"github.com/gofiber/fiber/v2"
	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

var gdb *sql.DB
var assetsDir string
var pythonDir string

// Statements preparados no boot (hot path: responder consome select+insert
// a cada clique; sem isso cada request reprepara).
var (
	stmtCorrect      *sql.Stmt
	stmtInsertAttempt *sql.Stmt
)

func prepareHot() error {
	var err error
	if stmtCorrect, err = gdb.Prepare("SELECT correct_answer FROM questions WHERE id=?"); err != nil {
		return err
	}
	stmtInsertAttempt, err = gdb.Prepare("INSERT INTO attempts (question_id, answer, is_correct, elapsed_seconds) VALUES (?, ?, ?, ?)")
	return err
}

func fail(c *fiber.Ctx) error {
	return c.Status(500).JSON(fiber.Map{"error": "Não foi possível concluir a operação"})
}

// ---------- pdf_extract ----------

type pdfWord struct {
	X0     float64 `json:"x0"`
	Top    float64 `json:"top"`
	X1     float64 `json:"x1"`
	Bottom float64 `json:"bottom"`
	Text   string  `json:"text"`
}

type pdfPage struct {
	Number int       `json:"number"`
	Width  float64   `json:"width"`
	Height float64   `json:"height"`
	Text   string    `json:"text"`
	Words  []pdfWord `json:"words"`
}

func runPdfExtract(pdfPath string) ([]pdfPage, error) {
	cmd := exec.Command("python3", filepath.Join(pythonDir, "pdf_extract.py"), pdfPath)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.WaitDelay = 0
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("pdf_extract: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	var parsed struct {
		Pages []pdfPage `json:"pages"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
		return nil, fmt.Errorf("pdf_extract json: %v", err)
	}
	if len(parsed.Pages) == 0 {
		return nil, fmt.Errorf("pdf_extract: sem páginas")
	}
	return parsed.Pages, nil
}

func rawText(pages []pdfPage) string {
	parts := make([]string, 0, len(pages))
	for _, p := range pages {
		parts = append(parts, p.Text)
	}
	return strings.Join(parts, "\f")
}

func escapeXml(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}

func bboxXML(pages []pdfPage) string {
	var b strings.Builder
	for _, p := range pages {
		fmt.Fprintf(&b, `<page width="%v" height="%v">`, p.Width, p.Height)
		for _, w := range p.Words {
			fmt.Fprintf(&b, `<word xMin="%v" yMin="%v" xMax="%v" yMax="%v">%s</word>`, w.X0, w.Top, w.X1, w.Bottom, escapeXml(w.Text))
		}
	}
	return b.String()
}

// ---------- helpers de linha ----------

func scanRow(rows *sql.Rows) (map[string]any, error) {
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		return nil, err
	}
	out := map[string]any{}
	for i, c := range cols {
		switch v := vals[i].(type) {
		case []byte:
			out[c] = string(v)
		default:
			out[c] = v
		}
	}
	return out, nil
}

func questionRow(row map[string]any) (map[string]any, error) {
	s, _ := row["alternatives"].(string)
	var alts any
	if err := json.Unmarshal([]byte(s), &alts); err != nil {
		return nil, err
	}
	row["alternatives"] = alts
	return row, nil
}

// ---------- foco ----------

func loadOrBuildFocusMap(examID string) (map[int]FocusEntry, error) {
	type frow struct {
		number      int
		page        sql.NullInt64
		yInicio     sql.NullFloat64
		xCenter     sql.NullFloat64
		focusHeight sql.NullFloat64
		focusScale  sql.NullFloat64
	}
	rows, err := gdb.Query("SELECT number, page_number, y_inicio, x_center, focus_height, focus_scale FROM questions WHERE exam_id = ? ORDER BY number", examID)
	if err != nil {
		return nil, err
	}
	var all []frow
	for rows.Next() {
		var r frow
		if err := rows.Scan(&r.number, &r.page, &r.yInicio, &r.xCenter, &r.focusHeight, &r.focusScale); err != nil {
			rows.Close()
			return nil, err
		}
		all = append(all, r)
	}
	rows.Close()
	missing := false
	for _, r := range all {
		if !r.yInicio.Valid || !r.focusHeight.Valid {
			missing = true
			break
		}
	}
	if missing {
		source := filepath.Join(assetsDir, examID, "source.pdf")
		if _, err := os.Stat(source); err == nil {
			var hints []FocusHint
			for _, r := range all {
				h := FocusHint{Number: r.number}
				if r.page.Valid {
					p := int(r.page.Int64)
					h.PageNumber = &p
				}
				hints = append(hints, h)
			}
			pages, err := runPdfExtract(source)
			if err == nil {
				built := selectEntries(parseBboxCandidates(bboxXML(pages)), parseBboxLines(bboxXML(pages)), hints)
				if len(built) > 0 {
					if _, err := gdb.Exec("BEGIN"); err == nil {
						ok := true
						for number, entry := range built {
							if _, err := gdb.Exec("UPDATE questions SET y_inicio = ?, x_center = ?, focus_height = ?, focus_scale = ?, page_number = ? WHERE exam_id = ? AND number = ?",
								entry.YInicio, entry.XCenter, entry.FocusHeight, entry.FocusScale, entry.Page, examID, number); err != nil {
								ok = false
								break
							}
						}
						if ok {
							_, _ = gdb.Exec("COMMIT")
						} else {
							_, _ = gdb.Exec("ROLLBACK")
						}
					}
				}
			}
		}
	}
	fresh, err := gdb.Query("SELECT number, page_number, y_inicio, x_center, focus_height, focus_scale FROM questions WHERE exam_id = ? ORDER BY number", examID)
	if err != nil {
		return nil, err
	}
	defer fresh.Close()
	m := map[int]FocusEntry{}
	for fresh.Next() {
		var r frow
		if err := fresh.Scan(&r.number, &r.page, &r.yInicio, &r.xCenter, &r.focusHeight, &r.focusScale); err != nil {
			return nil, err
		}
		if !r.yInicio.Valid || !r.xCenter.Valid {
			continue
		}
		fh, fs := 18.0, 2.0
		if r.focusHeight.Valid {
			fh = r.focusHeight.Float64
		}
		if r.focusScale.Valid {
			fs = r.focusScale.Float64
		}
		page := 1
		if r.page.Valid {
			page = int(r.page.Int64)
		}
		m[r.number] = FocusEntry{Page: page, YInicio: r.yInicio.Float64, XCenter: r.xCenter.Float64, FocusHeight: fh, FocusScale: fs}
	}
	return m, nil
}

// ---------- OCR (bridge Node temporária) ----------

func ocrPortuguese(pdfPath string) (string, error) {
	tmpDir, err := os.MkdirTemp("", "aprova-ocr-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmpDir)
	render := exec.Command("python3", filepath.Join(pythonDir, "pdf_render.py"), pdfPath, tmpDir, "--format", "png", "--dpi", "260", "--prefix", "page")
	if out, err := render.CombinedOutput(); err != nil {
		return "", fmt.Errorf("render ocr: %v: %s", err, strings.TrimSpace(string(out)))
	}
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		return "", err
	 }
	var imgs []string
	for _, e := range entries {
		if matched, _ := filepath.Match("page-[0-9]*.png", e.Name()); matched {
			imgs = append(imgs, e.Name())
		}
	}
	sort.Strings(imgs)
	_ = imgs
	bridge := os.Getenv("MIRA_BRIDGE")
	if bridge == "" {
		for _, cand := range bridgeCandidates() {
			if st, err := os.Stat(cand); err == nil && !st.IsDir() {
				bridge = cand
				break
			}
		}
	}
	cmd := exec.Command("node", bridge, tmpDir)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("ocr bridge: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	var parsed struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &parsed); err != nil {
		return "", fmt.Errorf("ocr bridge json: %v", err)
	}
	text := parsed.Text
	text = regexp.MustCompile(`\n\s*[.·]\s*([A-D])\)`).ReplaceAllString(text, "\n$1)")
	text = regexp.MustCompile(`\n\s*A([A-D])\)`).ReplaceAllString(text, "\n$1)")
	return text, nil
}

// ---------- OCR merge (porte de server.ts) ----------

func editDistance(a, b string) int {
	ar, br := []rune(a), []rune(b)
	row := make([]int, len(br)+1)
	for j := range row {
		row[j] = j
	}
	for i := 1; i <= len(ar); i++ {
		prev := row[0]
		row[0] = i
		for j := 1; j <= len(br); j++ {
			saved := row[j]
			cost := 0
			if ar[i-1] != br[j-1] {
				cost = 1
			}
			row[j] = min(row[j]+1, row[j-1]+1, prev+cost)
			prev = saved
		}
	}
	return row[len(br)]
}

var compactStripRe = regexp.MustCompile(`[^\p{L}\p{N}]`)

func compactNorm(s string) string {
	t, _, _ := transform.String(transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC), s)
	return strings.ToLower(compactStripRe.ReplaceAllString(t, ""))
}

func mergeOcrQuestions(native, ocr []ParsedQuestion) []ParsedQuestion {
	ocrMap := map[int]ParsedQuestion{}
	for _, q := range ocr {
		ocrMap[q.Number] = q
	}
	out := make([]ParsedQuestion, 0, len(native))
	for _, q := range native {
		o, ok := ocrMap[q.Number]
		if !ok || len(o.Alternatives) != len(q.Alternatives) {
			out = append(out, q)
			continue
		}
		alts := make([]Alternative, len(q.Alternatives))
		for i, alt := range q.Alternatives {
			cand := o.Alternatives[i]
			if cand.Label != alt.Label {
				alts[i] = alt
				continue
			}
			ocrText := stripTrailingOcrNoise(cand.Text)
			cn := compactNorm(alt.Text)
			co := compactNorm(ocrText)
			maxLen := len([]rune(cn))
			if l := len([]rune(co)); l > maxLen {
				maxLen = l
			}
			if maxLen < 1 {
				maxLen = 1
			}
			sim := 1 - float64(editDistance(cn, co))/float64(maxLen)
			if sim >= .82 && len(strings.Fields(ocrText)) >= len(strings.Fields(alt.Text))+2 {
				alts[i] = Alternative{Label: alt.Label, Text: ocrText}
			} else {
				alts[i] = alt
			}
		}
		q.Alternatives = alts
		out = append(out, q)
	}
	return out
}

func adoptOcrQuestions(native, ocr []ParsedQuestion) []ParsedQuestion {
	if len(native) > 0 {
		return mergeOcrQuestions(native, ocr)
	}
	out := make([]ParsedQuestion, 0, len(ocr))
	for _, q := range ocr {
		for i := range q.Alternatives {
			q.Alternatives[i].Text = stripTrailingOcrNoise(q.Alternatives[i].Text)
		}
		out = append(out, q)
	}
	return out
}

type textLine struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
	Text string `json:"text"`
}

var textCache = map[string]map[string]any{}
var textCacheMu sync.Mutex

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func registerRoutes(app *fiber.App) {
	app.Get("/api/p2p/config", func(c *fiber.Ctx) error {
		port := 9000
		if v := os.Getenv("P2P_PORT"); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				port = n
			}
		}
		return c.JSON(fiber.Map{
			"host": getenv("P2P_HOST", "localhost"),
			"port": port,
			"path": getenv("P2P_PATH", "/sinalizar"),
		})
	})

	app.Get("/api/exams/:id/focus", func(c *fiber.Ctx) error {
		var exists bool
		if err := gdb.QueryRow("SELECT EXISTS(SELECT 1 FROM exams WHERE id = ?)", c.Params("id")).Scan(&exists); err != nil {
			return fail(c)
		}
		if !exists {
			return c.Status(404).JSON(fiber.Map{"error": "Prova não encontrada"})
		}
		m, err := loadOrBuildFocusMap(c.Params("id"))
		if err != nil {
			return fail(c)
		}
		payload := map[string]FocusEntry{}
		for number, entry := range m {
			payload[strconv.Itoa(number)] = entry
		}
		return c.JSON(payload)
	})

	app.Get("/api/performance", func(c *fiber.Ctx) error {
		rows, err := gdb.Query(`WITH RECURSIVE dates(day, offset) AS (SELECT date('now','localtime','-6 days'), 0 UNION ALL SELECT date(day,'+1 day'), offset + 1 FROM dates WHERE offset < 6) SELECT strftime('%d/%m', dates.day) day, COUNT(a.id) answered, COALESCE(SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END), 0) correct, COALESCE(SUM(CASE WHEN a.is_correct = 0 THEN 1 ELSE 0 END), 0) wrong, COALESCE(SUM(a.elapsed_seconds), 0) seconds FROM dates LEFT JOIN attempts a ON date(a.created_at, 'localtime') = dates.day GROUP BY dates.day ORDER BY dates.day`)
		if err != nil {
			return fail(c)
		}
		defer rows.Close()
		out := []map[string]any{}
		for rows.Next() {
			var day string
			var answered, correct, wrong, seconds int64
			if err := rows.Scan(&day, &answered, &correct, &wrong, &seconds); err != nil {
				return fail(c)
			}
			out = append(out, map[string]any{"day": day, "answered": answered, "correct": correct, "wrong": wrong, "seconds": seconds})
		}
		return c.JSON(out)
	})

	app.Get("/api/activity", func(c *fiber.Ctx) error {
		rows, err := gdb.Query(`WITH RECURSIVE dates(day, offset) AS (SELECT date('now','localtime','-83 days'), 0 UNION ALL SELECT date(day,'+1 day'), offset + 1 FROM dates WHERE offset < 83) SELECT dates.day date, strftime('%d/%m/%Y', dates.day) label, COUNT(a.id) count FROM dates LEFT JOIN attempts a ON date(a.created_at, 'localtime') = dates.day GROUP BY dates.day ORDER BY dates.day`)
		if err != nil {
			return fail(c)
		}
		defer rows.Close()
		out := []map[string]any{}
		for rows.Next() {
			var date, label string
			var count int64
			if err := rows.Scan(&date, &label, &count); err != nil {
				return fail(c)
			}
			out = append(out, map[string]any{"date": date, "label": label, "count": count})
		}
		return c.JSON(out)
	})

	app.Delete("/api/exams/:id", func(c *fiber.Ctx) error {
		var exists bool
		if err := gdb.QueryRow("SELECT EXISTS(SELECT 1 FROM exams WHERE id = ?)", c.Params("id")).Scan(&exists); err != nil {
			return fail(c)
		}
		if !exists {
			return c.Status(404).JSON(fiber.Map{"error": "Prova não encontrada"})
		}
		if _, err := gdb.Exec("BEGIN"); err != nil {
			return fail(c)
		}
		execAll := func() error {
			if _, err := gdb.Exec("DELETE FROM attempts WHERE question_id IN (SELECT id FROM questions WHERE exam_id = ?)", c.Params("id")); err != nil {
				return err
			}
			if _, err := gdb.Exec("DELETE FROM questions WHERE exam_id = ?", c.Params("id")); err != nil {
				return err
			}
			if _, err := gdb.Exec("DELETE FROM exams WHERE id = ?", c.Params("id")); err != nil {
				return err
			}
			return nil
		}
		if err := execAll(); err != nil {
			_, _ = gdb.Exec("ROLLBACK")
			return fail(c)
		}
		if _, err := gdb.Exec("COMMIT"); err != nil {
			return fail(c)
		}
		return c.SendStatus(204)
	})

	app.Put("/api/exams/:id", func(c *fiber.Ctx) error {
		var exists bool
		if err := gdb.QueryRow("SELECT EXISTS(SELECT 1 FROM exams WHERE id = ?)", c.Params("id")).Scan(&exists); err != nil {
			return fail(c)
		}
		if !exists {
			return c.Status(404).JSON(fiber.Map{"error": "Prova não encontrada"})
		}
		form, _ := c.MultipartForm()
		var updates []string
		var values []any
		title := ""
		hasTitle := false
		board := ""
		hasBoard := false
		if form != nil {
			if v, ok := form.Value["title"]; ok && len(v) > 0 {
				title, hasTitle = v[0], true
			}
			if v, ok := form.Value["board"]; ok && len(v) > 0 {
				board, hasBoard = v[0], true
			}
		}
		if hasTitle {
			updates = append(updates, "title = ?")
			values = append(values, title)
		}
		if hasBoard {
			updates = append(updates, "board = ?")
			if board == "" {
				values = append(values, nil)
			} else {
				values = append(values, board)
			}
		}
		fh, ferr := c.FormFile("logo")
		if ferr == nil && fh != nil {
			logoDir := filepath.Join(assetsDir, c.Params("id"))
			if err := os.MkdirAll(logoDir, 0o755); err != nil {
				return fail(c)
			}
			ext := ".jpg"
			if fh.Header.Get("Content-Type") == "image/png" {
				ext = ".png"
			}
			if err := c.SaveFile(fh, filepath.Join(logoDir, "logo"+ext)); err != nil {
				return fail(c)
			}
			updates = append(updates, "logo = ?")
			values = append(values, "/api/exams/"+c.Params("id")+"/logo")
		}
		if len(updates) == 0 {
			return c.Status(400).JSON(fiber.Map{"error": "Nenhuma alteração enviada"})
		}
		idNum, _ := strconv.ParseInt(c.Params("id"), 10, 64)
		values = append(values, idNum)
		if _, err := gdb.Exec("UPDATE exams SET "+strings.Join(updates, ", ")+" WHERE id = ?", values...); err != nil {
			return fail(c)
		}
		rows, err := gdb.Query("SELECT * FROM exams WHERE id = ?", c.Params("id"))
		if err != nil {
			return fail(c)
		}
		defer rows.Close()
		if rows.Next() {
			row, err := scanRow(rows)
			if err != nil {
				return fail(c)
			}
			return c.JSON(row)
		}
		return c.Status(404).JSON(fiber.Map{"error": "Prova não encontrada"})
	})

	app.Get("/api/exams/:id/logo", func(c *fiber.Ctx) error {
		var logo sql.NullString
		if err := gdb.QueryRow("SELECT logo FROM exams WHERE id = ?", c.Params("id")).Scan(&logo); err != nil {
			if err == sql.ErrNoRows {
				return c.Status(404).JSON(fiber.Map{"error": "Prova não encontrada"})
			}
			return fail(c)
		}
		if !logo.Valid {
			return c.Status(404).JSON(fiber.Map{"error": "Logo não encontrada"})
		}
		logoDir := filepath.Join(assetsDir, c.Params("id"))
		for _, name := range []string{"logo.png", "logo.jpg"} {
			p := filepath.Join(logoDir, name)
			if _, err := os.Stat(p); err == nil {
				return c.SendFile(p)
			}
		}
		return c.Status(404).JSON(fiber.Map{"error": "Arquivo de logo não encontrado"})
	})

	app.Get("/api/exams/:id", func(c *fiber.Ctx) error {
		rows, err := gdb.Query("SELECT * FROM exams WHERE id = ?", c.Params("id"))
		if err != nil {
			return fail(c)
		}
		var exam map[string]any
		for rows.Next() {
			exam, err = scanRow(rows)
			if err != nil {
				rows.Close()
				return fail(c)
			}
		}
		rows.Close()
		if exam == nil {
			return c.Status(404).JSON(fiber.Map{"error": "Prova não encontrada"})
		}
		qrows, err := gdb.Query("SELECT * FROM questions WHERE exam_id = ? ORDER BY number", c.Params("id"))
		if err != nil {
			return fail(c)
		}
		defer qrows.Close()
		questions := []map[string]any{}
		for qrows.Next() {
			row, err := scanRow(qrows)
			if err != nil {
				return fail(c)
			}
			q, err := questionRow(row)
			if err != nil {
				return fail(c)
			}
			questions = append(questions, q)
		}
		exam["questions"] = questions
		return c.JSON(exam)
	})

	app.Get("/api/exams/:id/pages/:page", func(c *fiber.Ctx) error {
		page := c.Params("page")
		padded := page
		if n, err := strconv.Atoi(page); err == nil {
			padded = pad2(n)
		}
		base := filepath.Join(assetsDir, c.Params("id"), "page-"+padded+".jpg")
		fallback := filepath.Join(assetsDir, c.Params("id"), "page-"+page+".jpg")
		target := base
		if _, err := os.Stat(target); err != nil {
			target = fallback
		}
		if _, err := os.Stat(target); err != nil {
			return c.Status(404).JSON(fiber.Map{"error": "Imagem da página não encontrada"})
		}
		c.Set("Cache-Control", "public, max-age=86400, immutable")
		return c.SendFile(target)
	})

	app.Get("/api/exams/:id/source", func(c *fiber.Ctx) error {
		source := filepath.Join(assetsDir, c.Params("id"), "source.pdf")
		if _, err := os.Stat(source); err != nil {
			return c.Status(404).JSON(fiber.Map{"error": "PDF original não encontrado"})
		}
		c.Set("Content-Type", "application/pdf")
		c.Set("Content-Disposition", `inline; filename="prova-`+c.Params("id")+`.pdf"`)
		return c.SendFile(source)
	})

	app.Get("/api/exams/:id/info", func(c *fiber.Ctx) error {
		entries, err := os.ReadDir(filepath.Join(assetsDir, c.Params("id")))
		if err != nil {
			return c.Status(404).JSON(fiber.Map{"error": "Prova não encontrada"})
		}
		pages := 0
		for _, e := range entries {
			if matched, _ := filepath.Match("page-*.jpg", e.Name()); matched {
				// mesma semântica do /^page-.*\.jpg$/i (case-insensitive aproximado)
				if strings.HasSuffix(strings.ToLower(e.Name()), ".jpg") {
					pages++
				}
			}
		}
		if pages == 0 {
			return c.Status(404).JSON(fiber.Map{"error": "Páginas da prova não encontradas"})
		}
		return c.JSON(fiber.Map{"pages": pages})
	})

	app.Get("/api/exams/:id/pages/:page/text", func(c *fiber.Ctx) error {
		key := c.Params("id") + ":" + c.Params("page")
		textCacheMu.Lock()
		if hit, ok := textCache[key]; ok {
			textCacheMu.Unlock()
			return c.JSON(hit)
		}
		textCacheMu.Unlock()
		source := filepath.Join(assetsDir, c.Params("id"), "source.pdf")
		if _, err := os.Stat(source); err != nil {
			return c.Status(404).JSON(fiber.Map{"error": "PDF original não encontrado"})
		}
		pageNum, _ := strconv.Atoi(c.Params("page"))
		if pageNum < 1 {
			pageNum = 1
		}
		pages, err := runPdfExtract(source)
		if err != nil {
			return fail(c)
		}
		var found *pdfPage
		for i := range pages {
			if pages[i].Number == pageNum {
				found = &pages[i]
				break
			}
		}
		if found == nil {
			return c.JSON(fiber.Map{"width": 0, "height": 0, "lines": []textLine{}})
		}
		type w struct {
			x0, y0, x1, y1 float64
			text           string
		}
		var words []w
		for _, word := range found.Words {
			words = append(words, w{word.X0, word.Top, word.X1, word.Bottom, word.Text})
		}
		sort.Slice(words, func(i, j int) bool {
			if words[i].y0 != words[j].y0 {
				return words[i].y0 < words[j].y0
			}
			return words[i].x0 < words[j].x0
		})
		hs := make([]float64, len(words))
		for i, word := range words {
			hs[i] = word.y1 - word.y0
		}
		sort.Float64s(hs)
		medianH := 0.0
		if len(hs) > 0 {
			medianH = hs[len(hs)/2]
		}
		tolerance := medianH * 0.4
		if tolerance < 1 {
			tolerance = 1
		}
		var rows [][]w
		for _, word := range words {
			if len(rows) > 0 {
				last := rows[len(rows)-1]
				rowY := (last[0].y0 + last[0].y1) / 2
				wordY := (word.y0 + word.y1) / 2
				diff := rowY - wordY
				if diff < 0 {
					diff = -diff
				}
				if diff <= tolerance {
					rows[len(rows)-1] = append(last, word)
					continue
				}
			}
			rows = append(rows, []w{word})
		}
		var lines []textLine
		for _, row := range rows {
			sorted := append([]w{}, row...)
			sort.Slice(sorted, func(i, j int) bool { return sorted[i].x0 < sorted[j].x0 })
			x0, y0 := sorted[0].x0, sorted[0].y0
			x1, y1 := sorted[0].x1, sorted[0].y1
			texts := []string{}
			for _, word := range sorted {
				if word.x0 < x0 {
					x0 = word.x0
				}
				if word.y0 < y0 {
					y0 = word.y0
				}
				if word.x1 > x1 {
					x1 = word.x1
				}
				if word.y1 > y1 {
					y1 = word.y1
				}
				texts = append(texts, word.text)
			}
			lines = append(lines, textLine{X: x0 / found.Width, Y: y0 / found.Height, W: (x1 - x0) / found.Width, H: (y1 - y0) / found.Height, Text: strings.Join(texts, " ")})
		}
		if lines == nil {
			lines = []textLine{}
		}
		result := map[string]any{"width": found.Width, "height": found.Height, "lines": lines}
		textCacheMu.Lock()
		if len(textCache) > 500 {
			textCache = map[string]map[string]any{}
		}
		textCache[key] = result
		textCacheMu.Unlock()
		return c.JSON(result)
	})

	app.Get("/api/exams/:id/pages/:page/focus/:question", func(c *fiber.Ctx) error {
		var stored struct {
			page        sql.NullInt64
			yInicio     sql.NullFloat64
			xCenter     sql.NullFloat64
			focusHeight sql.NullFloat64
			focusScale  sql.NullFloat64
		}
		qnum, _ := strconv.Atoi(c.Params("question"))
		err := gdb.QueryRow("SELECT page_number, y_inicio, x_center, focus_height, focus_scale FROM questions WHERE exam_id = ? AND number = ?",
			c.Params("id"), c.Params("question")).Scan(&stored.page, &stored.yInicio, &stored.xCenter, &stored.focusHeight, &stored.focusScale)
		if err != nil && err != sql.ErrNoRows {
			return fail(c)
		}
		var entry *FocusEntry
		if err == nil && stored.yInicio.Valid && stored.xCenter.Valid {
			page := 1
			if stored.page.Valid {
				page = int(stored.page.Int64)
			} else if n, err := strconv.Atoi(c.Params("page")); err == nil {
				page = n
			}
			fh, fs := 18.0, 2.0
			if stored.focusHeight.Valid {
				fh = stored.focusHeight.Float64
			}
			if stored.focusScale.Valid {
				fs = stored.focusScale.Float64
			}
			entry = &FocusEntry{Page: page, YInicio: stored.yInicio.Float64, XCenter: stored.xCenter.Float64, FocusHeight: fh, FocusScale: fs}
		} else {
			m, err := loadOrBuildFocusMap(c.Params("id"))
			if err != nil {
				return fail(c)
			}
			if e, ok := m[qnum]; ok {
				entry = &e
			}
		}
		if entry == nil {
			return c.JSON(fiber.Map{"x": .5, "y": .15})
		}
		return c.JSON(fiber.Map{
			"y_inicio": entry.YInicio, "x_center": entry.XCenter,
			"focus_height": entry.FocusHeight, "scale": entry.FocusScale,
			"x": entry.XCenter / 100, "y": entry.YInicio / 100,
		})
	})

	app.Post("/api/exams/:id/reprocess", func(c *fiber.Ctx) error {
		source := filepath.Join(assetsDir, c.Params("id"), "source.pdf")
		if _, err := os.Stat(source); err != nil {
			return c.Status(404).JSON(fiber.Map{"error": "O PDF original desta prova não está disponível"})
		}
		examBuf, err := os.ReadFile(source)
		if err != nil {
			return fail(c)
		}
		pages, err := runPdfExtract(source)
		if err != nil {
			return c.Status(422).JSON(fiber.Map{"error": "Não foi possível reler o PDF"})
		}
		marked := markedText(pages)
		if strings.TrimSpace(marked) == "" {
			return c.Status(422).JSON(fiber.Map{"error": "Não foi possível reler o PDF"})
		}
		nativeQuestions := filterMinAlts(ParseQuestions(marked), 2)
		ocrText, _ := ocrPortuguese(source)
		ocrQuestions := filterMinAlts(ParseQuestions(ocrText), 2)
		questions := adoptOcrQuestions(nativeQuestions, ocrQuestions)
		focusMap, err := buildFocusMapFromPDF(examBuf, source, questions)
		if err != nil {
			return fail(c)
		}
		answerMap := map[int]string{}
		answerKeyPath := filepath.Join(assetsDir, c.Params("id"), "answer-key.pdf")
		if _, err := os.Stat(answerKeyPath); err == nil {
			if keyBuf, err := os.ReadFile(answerKeyPath); err == nil {
				if keyPages, err := runPdfExtract(answerKeyPath); err == nil {
					for _, item := range ParseAnswerKey(rawText(keyPages), marked) {
						answerMap[item.Number] = item.Answer
					}
				}
				_ = keyBuf
			}
		}
		type existing struct {
			id      int64
			number  int
			correct sql.NullString
		}
		rows, err := gdb.Query("SELECT id, number, correct_answer FROM questions WHERE exam_id = ? ORDER BY number, id", c.Params("id"))
		if err != nil {
			return fail(c)
		}
		byNumber := map[int][]existing{}
		var order []int
		for rows.Next() {
			var e existing
			if err := rows.Scan(&e.id, &e.number, &e.correct); err != nil {
				rows.Close()
				return fail(c)
			}
			if _, ok := byNumber[e.number]; !ok {
				order = append(order, e.number)
			}
			byNumber[e.number] = append(byNumber[e.number], e)
		}
		rows.Close()
		existingCount := 0
		for _, list := range byNumber {
			existingCount += len(list)
		}
		// Trava anti-limpeza (igual ao Node): nunca apaga as boas por colapso de parse.
		if existingCount >= 3 && len(questions) < (existingCount+1)/2 {
			return c.Status(422).JSON(fiber.Map{"error": "Parse retornou poucas questões. Nada foi alterado."})
		}
		added, repaired, removed := 0, 0, 0
		seen := map[int]bool{}
		if _, err := gdb.Exec("BEGIN"); err != nil {
			return fail(c)
		}
		commit := true
		defer func() {
			if commit {
				_, _ = gdb.Exec("COMMIT")
			} else {
				_, _ = gdb.Exec("ROLLBACK")
			}
		}()
		for _, q := range questions {
			var fh, fs, yi, xc any
			if f, ok := focusMap[q.Number]; ok {
				yi, xc, fh, fs = f.YInicio, f.XCenter, f.FocusHeight, f.FocusScale
			}
			altJSON, _ := json.Marshal(q.Alternatives)
			rows := byNumber[q.Number]
			correct := sql.NullString{}
			if a, ok := answerMap[q.Number]; ok {
				correct = sql.NullString{String: a, Valid: true}
			} else if len(rows) > 0 && rows[0].correct.Valid {
				correct = rows[0].correct
			}
			var correctVal any
			if correct.Valid {
				correctVal = correct.String
			}
			var ctxVal, pageVal any = nil, nil
			if q.Context != nil {
				ctxVal = *q.Context
			}
			pageVal = q.PageNumber
			if len(rows) > 0 {
				keeper := rows[0]
				if _, err := gdb.Exec("UPDATE questions SET statement=?, alternatives=?, page_number=?, context=?, y_inicio=COALESCE(?, y_inicio), x_center=COALESCE(?, x_center), focus_height=COALESCE(?, focus_height), focus_scale=COALESCE(?, focus_scale), correct_answer=? WHERE id=?",
					q.Statement, string(altJSON), pageVal, ctxVal, yi, xc, fh, fs, correctVal, keeper.id); err != nil {
					commit = false
					return fail(c)
				}
				for _, dup := range rows[1:] {
					if _, err := gdb.Exec("UPDATE attempts SET question_id = ? WHERE question_id = ?", keeper.id, dup.id); err != nil {
						commit = false
						return fail(c)
					}
					if _, err := gdb.Exec("DELETE FROM questions WHERE id = ?", dup.id); err != nil {
						commit = false
						return fail(c)
					}
					repaired++
				}
			} else {
				if _, err := gdb.Exec("INSERT INTO questions (exam_id, number, statement, alternatives, correct_answer, page_number, context, y_inicio, x_center, focus_height, focus_scale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					c.Params("id"), q.Number, q.Statement, string(altJSON), correctVal, pageVal, ctxVal, yi, xc, fh, fs); err != nil {
					commit = false
					return fail(c)
				}
				added++
			}
			seen[q.Number] = true
		}
		for _, number := range order {
			if seen[number] {
				continue
			}
			for _, row := range byNumber[number] {
				if _, err := gdb.Exec("DELETE FROM attempts WHERE question_id = ?", row.id); err != nil {
					commit = false
					return fail(c)
				}
				if _, err := gdb.Exec("DELETE FROM questions WHERE id = ?", row.id); err != nil {
					commit = false
					return fail(c)
				}
				removed++
			}
		}
		if _, err := gdb.Exec("UPDATE exams SET board = COALESCE(?, board) WHERE id = ?", InferExamBoard(marked), c.Params("id")); err != nil {
			commit = false
			return fail(c)
		}
		nums := []int{}
		for _, q := range questions {
			nums = append(nums, q.Number)
		}
		missing := MissingNumbers(nums)
		return c.JSON(fiber.Map{"ok": true, "questionCount": len(questions), "added": added, "repaired": repaired, "removed": removed, "missing": missing})
	})

	app.Post("/api/exams/import", func(c *fiber.Ctx) error {
		form, err := c.MultipartForm()
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "Envie os PDFs da prova e do gabarito"})
		}
		examFiles := form.File["exam"]
		answerFiles := form.File["answerKey"]
		if len(examFiles) == 0 || len(answerFiles) == 0 {
			return c.Status(400).JSON(fiber.Map{"error": "Envie os PDFs da prova e do gabarito"})
		}
		examFh, answerFh := examFiles[0], answerFiles[0]
		if examFh.Header.Get("Content-Type") != "application/pdf" || answerFh.Header.Get("Content-Type") != "application/pdf" {
			return c.Status(400).JSON(fiber.Map{"error": "Envie os PDFs da prova e do gabarito"})
		}
		tmpDir, err := os.MkdirTemp("", "mira-import-")
		if err != nil {
			return fail(c)
		}
		defer os.RemoveAll(tmpDir)
		examPath := filepath.Join(tmpDir, "exam.pdf")
		answerPath := filepath.Join(tmpDir, "key.pdf")
		if err := c.SaveFile(examFh, examPath); err != nil {
			return fail(c)
		}
		if err := c.SaveFile(answerFh, answerPath); err != nil {
			return fail(c)
		}
		examBuf, err := os.ReadFile(examPath)
		if err != nil {
			return fail(c)
		}
		answerBuf, err := os.ReadFile(answerPath)
		if err != nil {
			return fail(c)
		}
		examPages, err := runPdfExtract(examPath)
		precisePages := ""
		if err == nil {
			if t := rawText(examPages); strings.TrimSpace(t) != "" {
				precisePages = markedText(examPages)
			}
		}
		extractedText := precisePages
		if extractedText == "" {
			// fallback direto para OCR quando a extração vetorial falha
			ocrText, err := ocrPortuguese(examPath)
			if err != nil {
				return c.Status(422).JSON(fiber.Map{"error": "Nenhuma questão foi identificada. PDFs escaneados precisarão do módulo de OCR."})
			}
			extractedText = ocrText
		}
		questions := filterMinAlts(ParseQuestions(extractedText), 2)
		usable := 0
		for _, q := range questions {
			if len(q.Alternatives) >= 4 {
				ok := true
				for _, a := range q.Alternatives {
					if strings.TrimSpace(a.Text) == "" {
						ok = false
						break
					}
				}
				if ok {
					usable++
				}
			}
		}
		usableRatio := 0.0
		if len(questions) > 0 {
			usableRatio = float64(usable) / float64(len(questions))
		}
		if len(questions) < 3 || usableRatio < .75 {
			ocrText, err := ocrPortuguese(examPath)
			if err == nil {
				ocrQuestions := filterMinAlts(ParseQuestions(ocrText), 2)
				questions = adoptOcrQuestions(questions, ocrQuestions)
			}
		}
		keyPages, _ := runPdfExtract(answerPath)
		var extractedAnswers struct {
			Text string
		}
		if keyPages != nil {
			if t := rawText(keyPages); strings.TrimSpace(t) != "" {
				extractedAnswers.Text = t
			}
		}
		if strings.TrimSpace(extractedAnswers.Text) == "" {
			ocrAnswerText, err := ocrPortuguese(answerPath)
			if err != nil {
				return c.Status(422).JSON(fiber.Map{"error": "Nenhuma questão foi identificada. PDFs escaneados precisarão do módulo de OCR."})
			}
			extractedAnswers.Text = ocrAnswerText
		}
		_ = answerBuf
		if len(questions) == 0 {
			return c.Status(422).JSON(fiber.Map{"error": "Nenhuma questão foi identificada. PDFs escaneados precisarão do módulo de OCR."})
		}
		nativeAnswers := ParseAnswerKey(extractedAnswers.Text, extractedText)
		answerMap := map[int]string{}
		for _, item := range nativeAnswers {
			answerMap[item.Number] = item.Answer
		}
		if len(nativeAnswers) < max(3, (len(questions)*3+3)/4) {
			if ocrAnswerText, err := ocrPortuguese(answerPath); err == nil {
				for _, item := range ParseAnswerKey(ocrAnswerText, extractedText) {
					if _, ok := answerMap[item.Number]; !ok {
						answerMap[item.Number] = item.Answer
					}
				}
			}
		}
		if len(answerMap) < (len(questions)*3+3)/4 {
			return c.Status(422).JSON(fiber.Map{"error": "Não foi possível localizar no gabarito a seção correspondente ao cargo desta prova."})
		}
		title := c.FormValue("title")
		if title == "" {
			title = InferExamTitle(extractedText, examFh.Filename)
		}
		board := InferExamBoard(extractedText)
		var boardVal any
		if board != "" {
			boardVal = board
		}
		focusMap, err := buildFocusMapFromPDF(examBuf, examPath, questions)
		if err != nil {
			return fail(c)
		}
		res, err := gdb.Exec("INSERT INTO exams (title, filename, board) VALUES (?, ?, ?)", title, examFh.Filename, boardVal)
		if err != nil {
			return fail(c)
		}
		examID, _ := res.LastInsertId()
		for _, q := range questions {
			var yi, xc, fh, fs, page, ctx, correct any
			if f, ok := focusMap[q.Number]; ok {
				yi, xc, fh, fs, page = f.YInicio, f.XCenter, f.FocusHeight, f.FocusScale, f.Page
			} else {
				page = q.PageNumber
			}
			if q.Context != nil {
				ctx = *q.Context
			}
			if a, ok := answerMap[q.Number]; ok {
				correct = a
			}
			altJSON, _ := json.Marshal(q.Alternatives)
			if _, err := gdb.Exec("INSERT INTO questions (exam_id, number, statement, alternatives, correct_answer, page_number, context, y_inicio, x_center, focus_height, focus_scale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				examID, q.Number, q.Statement, string(altJSON), correct, page, ctx, yi, xc, fh, fs); err != nil {
				return fail(c)
			}
		}
		assetDir := filepath.Join(assetsDir, strconv.FormatInt(examID, 10))
		if err := os.MkdirAll(assetDir, 0o755); err != nil {
			return fail(c)
		}
		sourcePath := filepath.Join(assetDir, "source.pdf")
		if err := os.WriteFile(sourcePath, examBuf, 0o644); err != nil {
			return fail(c)
		}
		if err := os.WriteFile(filepath.Join(assetDir, "answer-key.pdf"), answerBuf, 0o644); err != nil {
			return fail(c)
		}
		render := exec.Command("python3", filepath.Join(pythonDir, "pdf_render.py"), sourcePath, assetDir)
		if out, err := render.CombinedOutput(); err != nil {
			_ = out
		}
		nums := []int{}
		for _, q := range questions {
			nums = append(nums, q.Number)
		}
		return c.Status(201).JSON(fiber.Map{"id": examID, "title": title, "board": boardVal, "questionCount": len(questions), "missing": MissingNumbers(nums)})
	})

	app.Put("/api/questions/:id", func(c *fiber.Ctx) error {
		var body struct {
			Statement    *string `json:"statement"`
			Alternatives *[]struct {
				Label *string `json:"label"`
				Text  *string `json:"text"`
			} `json:"alternatives"`
			CorrectAnswer *string `json:"correctAnswer"`
			Subject       *string `json:"subject"`
			Topic         *string `json:"topic"`
		}
		if err := c.BodyParser(&body); err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "Dados da questão inválidos"})
		}
		if body.Statement == nil || *body.Statement == "" || body.Alternatives == nil {
			return c.Status(400).JSON(fiber.Map{"error": "Dados da questão inválidos"})
		}
		for _, a := range *body.Alternatives {
			if a.Label == nil || len(*a.Label) < 1 || len(*a.Label) > 2 || a.Text == nil || *a.Text == "" {
				return c.Status(400).JSON(fiber.Map{"error": "Dados da questão inválidos"})
			}
		}
		var correct, subject, topic any
		if body.CorrectAnswer != nil {
			if len(*body.CorrectAnswer) > 2 {
				return c.Status(400).JSON(fiber.Map{"error": "Dados da questão inválidos"})
			}
			correct = *body.CorrectAnswer
		}
		if body.Subject != nil {
			subject = *body.Subject
		}
		if body.Topic != nil {
			topic = *body.Topic
		}
		altJSON, _ := json.Marshal(*body.Alternatives)
		if _, err := gdb.Exec("UPDATE questions SET statement=?, alternatives=?, correct_answer=?, subject=?, topic=? WHERE id=?",
			*body.Statement, string(altJSON), correct, subject, topic, c.Params("id")); err != nil {
			return fail(c)
		}
		return c.JSON(fiber.Map{"ok": true})
	})

	app.Post("/api/questions/:id/answer", func(c *fiber.Ctx) error {
		var body struct {
			Answer         *string `json:"answer"`
			ElapsedSeconds *int    `json:"elapsedSeconds"`
		}
		if err := c.BodyParser(&body); err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "Resposta inválida"})
		}
		if body.Answer == nil || len(*body.Answer) < 1 || len(*body.Answer) > 2 {
			return c.Status(400).JSON(fiber.Map{"error": "Resposta inválida"})
		}
		elapsed := 0
		if body.ElapsedSeconds != nil {
			if *body.ElapsedSeconds < 0 {
				return c.Status(400).JSON(fiber.Map{"error": "Resposta inválida"})
			}
			elapsed = *body.ElapsedSeconds
		}
		var correct sql.NullString
		if err := stmtCorrect.QueryRow(c.Params("id")).Scan(&correct); err != nil {
			if err == sql.ErrNoRows {
				return c.Status(404).JSON(fiber.Map{"error": "Questão não encontrada"})
			}
			return fail(c)
		}
		var isCorrect any
		if correct.Valid {
			if correct.String == *body.Answer {
				isCorrect = 1
			} else {
				isCorrect = 0
			}
		}
		var qid int64
		if n, err := strconv.ParseInt(c.Params("id"), 10, 64); err == nil {
			qid = n
		} else {
			return c.Status(404).JSON(fiber.Map{"error": "Questão não encontrada"})
		}
		if _, err := stmtInsertAttempt.Exec(qid, *body.Answer, isCorrect, elapsed); err != nil {
			return fail(c)
		}
		var correctOut any
		if correct.Valid {
			correctOut = correct.String
		}
		var isCorrectOut any
		if isCorrect != nil {
			isCorrectOut = isCorrect == 1
		}
		return c.JSON(fiber.Map{"correctAnswer": correctOut, "isCorrect": isCorrectOut})
	})

	app.Static("/api/exam-assets", assetsDir)
}

func pad2(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func markedText(pages []pdfPage) string {
	parts := make([]string, 0, len(pages))
	for _, p := range pages {
		parts = append(parts, p.Text)
	}
	raw := strings.Join(parts, "\f")
	segs := strings.Split(raw, "\f")
	marked := make([]string, 0, len(segs))
	for i, s := range segs {
		marked = append(marked, "[[PAGE:"+strconv.Itoa(i+1)+"]]\n"+s)
	}
	return strings.Join(marked, "\n")
}

func filterMinAlts(qs []ParsedQuestion, min int) []ParsedQuestion {
	out := make([]ParsedQuestion, 0, len(qs))
	for _, q := range qs {
		if len(q.Alternatives) >= min {
			out = append(out, q)
		}
	}
	return out
}

func buildFocusMapFromPDF(buf []byte, pdfPath string, questions []ParsedQuestion) (map[int]FocusEntry, error) {
	_ = buf
	pages, err := runPdfExtract(pdfPath)
	if err != nil {
		return map[int]FocusEntry{}, nil
	}
	var hints []FocusHint
	for _, q := range questions {
		pn := q.PageNumber
		hints = append(hints, FocusHint{Number: q.Number, PageNumber: &pn})
	}
	return selectEntries(parseBboxCandidates(bboxXML(pages)), parseBboxLines(bboxXML(pages)), hints), nil
}

