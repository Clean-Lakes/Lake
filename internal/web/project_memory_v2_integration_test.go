package web

import (
	"context"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func memoryV2ServerFixture(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	b, err := New(context.Background(), Options{Home: t.TempDir(), Token: "synthetic-test-auth-token", memoryV2ForTest: true, Static: fstest.MapFS{"index.html": {Data: []byte("memory fixture")}}})
	if err != nil {
		t.Fatal(err)
	}
	h := httptest.NewServer(b)
	t.Cleanup(func() { h.Close(); b.Close() })
	return b, h
}
