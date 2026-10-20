package web

import (
	"regexp"
	"strings"
	"unicode"
)

// Only stdin filters are eligible: no script files, input filenames, arbitrary
// variables, dynamic command execution, or awk input/output redirection.
func readonlyAwk(args []string) bool {
	forbidden := set("system getline close fflush ENVIRON ARGV ARGC PROCINFO FUNCTAB SYMTAB function")
	for len(args) > 0 {
		if args[0] == "-v" {
			if len(args) < 3 {
				return false
			}
			name, _, ok := strings.Cut(args[1], "=")
			if !ok || !regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`).MatchString(name) || forbidden[name] {
				return false
			}
			args = args[2:]
			continue
		}
		if args[0] == "--" {
			args = args[1:]
			break
		}
		if args[0] == "-F" {
			if len(args) < 3 {
				return false
			}
			args = args[2:]
			continue
		}
		if strings.HasPrefix(args[0], "-F") && len(args[0]) > 2 {
			args = args[1:]
			continue
		}
		break
	}
	if len(args) != 1 || strings.HasPrefix(args[0], "-") {
		return false
	}
	program := []rune(args[0])
	functions := set("length substr index match sub gsub split sprintf tolower toupper int sqrt log exp sin cos atan2 rand srand strftime systime")
	controls := set("if for")
	regexPosition := true
	printing := false
	for i := 0; i < len(program); {
		c := program[i]
		if unicode.IsSpace(c) {
			i++
			continue
		}
		if c == '"' || c == '/' && regexPosition {
			delimiter := c
			i++
			closed := false
			for i < len(program) {
				if program[i] == '\\' {
					i += 2
					continue
				}
				if program[i] == delimiter {
					i++
					closed = true
					break
				}
				i++
			}
			if !closed {
				return false
			}
			regexPosition = false
			continue
		}
		if unicode.IsLetter(c) || c == '_' {
			start := i
			i++
			for i < len(program) && (unicode.IsLetter(program[i]) || unicode.IsDigit(program[i]) || program[i] == '_') {
				i++
			}
			word := string(program[start:i])
			if forbidden[word] {
				return false
			}
			next := i
			for next < len(program) && unicode.IsSpace(program[next]) {
				next++
			}
			if next < len(program) && program[next] == '(' && !functions[word] && !controls[word] && !set("print printf")[word] {
				return false
			}
			if word == "print" || word == "printf" {
				printing = true
				regexPosition = true
			} else {
				regexPosition = false
			}
			continue
		}
		if unicode.IsDigit(c) {
			i++
			for i < len(program) && (unicode.IsDigit(program[i]) || program[i] == '.') {
				i++
			}
			regexPosition = false
			continue
		}
		switch c {
		case '|', '&':
			if i+1 >= len(program) || program[i+1] != c {
				return false
			}
			i += 2
			regexPosition = true
		case '>':
			if printing {
				return false
			}
			i++
			if i < len(program) && program[i] == '=' {
				i++
			}
			regexPosition = true
		case '<', '!', '=':
			i++
			if i < len(program) && program[i] == '=' {
				i++
			}
			regexPosition = true
		case '{', '}':
			printing = false
			regexPosition = true
			i++
		case ';':
			printing = false
			regexPosition = true
			i++
		case '(', ')', '[', ']', ',', '~', ':', '?', '+', '-', '*', '/', '%', '^', '$':
			regexPosition = c != ')' && c != ']'
			i++
		default:
			return false
		}
	}
	return true
}

func readonlyQueryProgram(program string, args []string) bool {
	switch program {
	case "curl":
		return readonlyHealthCurl(args)
	case "systemctl":
		return readonlySystemctl(args)
	case "docker", "podman":
		return readonlyContainerList(args)
	case "sed":
		return readonlySed(args)
	case "awk":
		return readonlyAwk(args)
	case "env":
		return len(args) == 0
	case "sort":
		for i := 0; i < len(args); i++ {
			arg := args[i]
			if regexp.MustCompile(`^-[bnrfhVMgdsu]+$`).MatchString(arg) {
				continue
			}
			if arg == "-k" || arg == "-t" {
				i++
				if i >= len(args) {
					return false
				}
				continue
			}
			if strings.HasPrefix(arg, "-k") && len(arg) > 2 || strings.HasPrefix(arg, "-t") && len(arg) > 2 {
				continue
			}
			return false
		}
		return true
	case "ss":
		for i := 0; i < len(args); i++ {
			if regexp.MustCompile(`^-[taunlpsoeir46HO]+$`).MatchString(args[i]) {
				continue
			}
			if set("state dst src sport dport")[args[i]] {
				i++
				if i >= len(args) {
					return false
				}
				continue
			}
			return false
		}
		return true
	case "netstat":
		for i := 0; i < len(args); i++ {
			if set("-p -f -I")[args[i]] {
				i++
				if i >= len(args) || !regexp.MustCompile(`^[a-zA-Z0-9_.:-]+$`).MatchString(args[i]) {
					return false
				}
				continue
			}
			if !regexp.MustCompile(`^-[AaBbdeghilmnprstuvW]+$`).MatchString(args[i]) {
				return false
			}
		}
		return true
	case "lsof":
		for i := 0; i < len(args); i++ {
			arg := args[i]
			if regexp.MustCompile(`^-[abnPlRt]+$`).MatchString(arg) || arg == "+L1" || arg == "-U" {
				continue
			}
			if set("-i -p -u -c -F -s")[arg] {
				i++
				if i >= len(args) || args[i] == "" || strings.HasPrefix(args[i], "-") || strings.ContainsAny(args[i], "/\\") {
					return false
				}
				continue
			}
			if regexp.MustCompile(`^-(i|p|u|c|F|s)[a-zA-Z0-9_.,:@^+-]+$`).MatchString(arg) {
				continue
			}
			return false
		}
		return true
	case "ifconfig":
		return len(args) == 0 || len(args) == 1 && regexp.MustCompile(`^(-a|-l|[a-zA-Z][a-zA-Z0-9_.:-]*)$`).MatchString(args[0]) || len(args) == 2 && set("inet inet6")[args[1]]
	case "route":
		for _, arg := range args {
			if strings.HasPrefix(arg, "-") && !set("-n -v")[arg] {
				return false
			}
		}
		for len(args) > 0 && set("-n -v")[args[0]] {
			args = args[1:]
		}
		return len(args) == 0 || set("get show list")[args[0]]
	case "networksetup":
		return len(args) > 0 && (strings.HasPrefix(args[0], "-get") || strings.HasPrefix(args[0], "-list"))
	case "ip":
		for len(args) > 0 && strings.HasPrefix(args[0], "-") {
			if !set("-4 -6 -s -d -br -o -j -p")[args[0]] {
				return false
			}
			args = args[1:]
		}
		if len(args) == 0 || !set("addr address a link l route r neigh neighbor n")[args[0]] {
			return false
		}
		if len(args) == 1 {
			return true
		}
		return set("show list lst")[args[1]]
	}
	return true
}

// Narrow service/list queries only. Arbitrary verbs, remote overrides, unit
// changes and container exec/create actions cannot acquire readonly status.
func readonlySystemctl(args []string) bool {
	verb := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		if set("status show is-active is-failed list-units list-unit-files")[a] && !verb {
			verb = true
			continue
		}
		if set("--failed --no-legend --plain --no-pager --all --full -a -l")[a] {
			continue
		}
		if set("--type --state --property -p")[a] {
			i++
			if i >= len(args) || !regexp.MustCompile(`^[A-Za-z0-9_,.-]+$`).MatchString(args[i]) {
				return false
			}
			continue
		}
		if regexp.MustCompile(`^--(type|state|property)=[A-Za-z0-9_,.-]+$`).MatchString(a) {
			continue
		}
		if verb && regexp.MustCompile(`^[A-Za-z0-9_.*@:-]+$`).MatchString(a) && !strings.HasPrefix(a, "-") {
			continue
		}
		return false
	}
	return len(args) > 0
}
func readonlyContainerList(args []string) bool {
	if len(args) == 0 || args[0] != "ps" {
		return false
	}
	for i := 1; i < len(args); i++ {
		a := args[i]
		if set("--all --quiet --no-trunc --size --latest")[a] || regexp.MustCompile(`^-[aqsl]+$`).MatchString(a) {
			continue
		}
		if a == "--format" || a == "--filter" || a == "-f" {
			i++
			if i >= len(args) || args[i] == "" {
				return false
			}
			continue
		}
		if strings.HasPrefix(a, "--format=") || strings.HasPrefix(a, "--filter=") {
			continue
		}
		return false
	}
	return true
}
