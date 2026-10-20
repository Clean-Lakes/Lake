package web

import (
	"path"
	"regexp"
	"strings"
	"unicode"
)

type Policy struct {
	Risk            string `json:"risk"`
	Reason          string `json:"riskReason"`
	Destructive     bool   `json:"destructive,omitempty"`
	DestructiveOnly bool   `json:"destructiveOnly,omitempty"`
	Safe            string `json:"safeCommand,omitempty"`
}

func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
func set(s string) map[string]bool {
	m := map[string]bool{}
	for _, v := range strings.Fields(s) {
		m[v] = true
	}
	return m
}

var dangerPrograms = set("sudo su doas mv rm rmdir unlink srm trash trash-put trash-empty trash-rm gtrash shred dd mkfs wipefs fdisk parted shutdown reboot halt poweroff kill killall pkill chmod chown chgrp chattr")
var readPrograms = set("systemctl docker podman pwd uname uptime df du ls cat head tail wc grep egrep fgrep find ps free vmstat vm_stat iostat top sysctl date hostname whoami id who w stat file readlink printf echo true false sleep hdiutil awk env sort sed ss netstat lsof ifconfig route networksetup ip curl")
var wrappers = set("sh bash zsh fish osascript python python3 perl ruby node awk eval exec source . env command xargs nice timeout nohup")
var sensitive = regexp.MustCompile(`(?i)(\.lake/secrets|\.ssh/(id_|.*\.pem)|\bid_(rsa|ed25519|ecdsa|dsa)\b|(^|[/\s])\.env(\b|\.)|keychain)`)

type wordToken struct {
	word string
	op   bool
}

