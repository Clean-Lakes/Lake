package web

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func strategyHTTP(t *testing.T, h *httptest.Server, method, path, key, raw string, status int) Object {
	t.Helper()
	req, err := http.NewRequest(method, h.URL+path, strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "localhost:4177"
	req.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
	req.Header.Set("Idempotency-Key", key)
	req.Header.Set("Content-Type", "application/json")
	res, err := h.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode != status {
		t.Fatalf("%s %s: %d %s", method, path, res.StatusCode, data)
	}
	out := Object{}
	_ = json.Unmarshal(data, &out)
	return out
}
func strategyAssetJSON(body string) string {
	return jsonText(Object{"expectedRevision": 0, "title": "Report preference", "kind": "user_preference", "body": body, "applicability": Object{"profiles": []string{}, "resourceKinds": []string{}, "domainTags": []string{}}})
}
