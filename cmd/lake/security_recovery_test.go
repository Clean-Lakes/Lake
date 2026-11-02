package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSecurityRecoveryCLIRequiresExplicitHome(t *testing.T) {
	if err := run(context.Background(), []string{"security", "resume-initial-migration"}); err == nil || !strings.Contains(err.Error(), "explicit --home") {
		t.Fatal("recovery accepted a default Home", err)
	}
}

func TestSecurityRiskCLIValidatesInputs(t *testing.T) {
	for _, args := range [][]string{
		{"security", "risks"},
		{"security", "risks", "--home", t.TempDir(), "unexpected"},
		{"security", "risks", "--home", t.TempDir(), "--limit", "0"},
		{"security", "risks", "--home", t.TempDir(), "--limit", "1001"},
	} {
		if err := run(context.Background(), args); err == nil {
			t.Fatal("invalid risk inspection accepted")
		}
	}
	h, err := ai.OpenSecurityHome(context.Background(), t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	home := h.Home
	h.Close()
	if err = run(context.Background(), []string{"security", "risks", "--home", home, "--limit", "1"}); err != nil {
		t.Fatal(err)
	}
}

func TestSecurityStatusCLIStillWorks(t *testing.T) {
	h, err := ai.OpenSecurityHome(context.Background(), t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	home := h.Home
	h.Close()
	if err = run(context.Background(), []string{"security", "status", "--home", home}); err != nil {
		t.Fatal(err)
	}
	if err = run(context.Background(), []string{"security", "resume-initial-migration", "--home", filepath.Join(t.TempDir(), "missing")}); err == nil {
		t.Fatal("missing control accepted for recovery")
	}
}
