package web

import (
	"os/exec"
	"path"
	"regexp"
	"sort"
	"strings"
)

// ConPTY consumes RS/US and private OSC commands while rendering a console.
// OSC 0 is preserved in its output stream. Carry private observations in that
// envelope and restore them before the ordinary terminal parser sees them.
const consoleFramePrefix = "\x1b]0;LAKE_FRAME_"
const consoleHookPrefix = "\x1b]0;LAKE_HOOK_"
const consoleReadyHookPrefix = "\x1b]0;LAKE_READY_HOOK_"

// ConPTY receives a raw Windows environment block instead of exec.Cmd's usual
// environment processing. Match Go's last-value-wins semantics before sorting:
// an inherited SSH_ASKPASS must not override this connection's private helper.
func consoleTerminalEnvironment(env []string) []string {
	values := map[string]string{}
	for _, entry := range env {
		at := strings.IndexByte(entry, '=')
		if at == 0 {
			// Preserve Windows' per-drive current-directory variables (=C:=...).
			if next := strings.IndexByte(entry[1:], '='); next >= 0 {
				at = next + 1
			}
		}
		if at <= 0 {
			continue
		}
		values[strings.ToUpper(entry[:at])] = entry
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, values[key])
	}
	return result
}

var encodedConsoleFrame = regexp.MustCompile(`\\036LAKE_([^\\\r\n'"]*)\\037`)
var encodedConsoleReady = regexp.MustCompile(`\\036LAKE_READY_([a-zA-Z0-9_-]+)\\037`)

// Local shells receive initialization through the environment; SSH carries it
// in the remote command argument. Both paths pass through the same ConPTY.
func consoleTerminalCommand(cmd *exec.Cmd) ([]string, []string) {
	args := append([]string(nil), cmd.Args...)
	if len(args) > 1 {
		program := strings.ToLower(path.Base(strings.ReplaceAll(args[0], "\\", "/")))
		if program == "ssh" || program == "ssh.exe" {
			args[len(args)-1] = consoleTerminalScript(args[len(args)-1])
		}
	}
	env := append([]string(nil), cmd.Env...)
	for i, item := range env {
		if key, value, ok := strings.Cut(item, "="); ok && strings.EqualFold(key, "__lake_init") {
			env[i] = key + "=" + consoleTerminalScript(value)
		}
	}
	return args, env
}

func consoleTerminalScript(script string) string {
	if !strings.Contains(script, `\036LAKE_`) && !strings.Contains(script, `\033]900`) {
		return script
	}
	// ConPTY can coalesce successive title changes. Keep the startup nonce in
	// the cwd/prompt title too, so the final retained title proves readiness.
	cwdPrefix := `\033]0;LAKE_HOOK_9003;`
	if ready := encodedConsoleReady.FindStringSubmatch(script); len(ready) == 2 {
		cwdPrefix = `\033]0;LAKE_READY_HOOK_` + ready[1] + `;9003;`
	}
	script = encodedConsoleFrame.ReplaceAllString(script, `\033]0;LAKE_FRAME_${1}\007`)
	return strings.NewReplacer(
		`\033]9003;`, cwdPrefix,
		`\033]9004;`, `\033]0;LAKE_HOOK_9004;`,
		`\033]9005;`, `\033]0;LAKE_HOOK_9005;`,
	).Replace(script)
}

type consoleFrameDecoder struct{ pending, ready string }

func (d *consoleFrameDecoder) feed(chunk string, final bool) string {
	data := d.pending + chunk
	d.pending = ""
	var out strings.Builder
	for data != "" {
		at, prefix := -1, ""
		for _, candidate := range []string{consoleFramePrefix, consoleHookPrefix, consoleReadyHookPrefix} {
			if i := strings.Index(data, candidate); i >= 0 && (at < 0 || i < at) {
				at, prefix = i, candidate
			}
		}
		if at < 0 {
			keep := 0
			if !final {
				for _, candidate := range []string{consoleFramePrefix, consoleHookPrefix, consoleReadyHookPrefix} {
					for n := 1; n < len(candidate) && n <= len(data); n++ {
						if strings.HasSuffix(data, candidate[:n]) && n > keep {
							keep = n
						}
					}
				}
			}
			out.WriteString(data[:len(data)-keep])
			d.pending = data[len(data)-keep:]
			break
		}
		out.WriteString(data[:at])
		data = data[at:]
		end, size := strings.IndexByte(data, '\a'), 1
		if st := strings.Index(data, "\x1b\\"); st >= 0 && (end < 0 || st < end) {
			end, size = st, 2
		}
		if end < 0 {
			if !final && len(data) <= 16<<10 {
				d.pending = data
			} else {
				out.WriteString("[invalid console frame]")
			}
			break
		}
		if end > 16<<10 {
			out.WriteString("[invalid console frame]")
		} else {
			payload := data[len(prefix):end]
			if prefix == consoleFramePrefix {
				if id, isReady := strings.CutPrefix(payload, "READY_"); !isReady || id != d.ready {
					out.WriteString("\x1eLAKE_" + payload + "\x1f")
					if isReady {
						d.ready = id
					}
				}
			} else if prefix == consoleReadyHookPrefix {
				id, hook, ok := strings.Cut(payload, ";")
				if !ok || id == "" || len(id) > 128 || !strings.HasPrefix(hook, "9003;") {
					out.WriteString("[invalid console frame]")
				} else {
					if id != d.ready {
						out.WriteString("\x1eLAKE_READY_" + id + "\x1f")
						d.ready = id
					}
					out.WriteString("\x1b]" + hook + "\a")
				}
			} else {
				out.WriteString("\x1b]" + payload + "\a")
			}
		}
		data = data[end+size:]
	}
	return out.String()
}
