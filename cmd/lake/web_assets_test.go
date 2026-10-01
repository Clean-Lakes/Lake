package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWebPageHandlerKeepsAPISeparate(t *testing.T) {
	handler := webPageHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "protected", http.StatusUnauthorized)
	}))
	page := httptest.NewRecorder()
	handler.ServeHTTP(page, httptest.NewRequest("GET", "/", nil))
	if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), "Lake Web") {
		t.Fatalf("page status=%d", page.Code)
	}
	api := httptest.NewRecorder()
	handler.ServeHTTP(api, httptest.NewRequest("GET", "/api/v1/conversations", nil))
	if api.Code != http.StatusUnauthorized {
		t.Fatalf("api status=%d", api.Code)
	}
	write := httptest.NewRecorder()
	handler.ServeHTTP(write, httptest.NewRequest("POST", "/", nil))
	if write.Code != http.StatusMethodNotAllowed {
		t.Fatalf("write status=%d", write.Code)
	}
}
