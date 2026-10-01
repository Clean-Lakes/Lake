package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/agent"
	agenttools "github.com/cloudwego/eino/lake/agent/tools"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
	"strings"
	"testing"
)

func TestUIComponentInputOwnsLifecycleAndNormalizesCommonModelShapes(t *testing.T) {
	ctx := context.Background()
	session := agent.NewUISession()
	presented := 0
	r := &uiRuntime{session: session, present: func(_ context.Context, snapshot agent.UISnapshot) error {
		presented++
		return session.Restore(snapshot)
	}}
	base, err := r.tools()
	if err != nil {
		t.Fatal(err)
	}
	registered, err := registerChatTools(ctx, base, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	invoke := registered[0].(tool.InvokableTool)
	out, err := invoke.InvokableRun(ctx, `{"components":[{"id":"root","component":"Column","props":{"children":["cpu","disk"]}},{"id":"cpu","component":"Metric","props":{"label":"CPU","value":1.2}},{"id":"disk","component":"Metric","label":"磁盘","value":{"path":"/disk"}}],"data":{"disk":"17%"}}`)
	var result uiToolOutput
	if err != nil || json.Unmarshal([]byte(out), &result) != nil || !result.Displayed || result.SurfaceID == "" {
		t.Fatalf("simple component input failed: %s, %v", out, err)
	}
	first, ok := session.Get(result.SurfaceID)
	if !ok || first.Revision != 1 || first.Components[1]["value"] != "1.2" || first.Data["disk"] != "17%" {
		t.Fatal("canonical components or facts lost")
	}
	update, _ := json.Marshal(uiToolInput{SurfaceID: result.SurfaceID, Data: map[string]any{"disk": "18%"}})
	if out, err = invoke.InvokableRun(ctx, string(update)); err != nil || !strings.Contains(out, `"displayed":true`) {
		t.Fatal("existing surface data update failed", out, err)
	}
	second, _ := session.Get(result.SurfaceID)
	if second.Revision != 2 || len(second.Components) != 3 || second.Data["disk"] != "18%" || presented != 2 {
		t.Fatal("update created another surface or lost components")
	}
	for _, input := range []string{
		`{}`, `{"data":{"disk":"17%"}}`,
		`{"components":[{"id":"root","component":"HTML","html":"<script>bad</script>"}]}`,
		`{"components":[{"id":"root","component":"Text","text":"a","props":{"text":"b"}}]}`,
		`{"components":[{"id":"root","component":"Text","props":{"id":"override","text":"a"}}]}`,
		`{"components":[{"id":"root","component":"Button","label":"运行","action":{"event":{"name":"execute","context":{}}}}]}`,
		`{"messages":[],"components":[{"id":"root","component":"Text","text":"混用"}]}`,
	} {
		out, err = invoke.InvokableRun(ctx, input)
		if err != nil || !strings.Contains(out, `"error":"invalid_ui"`) {
			t.Fatalf("invalid input escaped validation: %s, %v", out, err)
		}
	}
	if presented != 2 {
		t.Fatal("rejected input altered displayed surfaces")
	}
	if err = r.publish(ctx, uiCreate("protected", portComponents(), map[string]any{"selectedHost": "", "resource": "", "ports": []any{}, "title": "检查", "summary": "未查询", "count": "—", "detail": "待查询", "logs": "待查询", "activeTab": 0}), "ports"); err != nil {
		t.Fatal(err)
	}
	if _, err = r.publishInput(ctx, uiToolInput{SurfaceID: "protected", Data: map[string]any{"ports": []any{}}}); !errors.Is(err, agenttools.ErrInvalidInput) {
		t.Fatal("simple input bypassed native port panel protection")
	}
}

type uiTestKeys struct{ loads int }

func (k *uiTestKeys) Load(string) ([]byte, error) { k.loads++; return []byte("fixture-only"), nil }

type uiTestSSH struct {
	calls   int
	command string
}

func (r *uiTestSSH) Run(_ context.Context, _ sshtransport.Target, _ []byte, command string) (sshtransport.Result, error) {
	r.calls++
	r.command = command
	if strings.HasPrefix(command, "ss ") {
		return sshtransport.Result{Stdout: "tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:((\"sshd\",pid=42,fd=3))\nudp UNCONN 0 0 [::]:5353 [::]:*\n"}, nil
	}
	return sshtransport.Result{Stdout: "42 1 root 00:10 sshd\n---LAKE_JOURNAL---\n2026-10-01 fixture log token=fixture-sensitive"}, nil
}
func TestPortInspectorQueriesWithApprovalAndValidatesSavedPID(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, _ := s.CreateLake(ctx, "ports", "")
	_ = s.UseLake(ctx, lake.ID)
	host, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "fixture-host", SSH: store.SSHSpec{Host: "127.0.0.1", Port: 22, Username: "root"}})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = s.SetExecuteAuthz(ctx, host.ID, true)
	_, err = s.SetCredentialRef(ctx, host.ID, "file:ssh/0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	service, err := operate.NewService(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	keys := &uiTestKeys{}
	ssh := &uiTestSSH{}
	service.Runner = ssh
	service.Opener = nil
	service.Keys = keys
	service.Confirm = func(context.Context, string, string) (bool, error) { return false, nil }
	session := agent.NewUISession()
	r := &uiRuntime{service: service, session: session, present: func(_ context.Context, v agent.UISnapshot) error {
		v, err := store.SanitizeUISnapshot(v)
		if err != nil {
			return err
		}
		return session.Restore(v)
	}}
	if err = r.publish(ctx, uiCreate("ports", portComponents(), map[string]any{"selectedHost": "fixture-host", "resource": "", "ports": []any{}, "title": "检查", "summary": "未查询", "count": "—", "detail": "待查询", "logs": "待查询", "activeTab": 0}), "ports"); err != nil {
		t.Fatal(err)
	}
	action := agent.UIUserAction{SurfaceID: "ports", SourceComponentID: "query", Name: "inspect_ports", Revision: 1, Context: map[string]any{"resource": "fixture-host"}}
	if _, handled, err := r.handle(ctx, action); err != nil || !handled {
		t.Fatal(err)
	}
	if ssh.calls != 0 || keys.loads != 0 {
		t.Fatal("denied query used network or credentials")
	}
	v, _ := session.Get("ports")
	if !strings.Contains(v.Data["summary"].(string), "查询未完成") {
		t.Fatal("denial not visible")
	}
	service.Confirm = func(context.Context, string, string) (bool, error) { return true, nil }
	action.Revision = v.Revision
	if _, _, err = r.handle(ctx, action); err != nil {
		t.Fatal(err)
	}
	v, _ = session.Get("ports")
	rows := v.Data["ports"].([]any)
	if len(rows) != 2 || v.Data["count"] != "2" || ssh.command != "ss -H -lntup" {
		t.Fatal("port facts missing")
	}
	process := agent.UIUserAction{SurfaceID: "ports", SourceComponentID: "ports", Name: "inspect_process", Revision: v.Revision, Context: map[string]any{"resource": "fixture-host", "pid": "99"}}
	if _, _, err = r.handle(ctx, process); err == nil {
		t.Fatal("unknown PID accepted")
	}
	process.Context["pid"] = "42;echo bad"
	if _, _, err = r.handle(ctx, process); err == nil {
		t.Fatal("PID command injection accepted")
	}
	process.Context["pid"] = "42"
	if _, _, err = r.handle(ctx, process); err != nil {
		t.Fatal(err)
	}
	v, _ = session.Get("ports")
	if !strings.Contains(v.Data["detail"].(string), "sshd") || strings.Contains(v.Data["logs"].(string), "fixture-sensitive") {
		t.Fatal("missing details or logs not redacted")
	}
	if ssh.calls != 2 || !strings.Contains(ssh.command, "journalctl --no-pager -n 40") {
		t.Fatal("wrong query count")
	}
	if err = r.publish(ctx, []agent.UIMessage{{Version: agent.UIVersion, UpdateDataModel: &agent.UIUpdateDataModel{SurfaceID: "ports", Value: map[string]any{"ports": []any{map[string]any{"pid": "1"}}}}}}, ""); err == nil {
		t.Fatal("model replaced trusted inspection results")
	}
	restored := agent.NewUISession()
	body, _ := json.Marshal(v)
	var copied agent.UISnapshot
	_ = json.Unmarshal(body, &copied)
	if err = restored.Restore(copied); err != nil {
		t.Fatal(err)
	}
	if _, err = restored.CheckAction(agent.UIUserAction{SurfaceID: "ports", SourceComponentID: "query", Name: "inspect_ports", Revision: v.Revision, Context: map[string]any{"resource": "fixture-host"}}); err != nil {
		t.Fatal("restored action not available", err)
	}
}
func TestPortParserPreservesUnknownProcessesAndCoverage(t *testing.T) {
	lines := ""
	for i := 0; i < 203; i++ {
		lines += "tcp LISTEN 0 128 [::]:80 [::]:*\n"
	}
	lines += "unrecognized\n"
	rows, truncated, skipped := parseListeningPorts(lines)
	if len(rows) != 200 || !truncated || skipped != 1 || rows[0].(map[string]any)["pid"] != "" {
		t.Fatal("coverage or unknown PID lost")
	}
}
