package web

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

// Windows Git keeps curl outside command -p's POSIX search path. Resolve it
// beside the shell already selected for this local terminal, never from PATH.
// SSH commands keep the remote host's original safe command unchanged.
func windowsReadonlyCommand(command, shell string) string {
	curl := windowsCurlForShell(shell)
	if curl == "" {
		return command
	}
	parser := syntax.NewParser(syntax.Variant(syntax.LangBash))
	file, err := parser.Parse(strings.NewReader(command), "")
	if err != nil {
		return command
	}
	// Parse the quoted path as a word so spaces, apostrophes and shell syntax
	// in an installation directory remain literal bytes, not new commands.
	replacement, err := syntax.NewParser().Parse(strings.NewReader("command -p "+quote(filepath.ToSlash(curl))), "")
	if err != nil {
		return command
	}
	word := replacement.Stmts[0].Cmd.(*syntax.CallExpr).Args[2]
	changed := false
	syntax.Walk(file, func(node syntax.Node) bool {
		call, ok := node.(*syntax.CallExpr)
		if !ok || len(call.Args) < 3 {
			return true
		}
		first, firstOK := readonlyWord(call.Args[0], nil, false)
		second, secondOK := readonlyWord(call.Args[1], nil, false)
		third, thirdOK := readonlyWord(call.Args[2], nil, false)
		if firstOK && secondOK && thirdOK && first == "command" && second == "-p" && third == "curl" {
			call.Args[2] = word
			changed = true
		}
		return true
	})
	if !changed {
		return command
	}
	var out bytes.Buffer
	if syntax.NewPrinter(syntax.Minify(true)).Print(&out, file) != nil {
		return command
	}
	return out.String()
}

func windowsCurlForShell(shell string) string {
	if !filepath.IsAbs(shell) {
		return ""
	}
	directory := filepath.Dir(shell)
	if !strings.EqualFold(filepath.Base(directory), "bin") {
		return ""
	}
	root := filepath.Dir(directory)
	if strings.EqualFold(filepath.Base(root), "usr") {
		root = filepath.Dir(root)
	}
	for _, directory := range []string{"ucrt64", "mingw64", "usr"} {
		executable := filepath.Join(root, directory, "bin", "curl.exe")
		if info, err := os.Stat(executable); err == nil && info.Mode().IsRegular() {
			return executable
		}
	}
	return ""
}
