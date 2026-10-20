package ai

import (
	"path"
	"regexp"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

// Command silence authorizes ordinary commands. Keep a separate guard for
// broad data loss rather than treating every unclassified command as a wipe.
func CatastrophicCommand(command string) bool {
	return catastrophicScript(command, 0)
}

func catastrophicScript(command string, depth int) bool {
	if depth > 8 {
		return true
	}
	file, err := syntax.NewParser().Parse(strings.NewReader(command), "")
	if err != nil {
		// Invalid or incomplete terminal input is not independently executable.
		// Still protect recognizable removal/device commands in that input.
		return regexp.MustCompile(`\b(rm|shred|mkfs|wipefs|dd)\b`).MatchString(command)
	}
	critical := false
	probes := boundedTCPProbeCalls(file)
	syntax.Walk(file, func(node syntax.Node) bool {
		if critical {
			return false
		}
		switch node := node.(type) {
		case *syntax.CallExpr:
			if !probes[node] {
				critical = catastrophicCall(node.Args, depth)
			}
		case *syntax.Redirect:
			if node.Op == syntax.RdrOut || node.Op == syntax.AppOut || node.Op == syntax.RdrAll || node.Op == syntax.AppAll {
				target, _, _ := guardWord(node.Word)
				critical = guardDevice.MatchString(target)
			}
		}
		return !critical
	})
	return critical
}

var guardDevice = regexp.MustCompile(`^/dev/(?:r?disk\d|sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|mmcblk\d)`)
var guardUserRoot = regexp.MustCompile(`^(?:/(?:Users|home)/[^/]+|~)(?:/(?:Desktop|Documents|Downloads|Pictures|Library))?$`)
var guardEscape = regexp.MustCompile(`\\(.)`)

// Value is unquoted text; glob records only active shell patterns, so a quoted
// filename like 'report*' does not become a broad filesystem operation.
func guardWord(word *syntax.Word) (value string, dynamic, glob bool) {
	if word == nil {
		return "", true, false
	}
	var part func(syntax.WordPart, bool)
	part = func(p syntax.WordPart, quoted bool) {
		switch p := p.(type) {
		case *syntax.Lit:
			literal := p.Value
			if !quoted {
				literal = guardEscape.ReplaceAllString(literal, "$1")
			}
			value += literal
			if !quoted && strings.ContainsAny(guardEscape.ReplaceAllString(p.Value, ""), "*?[") {
				glob = true
			}
		case *syntax.SglQuoted:
			value += p.Value
		case *syntax.DblQuoted:
			for _, inner := range p.Parts {
				part(inner, true)
			}
		default:
			dynamic = true
		}
	}
	for _, p := range word.Parts {
		part(p, false)
	}
	return
}

func broadRemovalTarget(value string, dynamic, glob bool) bool {
	if dynamic || value == "" {
		return true
	}
	value = path.Clean(value)
	if glob {
		// A filename filter such as old-*.log remains an ordinary deletion;
		// clearing an entire directory with * or .* is a different scope.
		switch path.Base(value) {
		case "*", ".*", "*.*", "[!.]*", "..?*":
			return true
		}
	}
	if guardUserRoot.MatchString(value) {
		return true
	}
	switch value {
	case ".", "..", "/", "~", "~/", "{}", "/Users", "/home", "/root", "/etc", "/usr", "/usr/local", "/var", "/var/lib", "/System", "/Library", "/Applications", "/Volumes", "/boot", "/bin", "/sbin", "/tmp", "/private", "/private/tmp":
		return true
	}
	return false
}

// A delete tool recursively removes its named target, too. Protect broad roots
// even if the model chooses the structured tool instead of a shell command.
func CatastrophicDelete(target string) bool {
	return broadRemovalTarget(target, false, false)
}

func catastrophicCall(words []*syntax.Word, depth int) bool {
	if len(words) == 0 {
		return false
	}
	program, dynamic, _ := guardWord(words[0])
	if dynamic {
		return false
	}
	program = path.Base(program)
	args := words[1:]
	switch program {
	case "sudo", "doas", "command", "env", "exec", "nice", "nohup", "timeout", "xargs":
		// Look only at the nested executable, never display/pattern arguments.
		skipValue := false
		valueOptions := map[string]string{"sudo": " -u -g -h -p -C -T ", "doas": " -u ", "env": " -u -C ", "nice": " -n ", "xargs": " -n -I -J -L -P -s -a "}[program]
		for i, word := range args {
			value, variable, _ := guardWord(word)
			if skipValue {
				skipValue = false
				continue
			}
			if program == "env" && value == "-S" && i+1 < len(args) {
				script, variable, _ := guardWord(args[i+1])
				return variable || catastrophicScript(script, depth+1)
			}
			if strings.Contains(valueOptions, " "+value+" ") {
				skipValue = true
				continue
			}
			if variable || strings.HasPrefix(value, "-") || strings.Contains(value, "=") {
				continue
			}
			if program == "timeout" && i == 0 {
				continue
			}
			return catastrophicCall(args[i:], depth+1)
		}
	case "eval":
		values := []string{}
		for _, word := range args {
			value, variable, _ := guardWord(word)
			if variable {
				return true
			}
			values = append(values, value)
		}
		return catastrophicScript(strings.Join(values, " "), depth+1)
	case "sh", "bash", "zsh", "fish":
		for i, word := range args {
			value, variable, _ := guardWord(word)
			if strings.HasPrefix(value, "-") && strings.Contains(value, "c") && i+1 < len(args) {
				value, variable, _ = guardWord(args[i+1])
				if variable || catastrophicScript(value, depth+1) {
					return true
				}
			}
		}
	case "rm", "rmdir", "unlink", "srm", "shred", "trash-empty", "gtrash":
		if program == "trash-empty" || program == "gtrash" && len(args) > 0 && args[0].Lit() == "empty" {
			return true
		}
		options, recursive, targetSeen := true, false, false
		for _, word := range args {
			value, variable, glob := guardWord(word)
			if options && value == "--" {
				options = false
				continue
			}
			if options && strings.HasPrefix(value, "-") && !variable {
				recursive = recursive || value == "--recursive" || !strings.HasPrefix(value, "--") && strings.ContainsAny(value, "rR")
				continue
			}
			targetSeen = true
			if broadRemovalTarget(value, variable, glob) || guardDevice.MatchString(value) {
				return true
			}
		}
		return recursive && !targetSeen
	case "find":
		deletes, broad := false, false
		if len(args) > 0 && strings.HasPrefix(args[0].Lit(), "-") {
			broad = true // No explicit root means the current directory.
		}
		for i, word := range args {
			value, variable, glob := guardWord(word)
			if value == "-delete" {
				deletes = true
			}
			if value == "-exec" || value == "-execdir" || value == "-ok" || value == "-okdir" {
				if catastrophicCall(args[i+1:], depth+1) {
					return true
				}
				break
			}
			if i == 0 || !strings.HasPrefix(value, "-") && i > 0 && !strings.HasPrefix(args[i-1].Lit(), "-") {
				broad = broad || broadRemovalTarget(value, variable, glob)
			}
		}
		return deletes && broad
	case "mkfs", "wipefs", "fdisk", "parted", "diskutil":
		values := []string{}
		for _, word := range args {
			value, _, _ := guardWord(word)
			values = append(values, value)
			if value == "--help" || value == "--version" {
				return false
			}
		}
		if program == "fdisk" {
			for _, value := range values {
				if value == "-l" || value == "--list" {
					return false
				}
			}
			return true
		}
		if program == "wipefs" {
			for _, value := range values {
				if value == "--all" || value == "--offset" || strings.HasPrefix(value, "--offset=") || strings.HasPrefix(value, "-") && !strings.HasPrefix(value, "--") && strings.ContainsAny(value, "ao") {
					return true
				}
			}
			return false
		}
		if program == "parted" {
			for _, value := range values {
				if strings.Contains(" mklabel mktable mkpart rm resizepart rescue ", " "+value+" ") {
					return true
				}
			}
			return false
		}
		if program == "mkfs" {
			return true
		}
		for _, word := range args {
			if strings.HasPrefix(strings.ToLower(word.Lit()), "erase") || word.Lit() == "partitionDisk" {
				return true
			}
		}
	case "dd":
		for _, word := range args {
			value, variable, _ := guardWord(word)
			if strings.HasPrefix(value, "of=") && (variable || guardDevice.MatchString(strings.TrimPrefix(value, "of="))) {
				return true
			}
		}
	}
	return strings.HasPrefix(program, "mkfs.")
}
