package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	lakemodel "github.com/cloudwego/eino/lake/model"
	"github.com/cloudwego/eino/lake/store"
)

type fakeModelKeys struct{}

func (fakeModelKeys) LoadModelAPIKey(string) ([]byte, error) {
	return []byte("test-key"), nil
}

type forbiddenModelKeys struct{}

func (forbiddenModelKeys) LoadModelAPIKey(string) ([]byte, error) {
	panic("inventory must not read model credentials")
}

func TestChatCompactsLongHistoryWithinConfiguredBudget(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	root := t.TempDir()
	var mu sync.Mutex
	summaryCalls := 0
	mainTokens := 0
	var mainMessages []struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			MaxTokens int               `json:"max_tokens"`
			Tools     []json.RawMessage `json:"tools"`
			Messages  []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		mu.Lock()
		answer := "final answer"
		if len(body.Tools) == 0 {
			summaryCalls++
			answer = "Earlier requests concerned the test project."
		} else {
			mainTokens = body.MaxTokens
			mainMessages = body.Messages
		}
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":` + string(mustJSON(t, answer)) + `}]}`))
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{
		Model: "test-model", ModelProvider: "test", ContextWindow: 4096, MaxOutputTokens: 512,
		ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}},
	}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	var turns []store.ConversationTurn
	for i := 0; i < 200; i++ {
		turns = append(turns, store.ConversationTurn{Prompt: strings.Repeat("x", 700), Answer: strings.Repeat("y", 700)})
	}
	var output bytes.Buffer
	if err := runChatWithHooks(ctx, []string{"current question"}, root, strings.NewReader(""), &output, &bytes.Buffer{}, &chatHooks{InitialTurns: turns}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if summaryCalls == 0 || mainTokens != 512 || len(mainMessages) < 2 || len(mainMessages) > 66 || !strings.Contains(string(mainMessages[0].Content), "summary") || mainMessages[len(mainMessages)-1].Role != "user" || !strings.Contains(output.String(), "final answer") {
		t.Fatalf("summaryCalls=%d mainTokens=%d mainMessages=%d output=%s", summaryCalls, mainTokens, len(mainMessages), output.String())
	}
}

func TestChatExplicitSkillLoadAddsContentWithoutModelCall(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "skills", "review")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: review\ndescription: 审查\n---\n检查边界条件"), 0600); err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		encoded, _ := json.Marshal(body)
		hasSkill := strings.Contains(string(encoded), "检查边界条件")
		if requests == 1 && hasSkill {
			t.Error("available Skill was loaded without user selection")
		}
		if requests == 2 && !hasSkill {
			t.Error("explicitly loaded Skill missing from model context")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"已检查"}]}`))
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	previous := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = previous })
	if err := runChat(context.Background(), nil, root, strings.NewReader("帮我审查\n/exit\n"), &bytes.Buffer{}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := runChat(context.Background(), nil, root, strings.NewReader("/skill load review\n帮我审查\n/exit\n"), &out, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if requests != 2 || !strings.Contains(out.String(), "已为本会话加载") || !strings.Contains(out.String(), "已检查") {
		t.Fatalf("requests=%d output=%s", requests, out.String())
	}
}

func TestWriteTurnStatsLabelsEstimatedUsage(t *testing.T) {
	var output bytes.Buffer
	estimated := lakemodel.UsageSnapshot{Calls: 1, EstimatedCalls: 1, EstimatedInputTokens: 120, EstimatedOutputTokens: 30}
	if err := writeTurnStats(&output, time.Second, estimated, estimated); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "估算") || !strings.Contains(output.String(), "输入 120 / 输出 30") {
		t.Fatalf("estimate label missing: %s", output.String())
	}
}

func mustJSON(t *testing.T, value string) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestLakeAgentSSHAuthorizationLoop(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateHost(ctx, store.ResourceInput{
		LakeID: lake.ID, Name: "host",
		SSH: store.SSHSpec{Host: "127.0.0.1", Port: 22, Username: "root"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		var req struct {
			Messages []json.RawMessage `json:"messages"`
			Tools    []struct {
				Name string `json:"name"`
			} `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		body, _ := json.Marshal(req.Messages)
		switch requests {
		case 1:
			if !strings.Contains(string(body), "root@127.0.0.1:22") {
				t.Errorf("authoritative inventory missing from follow-up history: %s", body)
			}
			parentTools := make(map[string]bool)
			for _, item := range req.Tools {
				parentTools[item.Name] = true
			}
			if !parentTools["lake_ssh_agent"] || parentTools["lake_ssh"] {
				t.Errorf("parent exposed wrong SSH tools: %v", parentTools)
			}
			_, _ = w.Write([]byte(`{"content":[{"type":"tool_use","id":"toolu_delegate","name":"lake_ssh_agent","input":{"request":"检查 host 的 CPU 占用"}}],"usage":{"input_tokens":100,"output_tokens":10}}`))
		case 2:
			childHasSSH := false
			for _, item := range req.Tools {
				childHasSSH = childHasSSH || item.Name == "lake_ssh"
			}
			if !childHasSSH {
				t.Error("SSH specialist has no SSH execution tool")
			}
			_, _ = w.Write([]byte(`{"content":[{"type":"tool_use","id":"toolu_ssh","name":"lake_ssh","input":{"resource":"host","check":"cpu"}}],"usage":{"input_tokens":60,"output_tokens":10}}`))
		case 3:
			if !strings.Contains(string(body), "尚未开启执行授权") {
				t.Error("denied SSH tool result missing from specialist follow-up")
			}
			_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"需要先开启主机授权。"}],"usage":{"input_tokens":120,"output_tokens":20}}`))
		case 4:
			if !strings.Contains(string(body), "需要先开启主机授权") {
				t.Error("SSH specialist result missing from parent follow-up")
			}
			_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"需要先开启主机授权。"}],"usage":{"input_tokens":130,"output_tokens":20}}`))
		default:
			t.Errorf("unexpected model request %d", requests)
		}
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{
		Model: "mimo-v2.6-pro", ModelProvider: "mimo",
		ModelProviders: map[string]providerConfig{"mimo": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}},
	}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	var out, errOut bytes.Buffer
	if err := runChat(ctx, nil, root, strings.NewReader("去测试湖里面看有什么资源\n去这台服务器里看一下它的CPU占用多少\n/exit\n"), &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if requests != 4 || !strings.Contains(out.String(), "需要先开启主机授权") || !strings.Contains(out.String(), "执行链路：Lake Agent → SSH 专员 → Lake Agent") || !strings.Contains(out.String(), "模型请求") || !strings.Contains(out.String(), "工具及本地") || !strings.Contains(out.String(), "模型调用 4 次") || !strings.Contains(out.String(), "Token 输入 410 / 输出 60 / 合计 470") {
		t.Fatalf("requests=%d output=%q", requests, out.String())
	}
	s, err = store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	journal, err := s.ListJournal(ctx, store.JournalFilter{})
	if err != nil || len(journal) != 2 || journal[0].Event != "denied" {
		t.Fatalf("journal=%+v err=%v", journal, err)
	}
}

