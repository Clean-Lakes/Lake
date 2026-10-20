package web

import (
	"net"
	"net/url"
	"strconv"
	"strings"
)

// GET alone does not establish that an arbitrary URL is read-only. Only a
// single explicit loopback health endpoint without redirects or uploads qualifies.
func readonlyHealthCurl(args []string) bool {
	urls := 0
	for i := 0; i < len(args); i++ {
		a := args[i]
		if set("-q --disable --silent --show-error --fail --head")[a] || len(a) > 1 && strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && strings.Trim(a[1:], "sSfIq") == "" {
			continue
		}
		if set("-m --max-time --connect-timeout -X --request --url")[a] {
			i++
			if i >= len(args) {
				return false
			}
			value := args[i]
			if a == "-X" || a == "--request" {
				if value != "GET" && value != "HEAD" {
					return false
				}
				continue
			}
			if a != "--url" {
				n, err := strconv.ParseFloat(value, 64)
				if err != nil || !(n > 0 && n <= 30) {
					return false
				}
				continue
			}
			a = value
		} else if strings.HasPrefix(a, "-") {
			return false
		}
		u, err := url.Parse(a)
		if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || u.RawPath != "" {
			return false
		}
		if host := u.Hostname(); host != "localhost" && !net.ParseIP(host).IsLoopback() {
			return false
		}
		if port := u.Port(); port != "" {
			n, err := strconv.Atoi(port)
			if err != nil || n < 1 || n > 65535 {
				return false
			}
		}
		if !set("/health /healthz /readyz /livez /api/health")[u.Path] {
			return false
		}
		urls++
	}
	return urls == 1
}