func tokenize(command string) (tokens []wordToken, dynamic, substitution bool) {
	var word strings.Builder
	mode := rune(0)
	started := false
	quoted := false
	r := []rune(command)
	push := func() {
		if started {
			tokens = append(tokens, wordToken{word.String(), false})
			word.Reset()
			started = false
			quoted = false
		}
	}
	for i := 0; i < len(r); i++ {
		c := r[i]
		if mode == '\'' {
			if c == '\'' {
				mode = 0
			} else {
				word.WriteRune(c)
			}
			continue
		}
		if c == '\\' {
			quoted = true
			i++
			if i == len(r) {
				dynamic = true
				break
			}
			if mode == '"' && !strings.ContainsRune("$`\"\\", r[i]) {
				word.WriteRune('\\')
			}
			word.WriteRune(r[i])
			started = true
			continue
		}
		if c == '\'' && mode == 0 {
			quoted = true
			mode = c
			started = true
			continue
		}
		if c == '"' {
			quoted = true
			if mode == 0 {
				mode = c
			} else {
				mode = 0
			}
			started = true
			continue
		}
		if c == '`' || (c == '$' && i+1 < len(r) && r[i+1] == '(') {
			substitution = true
		}
		if c == '$' || c == '`' || mode == 0 && strings.ContainsRune("(){}*?[]~#", c) {
			dynamic = true
		}
		if mode == 0 && (unicode.IsSpace(c) || strings.ContainsRune("|&;<>", c)) {
			fd := ""
			if (c == '>' || c == '<') && started && !quoted && regexp.MustCompile(`^\d+$`).MatchString(word.String()) {
				fd = word.String()
				word.Reset()
				started = false
			}
			push()
			if !unicode.IsSpace(c) {
				v := fd + string(c)
				if i+1 < len(r) && r[i+1] == c && c != ';' {
					v += string(c)
					i++
				}
				tokens = append(tokens, wordToken{v, true})
			}
		} else {
			word.WriteRune(c)
			started = true
		}
	}
	push()
	return tokens, dynamic || mode != 0, substitution
}
func CommandPolicy(command string) Policy {
	p := commandPolicyFlat(command)
	if p.Risk != "readonly" {
		if safe, ok := readonlyScript(command); ok {
			return Policy{Risk: "readonly", Reason: "完整命令及嵌套查询均为只读，未包含写入或危险操作。", Safe: safe}
		}
	}
	return p
}
func commandPolicyFlat(command string) Policy {
	tokens, dynamic, substitution := tokenize(command)
	groups := [][]string{{}}
	redirects := [][]string{{}}
	joins := []string{}
	unsafeRedirect, redirectDevice := false, false
	for i := 0; i < len(tokens); i++ {
		t := tokens[i]
		if t.op && set("| && || ;")[t.word] {
			joins = append(joins, t.word)
			groups = append(groups, []string{})
			redirects = append(redirects, []string{})
		} else if t.op && strings.ContainsAny(t.word, "<>") {
			if i+1 < len(tokens) && !tokens[i+1].op {
				target := tokens[i+1].word
				i++
				if rawDevice.MatchString(target) {
					redirectDevice = true
				}
				if set("> 1> 2>")[t.word] && target == "/dev/null" {
					redirects[len(redirects)-1] = append(redirects[len(redirects)-1], t.word+" "+quote(target))
				} else {
					unsafeRedirect = true
				}
			} else {
				unsafeRedirect = true
			}
		} else {
			groups[len(groups)-1] = append(groups[len(groups)-1], t.word)
		}
	}
	// Credential access and shell substitution remain protected. Device paths
	// are evaluated as input paths, not by scanning quoted grep/display text.
	dangerous := sensitive.MatchString(command) || substitution || redirectDevice
	destructive := false
	for _, g := range groups {
		if len(g) == 0 {
			continue
		}
		p := path.Base(g[0])
		if p == "awk" && dynamic {
			dangerous = true
		}
		if p == "ss" && (strings.Contains(strings.Join(g[1:], " "), "--kill") || regexp.MustCompile(`(^|\s)-[^\s-]*K`).MatchString(strings.Join(g[1:], " "))) {
			dangerous = true
		}
		deletionProgram := set("mv rm rmdir unlink srm trash trash-put trash-empty trash-rm gtrash")[p] || p == "gio" && len(g) > 1 && g[1] == "trash"
		if deletionProgram {
			destructive = true
		}
		if accessesRawDevice(p, g[1:]) {
			dangerous = true
		}
		if (p == "ifconfig" || p == "networksetup" || p == "route" || p == "ip") && !readonlyQueryProgram(p, g[1:]) {
			dangerous = true
		}
		if p == "hdiutil" && len(g) > 1 && set("attach mount detach unmount eject create erase resize burn")[g[1]] {
			dangerous = true
		}
		if dangerPrograms[p] && !deletionProgram || strings.HasPrefix(p, "mkfs.") || wrappers[p] && !((p == "awk" || p == "env") && readonlyQueryProgram(p, g[1:])) {
			dangerous = true
		}
		for _, a := range g[1:] {
			if p == "find" && a == "-delete" {
				destructive = true
			}
			if p == "find" && set("-exec -execdir -ok -okdir")[a] {
				dangerous = true
			}
			if set("systemctl service launchctl docker kubectl ip route")[p] && set("stop restart kill delete del add flush set replace change rm down bootout unload scale apply exec")[a] {
				dangerous = true
			}
		}
	}
	if dangerous || destructive {
		return Policy{Risk: "dangerous", Destructive: destructive, DestructiveOnly: destructive && !dangerous, Reason: "可能删除数据、访问凭据、影响服务或执行任意代码，按会话权限决定是否确认目标。"}
	}
	if unsafeRedirect {
		return Policy{Risk: "write", Reason: "命令包含文件重定向，需要核对读写目标。"}
	}
	for _, t := range tokens {
		if t.op && t.word == "&" {
			dynamic = true
		}
	}
	if dynamic {
		return Policy{Risk: "write", Reason: "包含动态展开、后台运行或复杂 Shell 语法，无法可靠判定为只读。"}
	}
	safeGroups := []string{}
	for i, g := range groups {
		if len(g) == 0 {
			return Policy{Risk: "write", Reason: "命令格式无法可靠判定为只读。"}
		}
		p := path.Base(g[0])
		safe := readPrograms[p] && (!strings.Contains(g[0], "/") || regexp.MustCompile(`^/(usr/)?s?bin/[^/]+$`).MatchString(g[0]))
		args := g[1:]
		safe = safe && readonlyQueryProgram(p, args)
		if p == "hdiutil" {
			safe = safe && (len(args) == 1 && args[0] == "info" || len(args) == 2 && args[0] == "info" && args[1] == "-plist")
		}
		if p == "sysctl" {
			safe = safe && readonlySysctl(args)
		}
		topBound := false
		for j, a := range args {
			if p == "date" && !readonlyDate(args) {
				safe = false
			}
			if p == "hostname" && !set("-f -s -d -i -I -a --fqdn")[a] {
				safe = false
			}
			if p == "file" && (a == "--compile" || regexp.MustCompile(`^-[^-]*C`).MatchString(a)) {
				safe = false
			}
			if p == "find" && set("-fprint -fprint0 -fprintf -fls")[a] {
				safe = false
			}
			if p == "top" {
				orderFields := set("cpu mem pid command time threads ports rsize vsize %CPU %MEM +%CPU -%CPU +%MEM -%MEM")
				orderOption := (a == "-o" || a == "-O") && j+1 < len(args) && orderFields[args[j+1]]
				orderValue := j > 0 && (args[j-1] == "-o" || args[j-1] == "-O") && orderFields[a]
				if !orderOption && !orderValue && !regexp.MustCompile(`^(-b|-l|-n|-d|-s|\d+(\.\d+)?)$`).MatchString(a) {
					safe = false
				}
				if (a == "-l" || a == "-n") && j+1 < len(args) && regexp.MustCompile(`^[1-9]\d?$`).MatchString(args[j+1]) {
					topBound = true
				}
			}
			if set("grep egrep fgrep")[p] && (strings.HasPrefix(a, "--pre=") || strings.HasPrefix(a, "--pre-glob=")) {
				safe = false
			}
		}
		if p == "top" && !topBound {
			safe = false
		}
		if p == "printf" && len(args) > 0 && args[0] == "-v" {
			safe = false
		}
		if !safe {
			return Policy{Risk: "write", Reason: "该程序或参数可能改变状态，或暂不能可靠判定为只读；请先核对影响。"}
		}
		if p == "curl" {
			// -q must be first: never inherit curlrc. Ignore proxy environment
			// and bound requests even if the caller omitted its own timeout.
			g = append([]string{g[0], "-q", "--globoff", "--noproxy", "*", "--max-time", "10", "--connect-timeout", "5"}, args...)
		}
		q := []string{}
		for _, v := range g {
			q = append(q, quote(v))
		}
		prefix := ""
		if i > 0 {
			prefix = joins[i-1] + " "
		}
		rendered := prefix + "command -p " + strings.Join(q, " ")
		if len(redirects[i]) > 0 {
			rendered += " " + strings.Join(redirects[i], " ")
		}
		safeGroups = append(safeGroups, rendered)
	}
	return Policy{Risk: "readonly", Reason: "完整命令仅包含可识别的只读检查，无写入或危险操作。", Safe: strings.Join(safeGroups, " ")}
}
func validCommand(s string) bool {
	if strings.TrimSpace(s) == "" || len([]rune(s)) > 2000 {
		return false
	}
	for _, c := range s {
		if c < 32 && c != '\t' || c == 127 {
			return false
		}
	}
	return true
}

