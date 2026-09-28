package main

// Frontend AlpineJS sem build (fase 3): HTML + CSS + JS servidos pelo Fiber.
// Cache agressivo no versionado (vendor), sem cache no index.

import (
	"os"
	"path/filepath"

	"github.com/gofiber/fiber/v2"
)

var webDir string

func resolveWebDir() string {
	if v := os.Getenv("MIRA_WEB_DIR"); v != "" {
		return v
	}
	if exe, err := os.Executable(); err == nil {
		if cand := filepath.Join(filepath.Dir(exe), "web"); hasIndex(cand) {
			return cand
		}
	}
	for _, cand := range []string{
		filepath.Join("apps", "goapi", "web"), // cwd = raiz do repo
		filepath.Join("..", "goapi", "web"),   // cwd = Aprova/
		"web", // cwd = apps/goapi/
	} {
		if hasIndex(cand) {
			return cand
		}
	}
	return ""
}

func hasIndex(dir string) bool {
	st, err := os.Stat(filepath.Join(dir, "index.html"))
	return err == nil && !st.IsDir()
}

func registerWeb(app *fiber.App) {
	webDir = resolveWebDir()
	if webDir == "" {
		return
	}
	app.Get("/", func(c *fiber.Ctx) error {
		c.Set("Cache-Control", "no-store, no-cache, must-revalidate")
		return c.SendFile(filepath.Join(webDir, "index.html"))
	})
	assets := app.Group("/assets", func(c *fiber.Ctx) error {
		// Front local: revalida sempre (sem immutable) para o navegador
		// buscar HTML/CSS/JS novos com F5 comum após cada deploy.
		c.Set("Cache-Control", "no-cache, must-revalidate")
		return c.Next()
	})
	assets.Static("/", webDir)
}
