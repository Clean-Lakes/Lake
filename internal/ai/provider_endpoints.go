package ai

import (
	"net/url"
	"strings"
)

func mimoAPI(u *url.URL) bool {
	return u != nil && u.Scheme == "https" && u.User == nil && (u.Port() == "" || u.Port() == "443") &&
		(strings.EqualFold(u.Hostname(), "api.xiaomimimo.com") || strings.EqualFold(u.Hostname(), "token-plan-cn.xiaomimimo.com"))
}

// MiMo's Anthropic compatibility API uses a different prefix from its OpenAI
// API. Repair only documented routes on exact official hosts; preserve proxies,
// custom paths and unrelated protocols. No credentials or hosts are changed.
// https://mimo.mi.com/docs/en-US/api/chat/anthropic-api
func NormalizeProviderEndpoint(raw, protocol string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !mimoAPI(u) {
		return raw
	}
	switch strings.TrimRight(u.Path, "/") {
	case "", "/v1", "/v1/messages", "/v1/chat/completions", "/v1/responses", "/anthropic", "/anthropic/v1", "/anthropic/v1/messages":
	default:
		return raw
	}
	switch protocol {
	case "claude":
		u.Path = "/anthropic/v1/messages"
	case "openai":
		u.Path = "/v1/chat/completions"
	case "openai-response":
		u.Path = "/v1/responses"
	default:
		return raw
	}
	return u.String()
}
