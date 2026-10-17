package web

import (
	"regexp"
	"strings"
)

var titleSecrets = regexp.MustCompile(`(?i)(api[ _-]?key|private[ _-]?key|password|passwd|secret|bearer|access[ _-]?token|(?:密码|口令|密钥)\s*[=:：]|-----BEGIN|\bsk-[a-z0-9]{8,}|\[REDACTED\]|\[PRIVATE KEY REDACTED\])`)

// Derive a short topic from the first meaningful user message. This requires
// no extra model call and never modifies existing explicitly named sessions.
func sessionTitle(message string) string {
	if titleSecrets.MatchString(message) {
		return "凭据配置"
	}
	first := ""
	for _, line := range strings.Split(message, "\n") {
		line = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), "#>*- `"))
		if line != "" {
			first = line
			break
		}
	}
	first = strings.Join(strings.Fields(first), " ")
	first = strings.TrimPrefix(first, "@")
	if set("你好 您好 hi hello hey 在吗")[strings.ToLower(strings.Trim(first, "!！?？。."))] {
		return ""
	}
	if first == "请分析附加图片。" {
		return "图片分析"
	}
	if first == "" {
		return ""
	}
	runes := []rune(first)
	if len(runes) > 28 {
		first = string(runes[:28]) + "…"
	}
	return first
}

// Match complete credentials in title input, including model header values.
func (t *Terminals) titleInput(message string) string {
	message = privateKeyBlock.ReplaceAllString(message, "[PRIVATE KEY REDACTED]")
	secrets := t.authenticationSecrets()
	if model := t.models.Active(); model != nil {
		secrets = append(secrets, model.Key)
		for _, value := range model.Headers {
			secrets = append(secrets, value)
		}
	}
	for _, secret := range secrets {
		if secret != "" {
			message = strings.ReplaceAll(message, secret, "[REDACTED]")
		}
	}
	return message
}
