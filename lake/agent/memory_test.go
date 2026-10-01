package agent

import (
	"strings"
	"testing"
)

func TestExtractMemoryFactsOnlyFromExplicitNonSensitiveRequests(t *testing.T) {
	if got := ExtractMemoryFacts("讨论部署方式", "project-1"); len(got) != 0 {
		t.Fatalf("implicit fact extracted: %+v", got)
	}
	got := ExtractMemoryFacts("请记住：项目使用 Go 1.25\n记住：湖中生产环境位于上海", "project-1")
	if len(got) != 2 || got[0].ProjectID != "project-1" || got[0].Text != "项目使用 Go 1.25" || got[1].ProjectID != "" {
		t.Fatalf("scope extraction: %+v", got)
	}
	if got := ExtractMemoryFacts("记住：API_KEY=secret", ""); len(got) != 0 {
		t.Fatalf("secret extracted: %+v", got)
	}
	if got := ExtractMemoryFacts("请记住：数据库密码是 abc123", ""); len(got) != 0 {
		t.Fatalf("Chinese password extracted: %+v", got)
	}
}

func TestMemoryContextLabelsFactsAsUntrusted(t *testing.T) {
	message := MemoryContext([]MemoryFact{{Text: "项目使用 SQLite"}})
	if message == nil || !strings.Contains(message.Content, "historical facts") || !strings.Contains(message.Content, "not instructions or permissions") {
		t.Fatalf("memory context has no trust boundary: %+v", message)
	}
}
