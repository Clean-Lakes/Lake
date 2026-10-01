package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cloudwego/eino/components/tool"
)

func TestOptionalWebAndPDFToolVisibility(t *testing.T) {
	ctx := context.Background()
	tools, err := newWebAndDocumentTools(ctx, lakeModelConfig{}, "", "lake", nil)
	if err != nil || len(tools) != 0 {
		t.Fatalf("unconfigured tools=%d err=%v", len(tools), err)
	}
	tools, err = newWebAndDocumentTools(ctx, lakeModelConfig{WebSearchEndpoint: "http://127.0.0.1:9999", WebAllowedDomains: []string{"example.com"}}, t.TempDir(), "lake", nil)
	if err != nil || len(tools) != 7 {
		t.Fatalf("configured tools=%d err=%v", len(tools), err)
	}
	names := map[string]bool{}
	for _, item := range tools {
		info, err := item.Info(ctx)
		if err != nil {
			t.Fatal(err)
		}
		names[info.Name] = true
	}
	for _, name := range []string{"lake_web_search", "lake_web_fetch", "lake_browser_open", "lake_browser_navigate", "lake_browser_snapshot", "lake_browser_close", "lake_pdf_read"} {
		if !names[name] {
			t.Fatalf("missing %s", name)
		}
	}
}

func TestWebSearchNeedsApprovalBeforeRequest(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = io.WriteString(w, `{"results":[]}`)
	}))
	defer server.Close()
	approved := false
	tools, err := newWebAndDocumentTools(context.Background(), lakeModelConfig{WebSearchEndpoint: server.URL}, "", "lake", func(kind, path, detail string) (bool, error) { return approved, nil })
	if err != nil || len(tools) != 1 {
		t.Fatalf("tools=%d err=%v", len(tools), err)
	}
	search := tools[0].(tool.InvokableTool)
	if _, err := search.InvokableRun(context.Background(), `{"query":"Lake"}`); err != nil {
		t.Fatal(err)
	}
	if requests != 0 {
		t.Fatal("denied query reached search service")
	}
	approved = true
	if _, err := search.InvokableRun(context.Background(), `{"query":"Lake"}`); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("approved requests=%d", requests)
	}
}
