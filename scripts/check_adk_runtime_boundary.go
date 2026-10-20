//go:build ignore

// Check production runtime boundaries using the Go AST. No source is rewritten.
package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func main() {
	failures := []string{}
	allowedProvider := map[string]bool{"adk_model.go": true, "adk_provider_step.go": true, "provider_runtime.go": true}
	auxiliary := map[string]bool{"engine.go": true, "stdio.go": true, "completion.go": true, "side_completion.go": true, "image_probe.go": true, "resource_import.go": true, "context_summary.go": true, "project_memory_extraction.go": true}
	forbiddenMethods := map[string]bool{"ChatTurn": true, "RunSRERole": true, "runSRESteps": true, "runADKTurn": true, "InvokeExternalApproved": true}
	required := map[string]bool{"ExecuteTurn": false, "runOfficialADK": false, "ExecuteSRERole": false, "executeADKPlan": false}
	for _, old := range []string{"agent", "legacy/web-agent", "internal/ai/multi_agent.go", "internal/ai/sre_scheduler.go", "internal/ai/sre_host.go", "internal/ai/external.go", "internal/web/adk_runtime.go", "cmd/adk-spike"} {
		if _, err := os.Stat(old); err == nil {
			failures = append(failures, "retired runtime remains: "+old)
		}
	}
	for _, root := range []string{"internal", "cmd"} {
		err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			fs := token.NewFileSet()
			file, err := parser.ParseFile(fs, path, nil, 0)
			if err != nil {
				return err
			}
			report := func(n ast.Node, message string) {
				failures = append(failures, fmt.Sprintf("%s: %s", fs.Position(n.Pos()), message))
			}
			for _, imp := range file.Imports {
				value, _ := strconv.Unquote(imp.Path.Value)
				if value == "github.com/glebarez/sqlite" || value == "github.com/glebarez/go-sqlite" {
					report(imp, "duplicate modernc SQLite driver registration; use shared storage dialector")
				}
				if strings.HasPrefix(value, "google.golang.org/adk/v2/internal/") {
					report(imp, "SDK private import")
				}
				if value == "github.com/Clean-Lakes/Lake/internal/agent/adk" {
					report(imp, "production import of retired spike adapter")
				}
			}
			ast.Inspect(file, func(n ast.Node) bool {
				if fn, ok := n.(*ast.FuncDecl); ok {
					if forbiddenMethods[fn.Name.Name] {
						report(fn, "retired runtime method")
					}
					if _, needed := required[fn.Name.Name]; needed {
						required[fn.Name.Name] = true
					}
				}
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				name := ""
				switch fun := call.Fun.(type) {
				case *ast.SelectorExpr:
					name = fun.Sel.Name
				case *ast.Ident:
					name = fun.Name
				}
				if forbiddenMethods[name] {
					report(call, "call to retired runtime")
				}
				if name == "stream" || name == "Stream" {
					base := filepath.Base(path)
					if strings.HasPrefix(filepath.ToSlash(path), "internal/ai/") && !allowedProvider[base] {
						if !auxiliary[base] {
							report(call, "unlisted direct provider call")
						} else if len(call.Args) < 4 {
							report(call, "provider call with unexpected shape")
						} else if id, ok := call.Args[3].(*ast.Ident); !ok || id.Name != "nil" {
							report(call, "auxiliary provider call may execute tools")
						}
					}
				}
				return true
			})
			return nil
		})
		if err != nil {
			failures = append(failures, err.Error())
		}
	}
	for name, found := range required {
		if !found {
			failures = append(failures, "missing official runtime boundary: "+name)
		}
	}
	if len(failures) > 0 {
		for _, failure := range failures {
			fmt.Fprintln(os.Stderr, failure)
		}
		os.Exit(1)
	}
	fmt.Println("ADK runtime boundary: production entrypoints and provider-call AST checks passed")
}
