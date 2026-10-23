package web

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mvdan.cc/sh/v3/syntax"
)

func TestWindowsReadonlyCurlUsesSelectedShellBundle(t *testing.T) {
	for _, layout := range []string{"ucrt64", "mingw64"} {
		t.Run(layout, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "Git 中文 ' $; install")
			curl := filepath.Join(root, layout, "bin", "curl.exe")
			if err := os.MkdirAll(filepath.Dir(curl), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(curl, []byte("synthetic fixture"), 0600); err != nil {
				t.Fatal(err)
			}
			for _, shell := range []string{filepath.Join(root, "usr", "bin", "sh.exe"), filepath.Join(root, "bin", "bash.exe")} {
				command := CommandPolicy("curl -fsS --max-time 2 http://127.0.0.1:1234/health").Safe
				got := windowsReadonlyCommand(command, shell)
				file, err := syntax.NewParser().Parse(strings.NewReader(got), "")
				if err != nil || len(file.Stmts) != 1 {
					t.Fatal("installation path changed shell structure", err)
				}
				call, ok := file.Stmts[0].Cmd.(*syntax.CallExpr)
				if !ok {
					t.Fatal("rewritten command is not a simple call")
				}
				args := make([]string, len(call.Args))
				for i, word := range call.Args {
					var literal bool
					args[i], literal = readonlyWord(word, nil, false)
					if !literal {
						t.Fatal("installation path introduced expansion")
					}
				}
				if args[0] != "command" || args[1] != "-p" || args[2] != filepath.ToSlash(curl) || strings.Join(args[3:], " ") != "-q --globoff --noproxy * --max-time 10 --connect-timeout 5 -fsS --max-time 2 http://127.0.0.1:1234/health" {
					t.Fatal("trusted executable or bounded curl arguments changed")
				}
				// Text which happens to resemble the executable form is data.
				data := CommandPolicy(`printf '%s' "command -p 'curl'"`).Safe
				if windowsReadonlyCommand(data, shell) != data {
					t.Fatal("rewrote quoted command text")
				}
				pipeline := CommandPolicy(`curl http://127.0.0.1:1234/health | head -1`).Safe
				if got := windowsReadonlyCommand(pipeline, shell); !strings.Contains(got, "head") || strings.Contains(got, "-p 'curl'") {
					t.Fatal("pipeline executable was not resolved")
				}
			}
		})
	}
}

func TestWindowsReadonlyCurlDoesNotSearchUnrelatedPaths(t *testing.T) {
	root := t.TempDir()
	curl := filepath.Join(root, "curl.exe")
	if err := os.WriteFile(curl, []byte("untrusted fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", root)
	command := CommandPolicy("curl http://127.0.0.1:1234/health").Safe
	for _, shell := range []string{"sh.exe", filepath.Join(root, "sh.exe"), filepath.Join(root, "bin", "sh.exe")} {
		if windowsReadonlyCommand(command, shell) != command {
			t.Fatal("selected curl from unrelated directory or PATH")
		}
	}
}