func TestChatParentFailurePreservesReturnedSpecialistCompletion(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	lake, err := s.CreateLake(ctx, "ops", "")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "host", SSH: store.SSHSpec{Host: "example.invalid", Port: 22, Username: "root"}}); err != nil {
		t.Fatal(err)
	}
	s.Close()
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		switch requests {
		case 1:
			w.Write([]byte(`{"content":[{"type":"tool_use","id":"delegate-once","name":"lake_ssh_agent","input":{"request":"分析 host 的授权范围，无需远端执行"}}]}`))
		case 2:
			w.Write([]byte(`{"content":[{"type":"text","text":"specialist finished"}]}`))
		default:
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			encoded, _ := json.Marshal(body)
			if !strings.Contains(string(encoded), "specialist finished") {
				t.Error("returned specialist output missing from parent request")
			}
			http.Error(w, "simulated parent model outage", http.StatusServiceUnavailable)
		}
	}))
	defer server.Close()
	if err = saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	previous := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = previous })
	var calls []store.SpecialistCall
	err = runChatWithHooks(ctx, []string{"请分析这台主机的授权范围"}, root, strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{}, &chatHooks{OnSpecialist: func(call store.SpecialistCall) { calls = append(calls, call) }})
	if err == nil {
		t.Fatal("expected parent failure")
	}
	if len(calls) == 0 || calls[len(calls)-1].Stage != "completed" {
		t.Fatalf("returned specialist marked failed: %+v, error=%v", calls, err)
	}
}