var rawDevice = regexp.MustCompile(`^/dev/(?:r?disk|sd[a-z]|nvme)`)

func accessesRawDevice(program string, args []string) bool {
	if program == "echo" || program == "printf" {
		return false
	}
	grep := set("grep egrep fgrep")[program]
	patternSeen, positional := false, false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if grep && !positional {
			if arg == "--" {
				positional = true
				continue
			}
			if arg == "-e" || arg == "--regexp" {
				patternSeen = true
				i++
				continue
			}
			if strings.HasPrefix(arg, "--regexp=") || strings.HasPrefix(arg, "-e") && len(arg) > 2 {
				patternSeen = true
				continue
			}
			if arg == "-f" || arg == "--file" {
				patternSeen = true
				if i+1 < len(args) {
					i++
					if rawDevice.MatchString(args[i]) {
						return true
					}
				}
				continue
			}
			if strings.HasPrefix(arg, "--file=") {
				patternSeen = true
				if rawDevice.MatchString(strings.TrimPrefix(arg, "--file=")) {
					return true
				}
				continue
			}
			if strings.HasPrefix(arg, "-f") && len(arg) > 2 {
				patternSeen = true
				if rawDevice.MatchString(arg[2:]) {
					return true
				}
				continue
			}
			if set("-A -B -C -m --after-context --before-context --context --max-count")[arg] {
				i++
				continue
			}
			if strings.HasPrefix(arg, "-") && !strings.HasPrefix(arg, "--") {
				// grep accepts combined short options such as -Ef FILE and
				// -vePATTERN; -f still reads a pattern file in those forms.
				for j, flag := range arg[1:] {
					if flag == 'e' || flag == 'f' {
						value := arg[j+2:]
						if value == "" && i+1 < len(args) {
							i++
							value = args[i]
						}
						patternSeen = true
						if flag == 'f' && rawDevice.MatchString(value) {
							return true
						}
						break
					}
					if strings.ContainsRune("ABCm", flag) {
						if j+2 == len(arg) {
							i++
						}
						break
					}
				}
				continue
			}
			if strings.HasPrefix(arg, "-") {
				continue
			}
		}
		if grep && !patternSeen {
			patternSeen = true
			continue
		}
		if rawDevice.MatchString(arg) {
			return true
		}
	}
	return false
}
