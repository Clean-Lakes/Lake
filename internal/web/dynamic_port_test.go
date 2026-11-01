package web

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDesktopDynamicPortUsesBoundAddress(t *testing.T) {
	home := t.TempDir()
	b, err := New(context.Background(), Options{Home: home, DynamicPort: true, Token: "synthetic-desktop-token"})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- b.Start() }()
	defer func() { b.Close(); <-done }()
	var info struct{ Origin, Token string }
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(filepath.Join(home, "web-agent", "runtime.json"))
		if err == nil && json.Unmarshal(data, &info) == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if info.Origin == "" || info.Origin == "http://localhost:0" {
		t.Fatal("bound port missing")
	}
	req, _ := http.NewRequest("GET", info.Origin+"/api/bootstrap", nil)
	req.Header.Set("Authorization", "Bearer "+info.Token)
	res, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("bound origin rejected: %d", res.StatusCode)
	}
	if err = b.Start(); err == nil {
		t.Fatal("second Start created another listener or worker set")
	}
}

func TestServerClosedBeforeStartCannotPublishRuntime(t *testing.T) {
	home := t.TempDir()
	b, err := New(context.Background(), Options{Home: home, DynamicPort: true, Token: "synthetic-closed-token"})
	if err != nil {
		t.Fatal(err)
	}
	b.Close()
	if err = b.Start(); err != context.Canceled {
		t.Fatal("closed server restarted", err)
	}
	if _, err = os.Stat(filepath.Join(home, "web-agent", "runtime.json")); !os.IsNotExist(err) {
		t.Fatal("closed owner published a runtime record")
	}
}
