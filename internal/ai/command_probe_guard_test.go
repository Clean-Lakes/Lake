package ai

import (
	"context"
	"testing"
	"time"
)

// Classification only: none of these commands are ever executed by the test.
func TestBoundedTCPProbeDoesNotRequireDestructiveConfirmation(t *testing.T) {
	command := `echo "=== MYCNF ==="; docker exec fixture-db sh -c 'grep -Ev "^#|^$" /etc/mysql/my.cnf' 2>&1 | head -30; echo "=== MYSQL VERSIZE ==="; du -sh /srv/fixture/mysql/data /srv/fixture/postgresql/data 2>&1; echo "=== CONN ==="; for h in 192.0.2.75 192.0.2.78 192.0.2.79 nfs.example.invalid registry.example.invalid; do timeout 3 bash -c "cat < /dev/null > /dev/tcp/$h/22 2>/dev/null" && echo "$h:22 OK" || echo "$h:22 FAIL"; done; timeout 3 bash -c "cat < /dev/null > /dev/tcp/192.0.2.79/2049" 2>/dev/null && echo "nfs2049 OK" || echo "nfs2049 no"`
	if CatastrophicCommand(command) {
		t.Fatal("bounded connectivity checks were treated as broad deletion/disk erasure")
	}
	p := DefaultPermissions()
	p.SilentCommands = true
	kind, err := approvalKind(Config{Permissions: &p}, "shell", "dangerous", map[string]any{"catastrophic": CatastrophicCommand(command)})
	if err != nil || kind != "" {
		t.Fatalf("granted command preference ignored: %q %v", kind, err)
	}
	p.SilentCommands = false
	if kind, err := approvalKind(Config{Permissions: &p}, "shell", "dangerous", nil); err != nil || kind == "" {
		t.Fatal("probe recognition must not grant command permission", kind, err)
	}
}

func TestBoundedTCPProbeCannotHideUnknownOrDestructiveScripts(t *testing.T) {
	probe := `timeout 3 bash -c "cat < /dev/null > /dev/tcp/$h/22 2>/dev/null"`
	for name, command := range map[string]string{
		"unknown host values":        `for h in $HOSTS; do ` + probe + `; done`,
		"implicit positional values": `for h; do ` + probe + `; done`,
		"malicious literal host":     `for h in 'example.invalid; rm -rf /'; do ` + probe + `; done`,
		"assignment changes host":    `for h in example.invalid; do h="$INPUT"; ` + probe + `; done`,
		"builtin changes host":       `for h in example.invalid; do read h; ` + probe + `; done`,
		"arithmetic changes host":    `for h in example.invalid; do echo "$((h=1))"; ` + probe + `; done`,
		"command substitution":       `for h in example.invalid; do echo "$(rm -rf /)"; ` + probe + `; done`,
		"indirect expansion":         `for h in example.invalid; do timeout 3 bash -c "cat < /dev/null > /dev/tcp/${!h}/22"; done`,
		"parameter default":          `for h in example.invalid; do timeout 3 bash -c "cat < /dev/null > /dev/tcp/${h:-$INPUT}/22"; done`,
		"extra nested code":          `for h in example.invalid; do timeout 3 bash -c "cat < /dev/null > /dev/tcp/$h/22; rm -rf /"; done`,
		"write raw device":           `for h in example.invalid; do timeout 3 bash -c "cat < /dev/null > /dev/tcp/$h/22; printf x >/dev/sda"; done`,
		"binding cannot escape loop": `for h in example.invalid; do ` + probe + `; done; bash -c "$h"`,
		"unrelated deletion":         `for h in example.invalid; do ` + probe + `; done; rm -rf /`,
		"unbounded timeout":          `for h in example.invalid; do timeout NaN bash -c "cat < /dev/null > /dev/tcp/$h/22"; done`,
	} {
		t.Run(name, func(t *testing.T) {
			if !CatastrophicCommand(command) {
				t.Fatal("unproven script bypassed confirmation")
			}
		})
	}
}

func TestBoundedTCPProbeRespectsGrantedPermissionThroughDispatch(t *testing.T) {
	calls := 0
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, func(_ context.Context, _ string, name string, _ map[string]any, approved bool) (any, error) {
		if name == "policy" {
			return map[string]any{"risk": "dangerous", "target": "fixture host", "runtime": "local"}, nil
		}
		if name != "runtimeCommandExec" || !approved {
			t.Fatalf("unexpected dispatch %s, approved=%t", name, approved)
		}
		calls++
		// This bridge is a no-op: no shell, Docker or network probe is run.
		return map[string]any{"exitCode": 0, "output": "fixture only"}, nil
	})
	s, _ := e.get("case")
	c := s.state.Config
	p := DefaultPermissions()
	p.SilentCommands = true
	c.Permissions = &p
	command := `for h in 192.0.2.10 example.invalid; do timeout 3 bash -c "cat < /dev/null > /dev/tcp/$h/22 2>/dev/null" && echo "$h OK" || echo "$h FAIL"; done`
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := e.invoke(ctx, s, c, Call{ID: "probe-fixture", Name: "shell", Arguments: js(map[string]any{"command": command})}); err != nil {
		t.Fatal(err)
	}
	view, _ := e.Snapshot("case")
	if calls != 1 || view.Pending != nil {
		t.Fatal("granted probe still requested approval", calls)
	}
}
