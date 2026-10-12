// Package webassets embeds the React build in the signed Go executable.
package webassets

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var content embed.FS

func Files() fs.FS {
	root, e := fs.Sub(content, "dist")
	if e != nil {
		panic(e)
	}
	return root
}
