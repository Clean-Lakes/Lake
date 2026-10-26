package web

import (
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

func diagnosticHost(s string) bool {
	if net.ParseIP(s) != nil {
		return true
	}
	return len(s) <= 253 && regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.:%_-]*$`).MatchString(s)
}

func diagnosticInterface(s string) bool {
	return regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,31}$`).MatchString(s)
}

// Require a small finite packet count. Flooding, broadcasts, data patterns,
// preload and unbounded probes cannot become a specialist's read-only call.
func readonlyPing(args []string) bool {
	count, hosts := false, 0
	for i := 0; i < len(args); i++ {
		a := args[i]
		if set("-n -q -4 -6")[a] {
			continue
		}
		if a == "-c" || a == "-W" || a == "-w" || a == "-t" {
			i++
			if i >= len(args) {
				return false
			}
			n, err := strconv.Atoi(args[i])
			limit := 30
			if a == "-c" {
				limit = 20
				count = true
			}
			if err != nil || n < 1 || n > limit {
				return false
			}
			continue
		}
		if !diagnosticHost(a) {
			return false
		}
		hosts++
	}
	return count && hosts == 1
}

// Connectivity checks may request headers from one explicit HTTP(S) origin.
// Keep arbitrary GETs, query strings, redirects, credentials and curl output
// directives under the existing approval policy. Safe rendering supplies -q
// and deadlines, so local curlrc cannot add uploads, files or redirects.
func readonlyConnectivityHead(args []string) bool {
	head, urls := false, 0
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--head" || len(a) > 1 && strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && strings.Trim(a[1:], "sSfIq") == "" {
			head = head || a == "--head" || strings.Contains(a, "I")
			continue
		}
		if set("--silent --show-error --fail -q --disable")[a] {
			continue
		}
		if set("-m --max-time --connect-timeout --url")[a] {
			i++
			if i >= len(args) {
				return false
			}
			if a != "--url" {
				n, err := strconv.ParseFloat(args[i], 64)
				if err != nil || !(n > 0 && n <= 30) {
					return false
				}
				continue
			}
			a = args[i]
		}
		u, err := url.Parse(a)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Hostname() == "" || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawPath != "" || (u.Path != "" && u.Path != "/") {
			return false
		}
		if port := u.Port(); port != "" {
			n, err := strconv.Atoi(port)
			if err != nil || n < 1 || n > 65535 {
				return false
			}
		}
		urls++
	}
	return head && urls == 1
}
