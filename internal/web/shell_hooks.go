package web

import (
	"context"
	"embed"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

//go:embed hooks/*.txt
var shellHooks embed.FS

func shellName(v any) string {
	name := stringOf(v)
	if name == "" {
		name = "sh"
	}
	if !set("sh bash zsh fish")[name] {
		fail(400, "Shell must be sh, bash, zsh or fish")
	}
	return name
}
func shellArgs(name string) []string {
	switch name {
	case "bash":
		return []string{"--noprofile", "--norc", "-i"}
	case "zsh":
		return []string{"-f", "-i"}
	case "fish":
		return []string{"--no-config", "--private", "--features=no-query-term", "-i"}
	default:
		return nil
	}
}
func shellProgram(name string) string {
	if name == "sh" {
		return platform.Executable("/bin/sh")
	}
	p, err := exec.LookPath(platform.Executable(name))
	if err != nil || !filepath.IsAbs(p) {
		fail(400, "Selected shell is not installed: "+name)
	}
	return p
}
func terminalInit(name, marker string, interactiveMode ...bool) string {
	interactive := len(interactiveMode) > 0 && interactiveMode[0]
	ready := strings.NewReplacer("\x1e", "\\036", "\x1f", "\\037").Replace(marker)
	script := "stty -echo\n"
	if runtime.GOOS == "windows" {
		// ConPTY uses absolute cursor positions when repainting. The bootstrap
		// trigger consumes a row before readiness, but pre-handshake output is
		// hidden from the frontend. Align both screens before the first prompt
		// so the initial resize cannot leave a second prompt on the next row.
		// Never reset the screen on resize: that would erase real user history.
		script += "printf '\\033[H\\033[2J'\n"
	}
	if name == "fish" {
		script += "set -e __lake_init\n"
	} else {
		script += "unset __lake_init\n"
	}
	// OpenSSH does not necessarily forward LANG/LC_*. Select a UTF-8 locale
	// installed on the target; otherwise Readline may interpret Chinese bytes
	// as Meta shortcuts instead of text. Keep an existing UTF-8 locale.
	localeProbe := `case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in *[Uu][Tt][Ff]*8*) printf '%s' "${LC_ALL:-${LC_CTYPE:-$LANG}}"; exit;; esac
LC_ALL=C locale -a 2>/dev/null | LC_ALL=C awk 'tolower($0) ~ /^(c|en_us)[.](utf-?8)$/ {print; found=1; exit} tolower($0) ~ /utf-?8/ && !fallback {fallback=$0} END {if (!found && fallback) print fallback}'`
	if name == "fish" {
		script += "set -l __lake_utf8_locale (/bin/sh -c " + quote(localeProbe) + "); if test -n \"$__lake_utf8_locale\"; set -gx LC_ALL \"$__lake_utf8_locale\"; end\n"
	} else {
		script += "__lake_utf8_locale=$(/bin/sh -c " + quote(localeProbe) + "); if [ -n \"$__lake_utf8_locale\" ]; then export LC_ALL=\"$__lake_utf8_locale\"; fi\n"
	}
	// The login shell and its startup files may change directories. Every new
	// terminal starts in the authenticated user's home, including remote PTYs.
	script += "cd -- \"$HOME\"\n"
	if name == "sh" {
		script += "PS1='' PS2=''\n"
	} else {
		b, _ := shellHooks.ReadFile("hooks/" + name + ".txt")
		script += string(b) + "\n"
	}
	if interactive {
		if name == "bash" || name == "sh" {
			// Readline initializes its Meta conversion settings before our locale
			// setup. Updating LC_ALL alone does not undo a C-locale startup.
			script += "if [ -n \"${BASH_VERSION-}\" ]; then bind 'set input-meta on'; bind 'set convert-meta off'; bind 'set output-meta on'; fi\n"
			if name == "sh" {
				script += "if [ -n \"${BASH_VERSION-}\" ]; then printf '\\033]9005;readline\\007'; fi\n"
			}
		}
		switch name {
		case "bash":
			script += "PS1='\\[\\033[35m\\][\\u@\\h\\[\\033[0m\\] \\w]\\$ '; PS2='> '\n"
		case "zsh":
			script += "PS1='%F{magenta}[%n@%m%f %~]%# '; PS2='> '; HISTSIZE=1000; SAVEHIST=0\n"
		case "fish":
			script += "set -g __lake_interactive 1\n"
		default:
			// /bin/sh can be Bash in POSIX mode. Readline must not count the
			// readiness/CWD frames as visible prompt columns, or SIGWINCH and
			// line editing truncate and overwrite the real prompt. Other sh
			// implementations must not receive Bash's literal \\[ delimiters.
			script += "__lake_prompt_path() { case \"$PWD\" in \"$HOME\") printf '~';; \"$HOME\"/*) printf '~/%s' \"${PWD#\"$HOME\"/}\";; *) printf '%s' \"$PWD\";; esac; }\n"
			script += "__lake_user=$(id -un); __lake_host=$(hostname -s); __lake_sign='$'; [ \"$(id -u)\" != 0 ] || __lake_sign='#'; __lake_prompt_frames=$(printf " + quote(ready) + ")'$(printf \"\\033]9003;%s;%s\\007\" \"$?\" \"$PWD\")'; [ -z \"${BASH_VERSION-}\" ] || __lake_prompt_frames='\\['\"$__lake_prompt_frames\"'\\]'; PS1=\"$__lake_prompt_frames\"'['\"$__lake_user@$__lake_host\"' $(__lake_prompt_path)]'\"$__lake_sign\"' '; PS2='> '\n"
		}
		if name == "fish" {
			script += "set -g __lake_managed 1; stty echo icanon; printf " + quote(ready) + "; set -e __lake_managed\n"
		} else {
			resetHistory := ""
			if name == "bash" {
				resetHistory = "history -c; "
			}
			if name == "zsh" {
				resetHistory = "fc -p /dev/null 1000 0; "
			}
			script += "__lake_managed=1; " + resetHistory + "stty echo icanon; printf " + quote(ready) + "; __lake_managed=\n"
		}
	} else {
		script += "stty icanon; printf " + quote(ready) + "\n"
	}
	// sh also supplies cwd; no preexec hook is installed in this fallback shell.
	if name == "sh" && !interactive {
		script += "printf '\\033]9003;0;%s\\007' \"$PWD\"\n"
	}
	// Evaluate one compound command. Sending these as separate commands makes
	// interactive shells render intermediate prompts after installing PS1,
	// and the sh readiness frame would expose those prompts to the UI.
	return "eval " + quote(script) + "\n"
}
func commandFrame(l *liveTerminal, command, marker string) string {
	start, finish := "", ""
	if l.job != nil && l.job.startMarker != "" {
		encoded := strings.NewReplacer("\x1e", "\\036", "\x1f", "\\037").Replace(l.job.startMarker)
		start = "stty -echo; printf " + quote(encoded) + "; "
		finish = "stty echo; "
	}
	if l.shell == "fish" {
		return "set -g __lake_managed 1; " + start + "eval " + quote(command) + "; set -l __lake_code $status; printf '\\033]9003;%s;%s\\007' $__lake_code \"$PWD\"; printf '\\036LAKE_DONE_" + marker + ":%s\\037\\n' $__lake_code; " + finish + "set -e __lake_managed\n"
	}
	return "__lake_managed=1; " + start + "eval " + quote(command) + "; __lake_code=$?; printf '\\033]9003;%s;%s\\007' \"$__lake_code\" \"$PWD\"; printf '\\036LAKE_DONE_" + marker + ":%s\\037\\n' \"$__lake_code\"; " + finish + "__lake_managed=\n"
}

// Hook frames are observations only. They never grant access or approve commands.
func (t *Terminals) stripHooks(l *liveTerminal, data string) string {
	data = l.hookPartial + data
	l.hookPartial = ""
	var out strings.Builder
	for len(data) > 0 {
		at := -1
		for _, prefix := range []string{"\x1b]9003;", "\x1b]9004;", "\x1b]9005;"} {
			i := strings.Index(data, prefix)
			if i >= 0 && (at < 0 || i < at) {
				at = i
			}
		}
		if at < 0 {
			keep := 0
			for n := 1; n < 8 && n <= len(data); n++ {
				tail := data[len(data)-n:]
				if strings.HasPrefix("\x1b]9003;", tail) || strings.HasPrefix("\x1b]9004;", tail) || strings.HasPrefix("\x1b]9005;", tail) {
					keep = n
				}
			}
			out.WriteString(data[:len(data)-keep])
			t.receivePlain(l, data[:len(data)-keep])
			l.hookPartial = data[len(data)-keep:]
			break
		}
		out.WriteString(data[:at])
		t.receivePlain(l, data[:at])
		data = data[at:]
		end := strings.IndexByte(data, '\a')
		if end < 0 {
			if len(data) <= 16<<10 {
				l.hookPartial = data
			} else {
				l.hooks = false
				out.WriteString("[invalid shell hook frame]")
			}
			break
		}
		if end <= 16<<10 {
			t.hook(l, data[2:end])
		} else {
			l.hooks = false
		}
		data = data[end+1:]
	}
	return out.String()
}
func (t *Terminals) hook(l *liveTerminal, frame string) {
	if frame == "9005;readline" && l.shell == "sh" && !l.ready {
		l.promptRedraw = true
		return
	}
	if strings.HasPrefix(frame, "9003;") {
		p := strings.SplitN(strings.TrimPrefix(frame, "9003;"), ";", 2)
		if len(p) != 2 {
			return
		}
		code, err := strconv.Atoi(p[0])
		absolute := path.IsAbs(p[1])
		if !l.remote {
			p[1] = platform.FromShellPath(p[1])
			absolute = filepath.IsAbs(p[1])
		}
		if err != nil || code < 0 || code > 255 || !absolute || strings.ContainsAny(p[1], "\x00\x1b\r\n") {
			return
		}
		l.hooks = true
		l.userInputPending = false
		l.capturedAt = now()
		t.store.ShellState(l.session, l.id, l.shell, p[1])
		if l.job != nil && l.job.manual {
			t.finish(l, code, "", false)
		}
		if l.rawUserPending {
			l.rawUserPending = false
			t.store.TerminalStatus(l.session, l.id, "ready")
		}
	} else if strings.HasPrefix(frame, "9004;") && l.ready && l.job == nil {
		command := strings.TrimPrefix(frame, "9004;")
		if !validCommand(command) || t.containsCredential(command) {
			return
		}
		term := t.store.Terminal(l.session, l.id)
		var entry Object
		if l.rawOrigin != "" && term["holder"] == "agent" {
			entry = t.store.ObserveInputCommand(l.session, l.id, l.rawOrigin, command)
			l.rawOrigin = ""
		} else {
			if term["status"] != "ready" || term["holder"] != "user" {
				return
			}
			entry = t.store.BeginCommand(l.session, l.id, "user", command, "")
		}
		job := &terminalJob{entry: entry, done: make(chan struct{}), manual: true}
		l.job = job
		t.mu.Lock()
		t.jobs[stringOf(entry["id"])] = job
		t.mu.Unlock()
	}
}
func (s *Store) ShellState(id, tid, shell, cwd string) {
	s.update(func() any {
		s.terminal(id, tid)
		s.exec("UPDATE terminals SET shell=?,cwd=? WHERE id=?", shell, cwd, tid)
		s.event(id, "terminal")
		return nil
	})
}
func (t *Terminals) Capabilities(id, tid string) Object {
	if t.ResolveAccess != nil {
		id = t.ResolveAccess(id, tid, false)
	}
	term := t.store.Terminal(id, tid)
	caps := Object{"screen": false, "input": false, "key": false, "expect": false, "commandBlocks": false, "generation": term["generation"], "status": term["status"], "reason": "终端已断开，仅可读取历史输出"}
	t.mu.Lock()
	l := t.live[tid]
	t.mu.Unlock()
	if l == nil {
		return caps
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.closed && l.ready {
		for _, k := range []string{"screen", "input", "key", "expect"} {
			caps[k] = true
		}
		caps["commandBlocks"] = l.shell == "sh" || l.hooks
		caps["reason"] = ""
		if caps["commandBlocks"] == false {
			caps["reason"] = "Shell hooks 尚未完成握手，命令块执行不可用"
		}
	}
	return caps
}
func (t *Terminals) OpenShell(ctx context.Context, id, ref, name string) Object {
	return t.open(ctx, id, ref, shellName(name))
}
func (t *Terminals) OpenInteractive(ctx context.Context, id, ref, name string) Object {
	if name != "" {
		name = shellName(name)
	}
	return t.open(ctx, id, ref, name, true)
}
func (t *Terminals) UserInteractive(tid string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	l := t.live[tid]
	return l != nil && l.interactive
}
func remoteShellCommand(name string) string {
	if name == "sh" {
		return "exec /bin/sh"
	}
	return fmt.Sprintf("exec %s %s", name, strings.Join(shellArgs(name), " "))
}

// Input was authorized before it was sent. This method records an observation only.
func (s *Store) ObserveInputCommand(id, tid, origin, command string) Object {
	return s.update(func() any {
		term := s.terminal(id, tid)
		eid := ident()
		at := now()
		s.exec("INSERT INTO terminalEntries(id,terminalId,actor,command,output,createdAt,status,generation,cwd,startedAt,originSessionId) VALUES(?,?,?,?,?,?,?,?,?,?,?)", eid, tid, "agent", command, "", at, "running", term["generation"], term["cwd"], at, origin)
		s.event(id, "terminal")
		return s.row("SELECT * FROM terminalEntries WHERE id=?", eid)
	}).(Object)
}