func TestLakeAgentUnqualifiedResourcesUseGlobalOverview(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateHost(ctx, store.ResourceInput{
		LakeID: lake.ID, Name: "host", Env: "test",
		SSH: store.SSHSpec{Host: "127.0.0.1", Port: 22, Username: "root"},
	}); err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateLake(ctx, "生产湖", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"web", "db"} {
		if _, err := s.CreateHost(ctx, store.ResourceInput{
			LakeID: other.ID, Name: name,
			SSH: store.SSHSpec{Host: name + ".example.com", Port: 22, Username: "ops"},
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.CreateLake(ctx, "空湖", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		var req struct {
			Messages []json.RawMessage `json:"messages"`
			Tools    []struct {
				Name string `json:"name"`
			} `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		if requests == 1 {
			found := false
			for _, tool := range req.Tools {
				found = found || tool.Name == "lake_overview"
			}
			if !found {
				t.Error("lake_overview missing from model tool list")
			}
			_, _ = w.Write([]byte(`{"content":[{"type":"tool_use","id":"toolu_list","name":"lake_overview","input":{}}],"usage":{"input_tokens":80,"output_tokens":10}}`))
			return
		}
		body, _ := json.Marshal(req.Messages)
		for _, want := range []string{`\"total_lakes\":3`, `\"total_resources\":3`, `\"name\":\"测试湖\"`, `\"resource_count\":1`, `\"name\":\"生产湖\"`, `\"resource_count\":2`, `\"name\":\"空湖\"`, `\"resource_count\":0`} {
			if !strings.Contains(string(body), want) {
				t.Errorf("overview tool result missing %s: %s", want, body)
			}
		}
		if strings.Contains(string(body), "127.0.0.1") || strings.Contains(string(body), "example.com") {
			t.Errorf("overview leaked host details: %s", body)
		}
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"共有 3 个湖、3 个资源。"}],"usage":{"input_tokens":100,"output_tokens":20}}`))
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{
		Model: "mimo-v2.6-pro", ModelProvider: "mimo",
		ModelProviders: map[string]providerConfig{"mimo": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}},
	}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	var out, errOut bytes.Buffer
	if err := runChat(ctx, nil, root, strings.NewReader("你有哪些资源\n/exit\n"), &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if requests != 0 || !strings.Contains(out.String(), "共有 3 个湖、3 个资源") || !strings.Contains(out.String(), "数据层查询（未调用模型）") {
		t.Fatalf("requests=%d output=%q", requests, out.String())
	}
}

func TestLakeAgentNamedLakeInventoryUsesStoreWithoutModel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateHost(ctx, store.ResourceInput{
		LakeID: lake.ID, Name: "36.151.150.63",
		SSH: store.SSHSpec{Host: "36.151.150.63", Port: 22, Username: "root"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		http.Error(w, "inventory should not call the model", http.StatusInternalServerError)
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{
		Model: "mimo-v2.6-pro", ModelProvider: "mimo",
		ModelProviders: map[string]providerConfig{"mimo": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}},
	}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = forbiddenModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	var out, errOut bytes.Buffer
	if err := runChat(ctx, nil, root, strings.NewReader("去测试湖里面去看什么资源\n/exit\n"), &out, &errOut); err != nil {
		t.Fatal(err)
	}
	answer := out.String()
	if requests != 0 || !strings.Contains(answer, "root@36.151.150.63:22") || strings.Contains(answer, "web-01") || strings.Contains(answer, "授权命令") {
		t.Fatalf("requests=%d output=%q", requests, answer)
	}
}

func TestLakeResourcesRequiresExplicitLakeAndCanReadOtherLake(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	current, err := s.CreateLake(ctx, "当前湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, current.ID); err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateLake(ctx, "另一湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateHost(ctx, store.ResourceInput{
		LakeID: other.ID, Name: "other-host", SSH: store.SSHSpec{Host: "other.example.com", Port: 22, Username: "ops"},
	}); err != nil {
		t.Fatal(err)
	}
	resourceTool, err := newLakeResourcesTool(s)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := resourceTool.InvokableRun(ctx, `{}`); err == nil {
		t.Fatal("lake_resources accepted a missing lake")
	}
	result, err := resourceTool.InvokableRun(ctx, `{"lake":"另一湖"}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, `"lake":"另一湖"`) || !strings.Contains(result, "ops@other.example.com:22") {
		t.Fatalf("unexpected resource result: %s", result)
	}
}

func TestLakeAgentOverviewWithoutCurrentLake(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateLake(ctx, "未选择的湖", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		tools := make(map[string]bool)
		for _, item := range req.Tools {
			tools[item.Name] = true
		}
		if !tools["lake_overview"] || !tools["lake_resources"] || tools["lake_ssh"] || tools["lake_ssh_agent"] {
			t.Errorf("unexpected tools without a selected lake: %v", tools)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"可以查看湖的资源概况。"}],"usage":{"input_tokens":10,"output_tokens":10}}`))
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{
		Model: "mimo-v2.6-pro", ModelProvider: "mimo",
		ModelProviders: map[string]providerConfig{"mimo": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}},
	}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	var out, errOut bytes.Buffer
	if err := runChat(ctx, nil, root, strings.NewReader("有哪些湖\n/exit\n"), &out, &errOut); err != nil {
		t.Fatal(err)
	}
}

func TestChatAuthzCommandRunsLocallyAndPersists(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateHost(ctx, store.ResourceInput{
		LakeID: lake.ID, Name: "host",
		SSH: store.SSHSpec{Host: "127.0.0.1", Port: 22, Username: "root"},
	}); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	handled, err := runLocalChatCommand(ctx, s, "lake res authz 测试湖/host on", &out, &errOut)
	if !handled || err != nil || !strings.Contains(out.String(), "execute_authz=true") {
		t.Fatalf("handled=%t err=%v out=%q", handled, err, out.String())
	}
	resource, err := s.ResolveResource(ctx, "测试湖/host")
	if err != nil || !resource.ExecuteAuthz {
		t.Fatalf("authorization not persisted: %+v err=%v", resource, err)
	}
}
