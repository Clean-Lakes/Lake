package ai

import (
	"regexp"
	"strconv"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

var probeHost = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,252}$`)
var probeScript = regexp.MustCompile(`^\s*cat\s*<\s*/dev/null\s*>\s*/dev/tcp/lake-probe.invalid/([0-9]{1,5})(?:\s+2>\s*/dev/null)?\s*$`)

// A quoted bash -c argument normally needs conservative treatment when the
// outer shell interpolates variables into it. This narrow exception proves a
// fixed, finite host loop and a probe-only body; it never executes a command,
// treats arbitrary dynamic scripts as safe, or changes command permissions.
func boundedTCPProbeCalls(file *syntax.File) map[*syntax.CallExpr]bool {
	approved := map[*syntax.CallExpr]bool{}
	syntax.Walk(file, func(node syntax.Node) bool {
		loop, ok := node.(*syntax.ForClause)
		if !ok || loop.Select {
			return true
		}
		iter, ok := loop.Loop.(*syntax.WordIter)
		if !ok || len(iter.Items) == 0 || len(iter.Items) > 64 {
			return true
		}
		for _, item := range iter.Items {
			host, dynamic, glob := guardWord(item)
			if dynamic || glob || !probeHost.MatchString(host) {
				return true
			}
		}
		calls, valid := probeOnlyBody(loop.Do, iter.Name.Value)
		if valid {
			for _, call := range calls {
				approved[call] = true
			}
		}
		return true
	})
	return approved
}

func probeOnlyBody(body []*syntax.Stmt, variable string) ([]*syntax.CallExpr, bool) {
	var calls []*syntax.CallExpr
	valid := true
	for _, stmt := range body {
		syntax.Walk(stmt, func(node syntax.Node) bool {
			if !valid {
				return false
			}
			switch node := node.(type) {
			case nil, *syntax.Comment, *syntax.Word, *syntax.Lit, *syntax.DblQuoted, *syntax.SglQuoted, *syntax.ParamExp:
			case *syntax.Stmt:
				valid = !node.Background && !node.Coprocess && len(node.Redirs) == 0
			case *syntax.BinaryCmd:
				valid = node.Op == syntax.AndStmt || node.Op == syntax.OrStmt
			case *syntax.CallExpr:
				if len(node.Assigns) != 0 || len(node.Args) == 0 {
					valid = false
					break
				}
				program, dynamic, _ := guardWord(node.Args[0])
				if dynamic {
					valid = false
					break
				}
				if program == "echo" {
					for _, arg := range node.Args[1:] {
						if _, ok := probeWord(arg, variable); !ok {
							valid = false
						}
					}
				} else if isBoundedTCPProbe(node.Args, variable) {
					calls = append(calls, node)
				} else {
					valid = false
				}
			default:
				// Assignments, substitutions, nested loops, functions, reads and
				// other commands can change the supposedly fixed host variable.
				valid = false
			}
			return valid
		})
	}
	return calls, valid && len(calls) > 0
}

func isBoundedTCPProbe(args []*syntax.Word, variable string) bool {
	if len(args) != 5 || args[0].Lit() != "timeout" || args[2].Lit() != "bash" || args[3].Lit() != "-c" {
		return false
	}
	seconds, err := strconv.ParseFloat(strings.TrimSuffix(args[1].Lit(), "s"), 64)
	if err != nil || !(seconds > 0 && seconds <= 30) {
		return false
	}
	script, ok := probeWord(args[4], variable)
	if !ok {
		return false
	}
	match := probeScript.FindStringSubmatch(script)
	if match == nil {
		return false
	}
	port, _ := strconv.Atoi(match[1])
	return port > 0 && port <= 65535
}

// Replace only a plain expansion of the proven loop variable. Parameter
// operators, indirect expansion, command substitution and escaping are not
// normalized into an approved script.
func probeWord(word *syntax.Word, variable string) (string, bool) {
	var value strings.Builder
	var part func(syntax.WordPart) bool
	part = func(p syntax.WordPart) bool {
		switch p := p.(type) {
		case *syntax.Lit:
			if strings.Contains(p.Value, `\`) {
				return false
			}
			value.WriteString(p.Value)
		case *syntax.SglQuoted:
			if p.Dollar {
				return false
			}
			value.WriteString(p.Value)
		case *syntax.DblQuoted:
			if p.Dollar {
				return false
			}
			for _, inner := range p.Parts {
				if !part(inner) {
					return false
				}
			}
		case *syntax.ParamExp:
			if p.Param == nil || p.Param.Value != variable || p.Excl || p.Length || p.Width || p.Index != nil || p.Slice != nil || p.Repl != nil || p.Names != 0 || p.Exp != nil {
				return false
			}
			value.WriteString("lake-probe.invalid")
		default:
			return false
		}
		return true
	}
	for _, p := range word.Parts {
		if !part(p) {
			return "", false
		}
	}
	return value.String(), true
}
