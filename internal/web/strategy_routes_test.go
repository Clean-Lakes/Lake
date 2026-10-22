package web

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/strategy"
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
func TestStrategyHTTPScopeCASAndStrictSchema(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	base := "/api/projects/" + project + "/strategy"
	defaults := strategyHTTP(t, h, "GET", base+"/settings", "", "", 200)
	if object(defaults["settings"])["masterEnabled"] != false || defaults["source"] != "inherited" {
		t.Fatal(defaults)
	}
	strategyHTTP(t, h, "POST", base+"/assets", "", strategyAssetJSON("Use concise reports."), 400)
	created := strategyHTTP(t, h, "POST", base+"/assets", "new", strategyAssetJSON("Use concise reports."), 200)
	asset := stringOf(created["assetId"])
	again := strategyHTTP(t, h, "POST", base+"/assets", "new", strategyAssetJSON("Use concise reports."), 200)
	if again["assetId"] != created["assetId"] {
		t.Fatal("replay created another identity")
	}
	strategyHTTP(t, h, "POST", base+"/assets", "new", strategyAssetJSON("Different."), 409)
	v := strategyHTTP(t, h, "GET", base+"/assets/"+asset+"/revisions/1", "", "", 200)
	strategyHTTP(t, h, "GET", "/api/strategy/assets/"+asset+"/revisions/1", "", "", 404)
	p2 := b.Store.CreateProject("other")
	strategyHTTP(t, h, "GET", "/api/projects/"+stringOf(p2["id"])+"/strategy/assets/"+asset+"/lineage", "", "", 404)
	strategyHTTP(t, h, "GET", base+"/assets?limit=999", "", "", 400)
	strategyHTTP(t, h, "POST", base+"/proposals", "missing-fields", "{}", 400)
	for _, raw := range []string{
		strings.Replace(strategyAssetJSON("x"), `"expectedRevision":0`, `"expectedRevision":0,"actor":"model"`, 1),
		strings.Replace(strategyAssetJSON("x"), `"expectedRevision":0`, `"expectedRevision":0,"expectedRevision":0`, 1),
		strings.Replace(strategyAssetJSON("x"), `"profiles":[]`, `"Profiles":[]`, 1),
		strings.Replace(strategyAssetJSON("x"), `"body":"x"`, `"body":null`, 1),
		strategyAssetJSON("x") + " {}",
		strings.Replace(strategyAssetJSON("x"), `"expectedRevision":0`, `"ExpectedRevision":0`, 1),
	} {
		strategyHTTP(t, h, "POST", base+"/assets", ident(), raw, 400)
	}
	bind := Object{"action": "adopt", "ref": object(v["value"])["ref"], "expectedRevision": 0, "priority": 4, "exclusionGroup": ""}
	strategyHTTP(t, h, "POST", base+"/assets/"+asset+"/bindings", "adopt", jsonText(bind), 200)
	strategyHTTP(t, h, "POST", base+"/assets/"+asset+"/bindings", "cas-conflict", jsonText(bind), 409)
	strategyHTTP(t, h, "DELETE", base+"/assets/"+asset, "delete", `{"expectedRevision":1}`, 200)
	tombstone := strategyHTTP(t, h, "GET", base+"/assets/"+asset+"/revisions/1", "", "", 200)
	if tombstone["available"] != false || object(tombstone["value"])["body"] != "" {
		t.Fatal(tombstone)
	}
}
func TestStrategyRuntimePrecedenceAndRevocation(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	enableStrategyFixture(t, s)
	global := strategy.Scope{Kind: strategy.UserScope}
	input := strategyInput("Global preference.")
	input.Applicability = strategy.Applicability{}
	first, err := s.CreateStrategyAsset(ctx, global, "global", input)
	if err != nil {
		t.Fatal(err)
	}
	v, _ := s.GetStrategyRevision(ctx, first.AssetID, 1)
	_, err = s.BindStrategyAsset(ctx, global, "adopt", StrategyBindingInput{Action: "adopt", Ref: v.Value.Ref})
	if err != nil {
		t.Fatal(err)
	}
	q := strategy.SelectionQuery{Profile: "core"}
	selected, err := s.resolveStrategyBindings(ctx, q, nil, nil)
	if err != nil || len(selected.Assets) != 1 {
		t.Fatal(selected, err)
	}
	_, err = s.BindStrategyAsset(ctx, scope, "project-disable", StrategyBindingInput{Action: "adopt", Ref: v.Value.Ref})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.BindStrategyAsset(ctx, scope, "disable", StrategyBindingInput{Action: "disable", Ref: v.Value.Ref, ExpectedRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.resolveStrategyBindings(ctx, q, &selected.Selection, nil)
	strategyCheckError(t, err, 409)
	selected, err = s.resolveStrategyBindings(ctx, q, nil, nil)
	if err != nil || len(selected.Assets) != 0 || selected.Selection.Omitted[0].Reason != "disabled" {
		t.Fatal(selected, err)
	}
	// Another project's override cannot affect this project's selected global binding.
	other := StrategyContext{ProjectID: stringOf(s.CreateProject("other")["id"])}
	selected, err = s.resolveStrategyBindings(other, q, nil, nil)
	if err != nil || len(selected.Assets) != 1 {
		t.Fatal(selected, err)
	}
	_, err = s.ForgetStrategySource(ctx, first.SourceID, "forget", true)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.resolveStrategyBindings(other, q, &selected.Selection, nil)
	strategyCheckError(t, err, 409)
	selected, err = s.resolveStrategyBindings(other, q, nil, nil)
	if err != nil || len(selected.Assets) != 0 || selected.Selection.Omitted[0].Reason != "source_unavailable" {
		t.Fatal(selected, err)
	}
}
func TestStrategySkillImportPermissionsAndSourceChanges(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	base := "/api/projects/" + project + "/strategy"
	const body = "---\nname: fixture\ndescription: reports\n---\nUse fresh observations.\n"
	if err := b.Extensions.Store.SaveSkill("fixture", body, true); err != nil {
		t.Fatal(err)
	}
	imported := strategyHTTP(t, h, "POST", base+"/imports/skill", "import", `{"expectedRevision":0,"name":"fixture","kind":"domain_procedure","applicability":{"profiles":[],"resourceKinds":[],"domainTags":[]}}`, 200)
	asset := stringOf(imported["assetId"])
	ctx := StrategyContext{ProjectID: project}
	scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: project}
	enableStrategyFixture(t, b.Store)
	v, _ := b.Store.GetStrategyRevision(ctx, asset, 1)
	_, err := b.Store.BindStrategyAsset(ctx, scope, "adopt", StrategyBindingInput{Action: "adopt", Ref: v.Value.Ref})
	if err != nil {
		t.Fatal(err)
	}
	result, err := b.strategyProvider(context.Background(), id, strategy.SelectionQuery{Profile: "core"}, nil)
	if err != nil || len(result.Assets) != 0 || result.Selection.Omitted[0].Reason != "skill_read_permission_required" {
		t.Fatal(result, err)
	}
	q := strategy.SelectionQuery{Profile: "core", SkillReadAllowed: true}
	result, err = b.strategyProvider(context.Background(), id, q, nil)
	if err != nil || len(result.Assets) != 1 || result.Assets[0].Body != body {
		t.Fatal(result, err)
	}
	if err = b.Extensions.Store.SaveSkill("fixture", body+"Changed source.\n", false); err != nil {
		t.Fatal(err)
	}
	_, err = b.strategyProvider(context.Background(), id, q, &result.Selection)
	strategyCheckError(t, err, 409)
	result, err = b.strategyProvider(context.Background(), id, q, nil)
	if err != nil || len(result.Assets) != 0 || result.Selection.Omitted[0].Reason != "skill_source_changed" {
		t.Fatal(result, err)
	}
	_, err = b.Store.ReviseStrategyAsset(ctx, asset, "revise", 1, 1, StrategyAssetInput{Title: "revised", Kind: strategy.DomainProcedure, Body: "User authored replacement.", Applicability: strategy.Applicability{}})
	if err != nil {
		t.Fatal(err)
	}
}

func TestStrategyHTTPSettingsSecretsAndSameOrigin(t *testing.T) {
	_, h := fixture(t)
	// A configured, inactive provider key must not enter an asset either.
	apiTest(t, h, "POST", "/api/settings/providers", providerFixture("one", "http://localhost:12345/v1", "synthetic-inactive-strategy-key"), 201)
	apiTest(t, h, "POST", "/api/settings/providers", providerFixture("two", "http://localhost:12346/v1", "synthetic-active-strategy-key"), 201)
	strategyHTTP(t, h, "POST", "/api/strategy/assets", "secret", strategyAssetJSON("Do something synthetic-inactive-strategy-key"), 400)
	settings := Object{"expectedRevision": 0, "masterEnabled": true, "applyEnabled": true, "learnEnabled": false, "correctEnabled": false, "budget": strategy.DefaultBudget()}
	strategyHTTP(t, h, "PATCH", "/api/strategy/settings", "settings", jsonText(settings), 200)
	strategyHTTP(t, h, "PATCH", "/api/strategy/settings", "stale", jsonText(settings), 409)
	incomplete := strings.Replace(jsonText(settings), `"extraReadRetries":2,`, "", 1)
	strategyHTTP(t, h, "PATCH", "/api/strategy/settings", "incomplete", incomplete, 400)
	for _, header := range []string{"no-auth", "foreign-origin"} {
		req, _ := http.NewRequest("GET", h.URL+"/api/strategy/settings", nil)
		req.Host = "localhost:4177"
		expected := 401
		if header == "foreign-origin" {
			expected = 403
			req.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
			req.Header.Set("Origin", "https://foreign.example")
		}
		resp, err := h.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != expected {
			t.Fatalf("%s: %d", header, resp.StatusCode)
		}
	}
}

func TestStrategyRuntimeMissingSessionAndNewCredentialFailClosed(t *testing.T) {
	b, h := fixture(t)
	_, err := b.strategyProvider(context.Background(), "no-host-session", strategy.SelectionQuery{Profile: "core"}, nil)
	strategyCheckError(t, err, 404)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	ctx := StrategyContext{ProjectID: project}
	scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: project}
	input := StrategyAssetInput{Title: "Old preference", Kind: strategy.UserPreference, Body: "Use historical marker synthetic-runtime-strategy-key in reports."}
	a, err := b.Store.CreateStrategyAsset(ctx, scope, "historical", input)
	if err != nil {
		t.Fatal(err)
	}
	v, _ := b.Store.GetStrategyRevision(ctx, a.AssetID, 1)
	_, err = b.Store.BindStrategyAsset(ctx, scope, "adopt", StrategyBindingInput{Action: "adopt", Ref: v.Value.Ref})
	if err != nil {
		t.Fatal(err)
	}
	enableStrategyFixture(t, b.Store)
	// Only later does this exact substring become a configured credential.
	apiTest(t, h, "POST", "/api/settings/providers", providerFixture("future", "http://localhost:12345/v1", "synthetic-runtime-strategy-key"), 201)
	_, err = b.strategyProvider(context.Background(), id, strategy.SelectionQuery{Profile: "core"}, nil)
	strategyCheckError(t, err, 400)
	if strings.Contains(err.Error(), "synthetic-runtime-strategy-key") {
		t.Fatal("error disclosed the credential")
	}
}
