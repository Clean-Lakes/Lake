package ai

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

func fileGlob(pattern string) (*regexp.Regexp, error) {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(pattern); i++ {
		switch pattern[i] {
		case '*':
			if i+1 < len(pattern) && pattern[i+1] == '*' {
				i++
				if i+1 < len(pattern) && pattern[i+1] == '/' {
					i++
					b.WriteString("(?:.*/)?")
				} else {
					b.WriteString(".*")
				}
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		default:
			b.WriteString(regexp.QuoteMeta(string(pattern[i])))
		}
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}
func (e *Engine) searchFiles(ctx context.Context, c Config, name string, a map[string]any) (any, error) {
	offset, limit := num(a["offset"], 0), num(a["limit"], 250)
	if offset < 0 || limit < 1 || limit > 1000 {
		return nil, errors.New("invalid search page")
	}
	if !localFileRuntime(c, a) {
		return e.remoteSearch(ctx, c, name, a, offset, limit)
	}
	root := str(a["path"])
	real, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	if safeFile(real) != nil {
		return nil, errors.New("credential paths unavailable")
	}
	root = real
	pattern := str(a["pattern"])
	filter := str(a["glob"])
	if name == "glob" {
		filter = pattern
	}
	var glob *regexp.Regexp
	if filter != "" {
		glob, err = fileGlob(filepath.ToSlash(filter))
		if err != nil {
			return nil, err
		}
	}
	var re *regexp.Regexp
	if name == "grep" {
		if a["ignore_case"] == true {
			pattern = "(?i)" + pattern
		}
		re, err = regexp.Compile(pattern)
		if err != nil {
			return nil, err
		}
	}
	mode := str(a["output_mode"])
	if mode == "" {
		mode = "content"
	}
	contextLines := num(a["context"], 0)
	if contextLines < 0 || contextLines > 20 {
		return nil, errors.New("invalid context")
	}
	records := []string{}
	sourceLimited := false
	visited := 0
	stop := errors.New("page ready")
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if walkErr != nil {
			return walkErr
		}
		if safeFile(path) != nil || safeConfiguredFile(c, path) != nil {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		visited++
		if visited > 10000 {
			sourceLimited = true
			return stop
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if rel == "." {
			rel = filepath.Base(path)
		}
		rel = filepath.ToSlash(rel)
		if glob != nil && !glob.MatchString(rel) && !glob.MatchString(filepath.Base(path)) {
			return nil
		}
		if name == "glob" {
			records = append(records, path)
		} else {
			st, err := d.Info()
			if err != nil {
				return err
			}
			if !st.Mode().IsRegular() {
				return nil
			}
			if st.Size() > 16<<20 {
				sourceLimited = true
				return nil
			}
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			scanner := bufio.NewScanner(f)
			scanner.Buffer(make([]byte, 65536), 1<<20)
			lines := []string{}
			matches := []int{}
			for scanner.Scan() {
				line := scanner.Text()
				if strings.IndexByte(line, 0) >= 0 {
					f.Close()
					return nil
				}
				lines = append(lines, line)
				if re.MatchString(line) {
					matches = append(matches, len(lines)-1)
				}
			}
			scanErr := scanner.Err()
			f.Close()
			if scanErr != nil {
				return fmt.Errorf("search %s: %w", path, scanErr)
			}
			if len(matches) == 0 {
				return nil
			}
			switch mode {
			case "files_with_matches":
				records = append(records, path)
			case "count":
				records = append(records, fmt.Sprintf("%s:%d", path, len(matches)))
			case "content":
				selected := map[int]bool{}
				for _, match := range matches {
					for i := max(0, match-contextLines); i <= min(len(lines)-1, match+contextLines); i++ {
						selected[i] = true
					}
				}
				for i, line := range lines {
					if selected[i] {
						records = append(records, fmt.Sprintf("%s:%d:%s", path, i+1, redact(line, c)))
						if len(records) > offset+limit {
							return stop
						}
					}
				}
			default:
				return errors.New("invalid output_mode")
			}
		}
		if len(records) > offset+limit {
			return stop
		}
		return nil
	})
	if err != nil && !errors.Is(err, stop) {
		return nil, err
	}
	return searchPage(records, offset, limit, sourceLimited), nil
}
func searchPage(records []string, offset, limit int, sourceLimited bool) map[string]any {
	start := min(offset, len(records))
	end := min(start+limit, len(records))
	more := end < len(records)
	out := map[string]any{"lines": records[start:end], "offset": offset, "truncated": more, "source_truncated": sourceLimited, "exitCode": 0}
	if more {
		out["next_offset"] = end
	}
	return out
}
func (e *Engine) remoteSearch(ctx context.Context, c Config, name string, a map[string]any, offset, limit int) (any, error) {
	path := str(a["path"])
	argv := []string{}
	fallback := []string{}
	if name == "glob" {
		argv = []string{"rg", "--files", "--hidden", "-g", str(a["pattern"]), "-g", "!.ssh/**", "-g", "!.lake/**", "-g", "!Keychains/**", "--", path}
		patternFlag := "-name"
		pattern := str(a["pattern"])
		if strings.Contains(pattern, "/") {
			patternFlag = "-path"
			pattern = "*/" + pattern
		}
		fallback = []string{"find", path, "-type", "d", "(", "-name", ".ssh", "-o", "-name", ".lake", "-o", "-name", "Keychains", ")", "-prune", "-o", "-type", "f", patternFlag, pattern, "-print"}
	} else {
		argv = []string{"rg", "-n", "--no-heading", "--color", "never", "-g", "!.ssh/**", "-g", "!.lake/**", "-g", "!Keychains/**"}
		fallback = []string{"grep", "-rnE", "--exclude-dir=.ssh", "--exclude-dir=.lake", "--exclude-dir=Keychains"}
		if a["ignore_case"] == true {
			argv = append(argv, "-i")
			fallback = append(fallback, "-i")
		}
		if glob := str(a["glob"]); glob != "" {
			argv = append(argv, "-g", glob)
			fallback = append(fallback, "--include="+glob)
		}
		switch str(a["output_mode"]) {
		case "files_with_matches":
			argv = append(argv, "-l")
			fallback = append(fallback, "-l")
		case "count":
			argv = append(argv, "-c")
			fallback = append(fallback, "-c")
		case "", "content":
			if n := num(a["context"], 0); n > 0 {
				argv = append(argv, "-C", strconv.Itoa(n))
				fallback = append(fallback, "-C", strconv.Itoa(n))
			}
		default:
			return nil, errors.New("invalid output_mode")
		}
		argv = append(argv, "--", str(a["pattern"]), path)
		fallback = append(fallback, "--", str(a["pattern"]), path)
	}
	command := "if command -v rg >/dev/null 2>&1; then " + joinArgs(argv) + "; else " + joinArgs(fallback) + "; fi"
	// Bound the source to the requested prefix. Exit status 1 means no matches.
	result, err := e.execRuntime(ctx, c, a, []string{"/bin/sh", "-c", command}, "")
	if err != nil {
		return nil, err
	}
	if code := num(result["exitCode"], 0); code != 0 && code != 1 {
		return nil, errors.New("file search failed")
	}
	output := strings.TrimSuffix(runtimeStdout(result), "\n")
	records := []string{}
	if output != "" {
		records = strings.Split(output, "\n")
	}
	page := searchPage(records, offset, limit, result["truncated"] == true)
	if result["truncated"] == true && page["truncated"] == false {
		return nil, errors.New("source search output truncated; narrow path or pattern")
	}
	return page, nil
}
