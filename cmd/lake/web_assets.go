package main

import (
	"embed"
	"io/fs"
	"net/http"
)

// The Web bundle is built by client/web and included in the signed CLI.
//
//go:embed all:web_dist
var webAssets embed.FS

func webPageHandler(api http.Handler) http.Handler {
	root, err := fs.Sub(webAssets, "web_dist")
	if err != nil {
		panic(err)
	}
	files := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if len(r.URL.Path) >= 5 && r.URL.Path[:5] == "/api/" {
			api.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		files.ServeHTTP(w, r)
	})
}
