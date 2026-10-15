package web

import (
	"regexp"
	"strings"
)

// ConPTY consumes RS/US and private OSC commands while rendering a console.
// OSC 0 is preserved in its output stream. Carry private observations in that
// envelope and restore them before the ordinary terminal parser sees them.
const consoleFramePrefix = "\x1b]0;LAKE_FRAME_"
const consoleHookPrefix = "\x1b]0;LAKE_HOOK_"

var encodedConsoleFrame = regexp.MustCompile(`\\036LAKE_([^\\\r\n'"]*)\\037`)

func consoleTerminalScript(script string) string {
	if !strings.Contains(script, `\036LAKE_`) && !strings.Contains(script, `\033]900`) {
		return script
	}
	script = encodedConsoleFrame.ReplaceAllString(script, `\033]0;LAKE_FRAME_${1}\007`)
	return strings.NewReplacer(
		`\033]9003;`, `\033]0;LAKE_HOOK_9003;`,
		`\033]9004;`, `\033]0;LAKE_HOOK_9004;`,
		`\033]9005;`, `\033]0;LAKE_HOOK_9005;`,
	).Replace(script)
}

type consoleFrameDecoder struct{ pending string }

func (d *consoleFrameDecoder) feed(chunk string, final bool) string {
	data := d.pending + chunk
	d.pending = ""
	var out strings.Builder
	for data != "" {
		at, prefix := -1, ""
		for _, candidate := range []string{consoleFramePrefix, consoleHookPrefix} {
			if i := strings.Index(data, candidate); i >= 0 && (at < 0 || i < at) {
				at, prefix = i, candidate
			}
		}
		if at < 0 {
			keep := 0
			if !final {
				for _, candidate := range []string{consoleFramePrefix, consoleHookPrefix} {
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
				out.WriteString("\x1eLAKE_" + payload + "\x1f")
			} else {
				out.WriteString("\x1b]" + payload + "\a")
			}
		}
		data = data[end+size:]
	}
	return out.String()
}
