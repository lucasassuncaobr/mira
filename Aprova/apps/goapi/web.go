package main

// Frontend Svelte 5 compilado (dist achatado em web-svelte):
// HTML + CSS + JS servidos pelo Fiber.
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

// isHashedAsset detecta o padrão do Vite: nome-HASH8.ext (o hash muda a
// cada build, então o conteúdo é imutável e pode cachear agressivo).
func isHashedAsset(p string) bool {
	base := filepath.Base(p)
	dot := -1
	for i := len(base) - 1; i >= 0; i-- {
		if base[i] == '.' {
			dot = i
			break
		}
	}
	if dot < 10 {
		return false
	}
	ext := base[dot:]
	if ext != ".js" && ext != ".css" {
		return false
	}
	name := base[:dot]
	if len(name) < 10 || name[len(name)-9] != '-' {
		return false
	}
	for _, r := range name[len(name)-8:] {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			return false
		}
	}
	return true
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
		// Bundle com hash do Vite (index-XXXXXXXX.js): imutável por construção,
		// cache de 1 ano sem revalidação. Vendor sem hash e demais arquivos:
		// revalida sempre para F5 comum buscar deploy novo.
		if isHashedAsset(c.Path()) {
			c.Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			c.Set("Cache-Control", "no-cache, must-revalidate")
		}
		return c.Next()
	})
	assets.Static("/", webDir)
}
