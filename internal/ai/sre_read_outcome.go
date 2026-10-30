package ai

import (
	"regexp"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

var sreANSI = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)

// grep -c exits 1 for a completed search with no matches. Recognize only a
// literal single grep count with a real completed zero result; never pipelines,
// wrappers, timeouts, missing files, truncated output or unknown commands.
func sreReadNoMatches(call Call, result any) bool {
	if call.Name != "shell" && call.Name != "terminal_execute_command" {
		return false
	}
	r := obj(result)
	if r["exitCode"] == nil || num(r["exitCode"], 0) != 1 || r["status"] != "completed" || str(r["finishedAt"]) == "" || r["truncated"] == true || r["source_truncated"] == true || strings.TrimSpace(sreANSI.ReplaceAllString(str(r["output"]), "")) != "0" {
		return false
	}
	var args map[string]any
	if decodeSREJSON(call.Arguments, &args) != nil {
		return false
	}
	file, err := syntax.NewParser().Parse(strings.NewReader(str(args["command"])), "")
	if err != nil || len(file.Stmts) != 1 {
		return false
	}
	stmt := file.Stmts[0]
	if stmt.Negated || stmt.Background || stmt.Coprocess || len(stmt.Redirs) > 0 {
		return false
	}
	command, ok := stmt.Cmd.(*syntax.CallExpr)
	if !ok || len(command.Assigns) > 0 || len(command.Args) < 3 {
		return false
	}
	words := []string{}
	for _, word := range command.Args {
		value, dynamic, glob := guardWord(word)
		if dynamic || glob {
			return false
		}
		words = append(words, value)
	}
	if words[0] != "grep" && words[0] != "/usr/bin/grep" && words[0] != "/bin/grep" {
		return false
	}
	count := false
	for i := 1; i < len(words); i++ {
		arg := words[i]
		if arg == "--" || !strings.HasPrefix(arg, "-") || arg == "-" {
			break
		}
		if arg == "--count" {
			count = true
			continue
		}
		if arg == "-e" || arg == "-f" || arg == "--regexp" || arg == "--file" {
			i++
			continue
		}
		if strings.HasPrefix(arg, "--regexp=") || strings.HasPrefix(arg, "--file=") {
			continue
		}
		if !strings.HasPrefix(arg, "--") && strings.ContainsRune(strings.TrimPrefix(arg, "-"), 'c') {
			count = true
		}
	}
	return count
}
