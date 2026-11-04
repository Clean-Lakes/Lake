package web

import (
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSecurityTargetResolverConnectionIdentityAndPendingSwitch(t *testing.T) {
	assets := []ai.Asset{{ID: "old", Name: "192.0.2.9", SSH: &ai.SSH{Host: "192.0.2.1", Username: "one"}}, {ID: "new", Name: "friendly-name", SSH: &ai.SSH{Host: "192.0.2.9", Username: "two"}}}
	in := TargetInput{ProjectID: "project", SessionID: "session", SourceMessageID: "message", UserText: "检查 192.0.2.9", CurrentResourceIDs: []string{"old"}, Assets: assets}
	got := ResolveTarget(in)
	if got.Status != "resolved" || len(got.ResourceIDs) != 1 || got.ResourceIDs[0] != "new" {
		t.Fatal("display name substituted for actual connection", got)
	}
	in.UserText = "切到一个未能解析的新目标"
	in.ExplicitSwitch = true
	if got = ResolveTarget(in); got.Status != "unresolved" || len(got.ResourceIDs) != 0 {
		t.Fatal("failed switch fell back to old target", got)
	}
	in.ExplicitSwitch = false
	in.PendingSwitch = true
	in.UserText = "继续"
	if got = ResolveTarget(in); got.Status != "unresolved" {
		t.Fatal("pending switch inherited old target", got)
	}
	in.PendingSwitch = false
	if got = ResolveTarget(in); got.Status != "resolved" || got.ResourceIDs[0] != "old" {
		t.Fatal("ordinary continuation lost current target", got)
	}
}

func TestSecurityTargetResolverNavigationIsNotBoundary(t *testing.T) {
	in := TargetInput{ProjectID: "project", SessionID: "session", SourceMessageID: "message", NavigationSubmitted: true, Assets: []ai.Asset{{ID: "outside-old-directory", SSH: &ai.SSH{Host: "192.0.2.9"}}}}
	if got := ResolveTarget(in); got.Reason != "TARGET_EMPTY_DIRECTORY" {
		t.Fatal(got)
	}
	in.UserText = "检查 192.0.2.9"
	if got := ResolveTarget(in); got.Status != "resolved" || got.ResourceIDs[0] != "outside-old-directory" {
		t.Fatal("empty directory fossilized into an execution restriction", got)
	}
	in.UserText = "继续"
	in.SelectionSubmitted = true
	in.SelectedResourceIDs = []string{"outside-old-directory"}
	if got := ResolveTarget(in); got.Status != "resolved" || got.Source != "explicit_selection" {
		t.Fatal(got)
	}
}

func TestSecurityTargetResolverDuplicateEndpointQuotesAndNegation(t *testing.T) {
	in := TargetInput{ProjectID: "project", SessionID: "session", SourceMessageID: "message", UserText: "检查 192.0.2.9", SupportsResourceSet: true, Assets: []ai.Asset{{ID: "one", SSH: &ai.SSH{Host: "192.0.2.9", Username: "one"}}, {ID: "two", SSH: &ai.SSH{Host: "192.0.2.9", Username: "two"}}}}
	if got := ResolveTarget(in); got.Status != "ambiguous" || len(got.Candidates) != 2 {
		t.Fatal("same endpoint accounts silently merged into a set", got)
	}
	in.Assets = in.Assets[:1]
	for _, text := range []string{"不要检查 192.0.2.9", `日志中写着 "192.0.2.9"`, "输出 `192.0.2.9` 只是示例"} {
		in.UserText = text
		if got := ResolveTarget(in); got.Status == "resolved" {
			t.Fatal("negated/quoted address selected a target", text, got)
		}
	}
	in.UserText = "检查 https://api.example.test:6443"
	in.Assets = []ai.Asset{{ID: "cluster", Settings: map[string]any{"apiServer": "https://api.example.test:6443"}}}
	if got := ResolveTarget(in); got.Status != "resolved" || got.ResourceIDs[0] != "cluster" {
		t.Fatal("real URL endpoint not matched", got)
	}
}
