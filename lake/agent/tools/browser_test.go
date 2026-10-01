package tools

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBrowserSessionsStayBoundedAndDoNotShareCookies(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("Cookie") != "" {
			t.Error("browser reused a cookie")
		}
		w.Header().Set("Set-Cookie", "session=secret")
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<h1>External page</h1>"))
	}))
	defer server.Close()
	fetcher, err := NewWebFetcher([]string{"127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	browser, err := NewBrowserAdapter(fetcher)
	if err != nil {
		t.Fatal(err)
	}
	first, err := browser.Open(context.Background(), server.URL)
	if err != nil || !first.Untrusted || !strings.Contains(first.Page.Text, "External page") {
		t.Fatalf("view=%+v err=%v", first, err)
	}
	second, err := browser.Open(context.Background(), server.URL)
	if err != nil || second.ID == first.ID {
		t.Fatalf("second=%+v err=%v", second, err)
	}
	if _, err := browser.Navigate(context.Background(), first.ID, server.URL); err != nil {
		t.Fatal(err)
	}
	if requests != 3 {
		t.Fatalf("requests=%d", requests)
	}
	if err := browser.Close(first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := browser.Snapshot(first.ID); err == nil {
		t.Fatal("closed browser snapshot available")
	}
	if _, err := browser.Open(context.Background(), "https://not-allowed.example/"); err == nil {
		t.Fatal("unlisted domain opened")
	}
}
