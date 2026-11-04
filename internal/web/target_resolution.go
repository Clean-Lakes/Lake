package web

import (
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// TargetInput is constructed by the host from the actual submitted message and
// project-visible asset catalog. It never carries an authorization boundary.
type TargetInput struct {
	ProjectID, SessionID, SourceMessageID, UserText string
	SelectionSubmitted                              bool
	SelectedResourceIDs                             []string
	NavigationSubmitted                             bool
	NavigationCandidateIDs                          []string
	ExplicitSwitch                                  bool
	SupportsResourceSet                             bool
	CurrentResourceIDs                              []string
	PendingSwitch                                   bool
	Assets                                          []ai.Asset
}

type TargetResolution struct {
	Status, Reason, Source, SourceMessageID string
	ResourceIDs                             []string
	Candidates                              []string
}

func sortedTargetIDs(ids []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, id := range ids {
		if id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

// ResolveTarget matches actual connection endpoints, not display names or an
// IP-derived asset identity. Same endpoint with two accounts remains ambiguous.
// A pending or failed explicit switch never falls back to the old target.
func ResolveTarget(in TargetInput) TargetResolution {
	out := TargetResolution{Status: "unresolved", Reason: "TARGET_REQUIRED", SourceMessageID: in.SourceMessageID}
	if in.ProjectID == "" || in.SessionID == "" || in.SourceMessageID == "" {
		return out
	}
	available := map[string]ai.Asset{}
	for _, asset := range in.Assets {
		if asset.ID == "" {
			continue
		}
		if _, duplicate := available[asset.ID]; duplicate {
			return out
		}
		available[asset.ID] = asset
	}
	resolveIDs := func(ids []string, source string, emptyReason string) TargetResolution {
		ids = sortedTargetIDs(ids)
		if len(ids) == 0 {
			out.Reason = emptyReason
			return out
		}
		for _, id := range ids {
			if _, ok := available[id]; !ok {
				out.Reason = "TARGET_UNAVAILABLE"
				return out
			}
		}
		out.Source = source
		if len(ids) > 1 && !in.SupportsResourceSet {
			out.Status, out.Reason, out.Candidates = "ambiguous", "TARGET_AMBIGUOUS", ids
			return out
		}
		out.Status, out.Reason, out.ResourceIDs = "resolved", "", ids
		return out
	}
	if in.SelectionSubmitted {
		return resolveIDs(in.SelectedResourceIDs, "explicit_selection", "TARGET_REQUIRED")
	}
	// Explicit user addresses take precedence over directory navigation. Only
	// direct, non-negated message mentions qualify via the existing parser.
	var addressMatches []string
	matchedHosts := map[string][]string{}
	message := unquotedTargetText(in.UserText)
	for _, asset := range in.Assets {
		for _, endpoint := range assetConnectionAddresses(asset) {
			if ai.ResourceAddressMentioned(message, endpoint.Address) {
				addressMatches = append(addressMatches, asset.ID)
				matchedHosts[endpoint.Host] = append(matchedHosts[endpoint.Host], asset.ID)
			}
		}
	}
	for _, ids := range matchedHosts {
		if len(sortedTargetIDs(ids)) > 1 {
			out.Status, out.Reason, out.Source, out.Candidates = "ambiguous", "TARGET_AMBIGUOUS", "user_address", sortedTargetIDs(addressMatches)
			return out
		}
	}
	if len(addressMatches) > 0 {
		return resolveIDs(addressMatches, "user_address", "TARGET_REQUIRED")
	}
	if in.NavigationSubmitted {
		return resolveIDs(in.NavigationCandidateIDs, "navigation", "TARGET_EMPTY_DIRECTORY")
	}
	if in.ExplicitSwitch || in.PendingSwitch {
		return out
	}
	return resolveIDs(in.CurrentResourceIDs, "inherited", "TARGET_REQUIRED")
}

type targetConnectionAddress struct{ Address, Host string }

func assetConnectionAddresses(asset ai.Asset) []targetConnectionAddress {
	var addresses []targetConnectionAddress
	seen := map[string]bool{}
	appendAddress := func(address, host string) {
		if address != "" && !seen[address] {
			seen[address] = true
			addresses = append(addresses, targetConnectionAddress{address, host})
		}
	}
	add := func(raw string) {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			return
		}
		if parsed, err := url.Parse(raw); err == nil && parsed.Hostname() != "" {
			host := strings.Trim(strings.ToLower(parsed.Hostname()), "[]")
			appendAddress(strings.ToLower(parsed.Scheme)+"://"+strings.ToLower(parsed.Host), host)
			appendAddress(strings.ToLower(parsed.Host), host)
			raw = host
		} else if host, _, err := net.SplitHostPort(raw); err == nil {
			appendAddress(strings.ToLower(raw), strings.Trim(strings.ToLower(host), "[]"))
			raw = host
		}
		raw = strings.Trim(strings.ToLower(raw), "[]")
		if raw != "" {
			appendAddress(raw, raw)
		}
	}
	if asset.SSH != nil {
		add(asset.SSH.Host)
		port := asset.SSH.Port
		if port == 0 {
			port = 22
		}
		add("ssh://" + net.JoinHostPort(asset.SSH.Host, strconv.Itoa(port)))
	}
	// Fixed non-secret endpoint fields only. Never scan arbitrary config values,
	// names, passwords, command strings or model-provided connection aliases.
	for _, key := range []string{"host", "hostname", "server", "apiServer", "endpoint", "url"} {
		if value, ok := asset.Settings[key].(string); ok {
			add(value)
		}
	}
	return addresses
}

func unquotedTargetText(message string) string {
	pairs := map[rune]rune{'"': '"', '\'': '\'', '`': '`', '“': '”', '‘': '’', '「': '」', '『': '』'}
	closing := rune(0)
	var out strings.Builder
	for _, r := range message {
		if closing != 0 {
			if r == closing {
				closing = 0
			}
			out.WriteRune(' ')
			continue
		}
		if end, ok := pairs[r]; ok {
			closing = end
			out.WriteRune(' ')
			continue
		}
		out.WriteRune(r)
	}
	return out.String()
}
