package web

import (
	"bytes"
	"path"
	"regexp"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

// Validate every nested command before allowing shell substitutions. Dynamic
// results can only become display/date arguments, never executables or paths.
func readonlyScript(command string) (string, bool) {
	if sensitive.MatchString(command) {
		return "", false
	}
	file, err := syntax.NewParser(syntax.Variant(syntax.LangBash)).Parse(strings.NewReader(command), "")
	if err != nil || len(file.Stmts) == 0 {
		return "", false
	}
	if !readonlyStatements(file.Stmts, map[string]bool{}) {
		return "", false
	}
	var out bytes.Buffer
	if syntax.NewPrinter(syntax.Minify(true)).Print(&out, file) != nil {
		return "", false
	}
	return out.String(), true
}
func readonlyStatements(statements []*syntax.Stmt, vars map[string]bool) bool {
	for _, stmt := range statements {
		if stmt.Background || stmt.Coprocess {
			return false
		}
		for _, redir := range stmt.Redirs {
			target, ok := readonlyWord(redir.Word, vars, false)
			fd := ""
			if redir.N != nil {
				fd = redir.N.Value
			}
			// Only merge stdout/stderr. Arbitrary descriptors and paths stay protected.
			if ok && redir.Op == syntax.DplOut && (fd == "1" || fd == "2" || fd == "") && (target == "1" || target == "2") {
				continue
			}
			if !ok || target != "/dev/null" || redir.Op != syntax.RdrOut || !set("0 1 2")[fd] && fd != "" || fd == "0" {
				return false
			}
		}
		switch cmd := stmt.Cmd.(type) {
		case *syntax.BinaryCmd:
			if cmd.Op != syntax.Pipe && cmd.Op != syntax.AndStmt && cmd.Op != syntax.OrStmt {
				return false
			}
			if !readonlyStatements([]*syntax.Stmt{cmd.X, cmd.Y}, vars) {
				return false
			}
		case *syntax.CallExpr:
			if len(cmd.Args) == 0 {
				if len(cmd.Assigns) == 0 {
					return false
				}
				for _, assignment := range cmd.Assigns {
					if assignment.Name == nil || assignment.Append || assignment.Index != nil || assignment.Array != nil || assignment.Value == nil {
						return false
					}
					name := assignment.Name.Value
					if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`).MatchString(name) || set("PATH HOME SHELL IFS ENV BASH_ENV ZDOTDIR CDPATH FPATH PROMPT_COMMAND PS1 PS2 PS4 BASH_XTRACEFD")[name] || strings.HasPrefix(name, "LD_") || strings.HasPrefix(name, "DYLD_") || strings.HasPrefix(name, "__lake") {
						return false
					}
					if _, ok := readonlyWordIn(assignment.Value, vars, true, true); !ok {
						return false
					}
					vars[name] = true
				}
				continue
			}
			if len(cmd.Assigns) != 0 {
				return false
			}
			program, ok := readonlyWord(cmd.Args[0], vars, false)
			if !ok {
				return false
			}
			args := []string{program}
			dynamicArgs := set("echo printf date")[path.Base(program)]
			for index, word := range cmd.Args[1:] {
				allowDynamic := dynamicArgs && !(path.Base(program) == "printf" && index == 0)
				value, ok := readonlyWordIn(word, vars, allowDynamic, path.Base(program) == "echo")
				if !ok {
					return false
				}
				args = append(args, value)
			}
			quoted := make([]string, len(args))
			for i, arg := range args {
				quoted[i] = quote(arg)
			}
			if commandPolicyFlat(strings.Join(quoted, " ")).Risk != "readonly" {
				return false
			}
			// Preserve substitutions/quoting while bypassing shell aliases and functions.
			cmd.Args = append([]*syntax.Word{literalWord("command"), literalWord("-p")}, cmd.Args...)
		default:
			return false
		}
	}
	return true
}
func literalWord(value string) *syntax.Word {
	return &syntax.Word{Parts: []syntax.WordPart{&syntax.Lit{Value: value}}}
}
func readonlyWord(word *syntax.Word, vars map[string]bool, dynamic bool) (string, bool) {
	return readonlyWordIn(word, vars, dynamic, false)
}
func readonlyWordIn(word *syntax.Word, vars map[string]bool, dynamic, quoted bool) (string, bool) {
	if word == nil {
		return "", false
	}
	var out strings.Builder
	for _, part := range word.Parts {
		switch part := part.(type) {
		case *syntax.Lit:
			tokens, expanded, subst := tokenize(part.Value)
			if expanded || subst || len(tokens) > 1 || len(tokens) == 1 && tokens[0].op {
				return "", false
			}
			// Within double quotes literal whitespace is part of the same argument.
			out.WriteString(part.Value)
		case *syntax.SglQuoted:
			if part.Dollar {
				return "", false
			}
			out.WriteString(part.Value)
		case *syntax.DblQuoted:
			for _, inner := range part.Parts {
				if literal, ok := inner.(*syntax.Lit); ok {
					out.WriteString(literal.Value)
					continue
				}
				value, ok := readonlyWordIn(&syntax.Word{Parts: []syntax.WordPart{inner}}, vars, dynamic, true)
				if !ok {
					return "", false
				}
				out.WriteString(value)
			}
		case *syntax.ParamExp:
			if !dynamic || !quoted || part.Param == nil || !vars[part.Param.Value] || part.Excl || part.Length || part.Width || part.Index != nil || part.Slice != nil || part.Repl != nil || part.Exp != nil || part.Names != 0 {
				return "", false
			}
			out.WriteString("0")
		case *syntax.CmdSubst:
			if !dynamic || !quoted || part.TempFile || part.ReplyVar {
				return "", false
			}
			local := map[string]bool{}
			for key, value := range vars {
				local[key] = value
			}
			if !readonlyStatements(part.Stmts, local) {
				return "", false
			}
			out.WriteString("0")
		default:
			return "", false
		}
	}
	return out.String(), true
}

func readonlySed(args []string) bool {
	for len(args) > 0 && set("-E -r -n")[args[0]] {
		args = args[1:]
	}
	if len(args) > 0 && args[0] == "-e" {
		args = args[1:]
	}
	if len(args) != 1 {
		return false
	}
	script := args[0]
	if regexp.MustCompile(`^[0-9,$ ]*[pdq]$`).MatchString(script) {
		return true
	}
	if len(script) < 4 || script[0] != 's' {
		return false
	}
	delimiter := script[1]
	if strings.ContainsRune("\\\n\r ", rune(delimiter)) {
		return false
	}
	index := 2
	for count := 0; count < 2; count++ {
		closed := false
		for index < len(script) {
			if script[index] == '\\' {
				index += 2
				continue
			}
			if script[index] == delimiter {
				index++
				closed = true
				break
			}
			index++
		}
		if !closed {
			return false
		}
	}
	return regexp.MustCompile(`^[gIp0-9]*$`).MatchString(script[index:])
}
func readonlySysctl(args []string) bool {
	if len(args) > 0 && args[0] == "-n" {
		args = args[1:]
	}
	return len(args) == 1 && (set("hw.memsize hw.ncpu hw.physicalcpu hw.logicalcpu kern.boottime vm.swapusage")[args[0]])
}
func readonlyDate(args []string) bool {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "-u" || arg == "--utc" || strings.HasPrefix(arg, "+") {
			continue
		}
		if arg == "-r" && i+1 < len(args) && regexp.MustCompile(`^[0-9]+$`).MatchString(args[i+1]) {
			i++
			continue
		}
		return false
	}
	return true
}
