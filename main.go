// Command mira serves the Mira Estudos frontend as a single binary.
//
// No JavaScript, no Node.js, no external dependencies.
// Alpine.js is loaded from CDN.
package main

import (
	"context"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

var indexHTML []byte
var stylesCSS []byte

func loadAssets(absRoot string) error {
	var err error
	indexHTML, err = os.ReadFile(filepath.Join(absRoot, "index.html"))
	if err != nil {
		return err
	}
	stylesCSS, err = os.ReadFile(filepath.Join(absRoot, "styles.css"))
	if err != nil {
		return err
	}
	return nil
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}

	// Serve files from the working directory (where styles.css lives).
	// Overridable via STATIC_DIR for Docker/flexibility.
	root := os.Getenv("STATIC_DIR")
	if root == "" {
		root = "."
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		log.Fatalf("resolve static dir: %v", err)
	}

	if err := loadAssets(absRoot); err != nil {
		log.Fatalf("load assets: %v", err)
	}

	rootHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok"))
			return
		}
		serveStatic(absRoot, w, r)
	})

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           withSecurityHeaders(loggingMiddleware(rootHandler)),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		log.Printf("Server: http://localhost:%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("graceful shutdown error: %v", err)
	}
	log.Println("server stopped")
}

func serveStatic(absRoot string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	upath := r.URL.Path
	if upath == "/" {
		html := string(indexHTML)
		// Inject script to prevent layout shift during Alpine.js initialization
		inject := `<script>document.body.style.opacity='0';document.addEventListener('alpine:init',function(){document.body.classList.add('alpine-ready');document.body.style.opacity='1'});setTimeout(function(){document.body.style.opacity='1'},5000)</script>`
		html = strings.Replace(html, "</head>", inject+"</head>", 1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; "+
				"style-src 'self' 'unsafe-inline' https://fonts.cdnfonts.com; "+
				"font-src 'self' https://fonts.cdnfonts.com https://fonts.gstatic.com data:; "+
				"script-src 'self' 'unsafe-eval' https://cdn.jsdelivr.net; "+
				"img-src 'self' data:; "+
				"object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
		_, _ = w.Write([]byte(html))
		return
	}

	// Reject traversal attempts on the raw path before cleaning.
	if strings.Contains(upath, "..") || strings.Contains(r.URL.EscapedPath(), "..") {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	// Mitigate path traversal: clean the URL path and reject any ".." escape.
	cleaned := path.Clean("/" + strings.TrimPrefix(upath, "/"))
	if strings.Contains(cleaned, "..") {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	rel := strings.TrimPrefix(cleaned, "/")
	ext := strings.ToLower(filepath.Ext(rel))
	if ext == "" || !allowedExts[ext] {
		http.NotFound(w, r)
		return
	}

	// Special handling for styles.css (loaded from filesystem).
	if rel == "styles.css" {
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		_, _ = w.Write(stylesCSS)
		return
	}

	fullPath := filepath.Join(absRoot, filepath.FromSlash(rel))

	// Double-check the resolved absolute path stays inside the static root.
	absPath, err := filepath.Abs(fullPath)
	if err != nil {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	if absPath != absRoot && !strings.HasPrefix(absPath, absRoot+string(os.PathSeparator)) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	info, err := os.Stat(absPath)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}

	ctype := mime.TypeByExtension(ext)
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "public, max-age=3600")

	http.ServeFile(w, r, absPath)
}

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("X-XSS-Protection", "1; mode=block")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		next.ServeHTTP(w, r)
	})
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s %d %s %v", r.Method, r.URL.Path, rec.status, r.RemoteAddr, time.Since(start))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (rec *statusRecorder) WriteHeader(code int) {
	rec.status = code
	rec.ResponseWriter.WriteHeader(code)
}

var allowedExts = map[string]bool{
	".css":  true,
	".ico":  true,
	".png":  true,
	".svg":  true,
	".woff": true,
	".woff2": true,
	".ttf":  true,
}
