package web

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

// Run the user-facing Python fixture, real curl and terminal bridge through
// HTTP + official ADK. Mock only the model's deterministic decisions.
func TestStrategyTrialHealthCurlRealBridge(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses the macOS/Linux shell integration")
	}
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	if _, err := exec.LookPath("curl"); err != nil {
		t.Skip("curl unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, python, filepath.Join("..", "..", "scripts", "strategy_trial_fixture.py"), "--ttl-seconds", "60")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); _ = cmd.Wait() }()
	line, err := bufio.NewReader(stdout).ReadBytes('\n')
	var fixtureInfo Object
	if err != nil || json.Unmarshal(line, &fixtureInfo) != nil {
		t.Fatal("trial fixture did not start", err)
	}
	for _, mode := range []string{"recovery", "persistent", "untrusted_path"} {
		t.Run(mode, func(t *testing.T) {
			b, h := fixture(t)
			id, ref := newSession(t, h)
			url := stringOf(object(fixtureInfo[mode])["url"])
			var invalidSamples atomic.Int32
			if mode == "untrusted_path" {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					invalidSamples.Add(1)
					conn, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					conn.Close()
				}))
				defer server.Close()
				url = server.URL + "/fail/user"
			}
			command := "curl -sS --max-time 2 " + url
			wantRisk := "readonly"
			if mode == "untrusted_path" {
				wantRisk = "write"
			}
			if CommandPolicy(command).Risk != wantRisk {
				t.Fatal("trial address violated the intended policy boundary", mode)
			}
			_, err := b.Store.SetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "curl-trial", 0, StrategySettingsInput{MasterEnabled: true, CorrectEnabled: true, OnlineCorrectEnabled: true, Budget: strategy.DefaultBudget()})
			if err != nil {
				t.Fatal(err)
			}
			term := b.openAgentTerminal(context.Background(), id, ref)
			tid := stringOf(term["id"])
			b.Terminals.Control(id, tid, "agent")
			arguments := jsonText(Object{"command": command, "runtime": "local", "terminal_id": tid, "timeout_ms": 3000})
			var requests atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := int(requests.Add(1))
				if n > 5 {
					t.Error("unbounded model requests")
					emitModel(w, "停止。", nil)
					return
				}
				if mode == "recovery" && n == 4 {
					var request Object
					json.NewDecoder(r.Body).Decode(&request)
					messages := objects(request["messages"])
					var receipt Object
					if json.Unmarshal([]byte(stringOf(messages[len(messages)-1]["content"])), &receipt) != nil || !strings.Contains(stringOf(receipt["output"]), `"healthy": true`) {
						t.Error("recovery report lacked actual fixture evidence")
					}
					emitModel(w, "本次检查取得 healthy=true，不代表业务恢复。", nil)
					return
				}
				if n%2 == 1 {
					emitModel(w, "", []ai.Call{{ID: fmt.Sprintf("sample-%d", (n+1)/2), Name: "shell", Arguments: arguments}})
					return
				}
				proposal := Object{"sourceId": fmt.Sprintf("sample-%d", n/2), "refutedHypothesis": "原采样未取得响应。", "changes": "在同一目标对原命令独立采样一次，不增加底层重试。", "expectedInformation": "取得本次真实响应或保留失败。", "stopCondition": "两次额外采样或连续无进展即停止。", "tool": "shell", "arguments": arguments}
				emitModel(w, "", []ai.Call{{ID: fmt.Sprintf("proposal-%d", n/2), Name: "revise_readonly_strategy", Arguments: jsonText(proposal)}})
			}))
			defer provider.Close()
			b.Models.Save(&ai.Model{URL: provider.URL, Name: "real-curl-trial", Protocol: "openai"})
			apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": ref, "terminal_id": tid, "silentCommands": true}, 200)
			apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "只读检查，失败后先提案，同一命令最多额外采样两次。"}, 202)
			b.workers.Wait()
			view, _ := b.Engine.Snapshot(id)
			var report strategy.OnlineReport
			for _, card := range view.Cards {
				if card.Type == "strategy_correction" {
					must(json.Unmarshal([]byte(jsonText(card.Data)), &report))
				}
			}
			wantSamples, wantRequests, wantRevisions := 3, 5, 2
			wantStop := strategy.NoProgress
			if mode == "recovery" {
				wantSamples, wantRequests, wantRevisions, wantStop = 2, 4, 1, strategy.Completed
			} else if mode == "untrusted_path" {
				wantSamples, wantRequests, wantRevisions, wantStop = 1, 1, 0, strategy.PermissionBlocked
			}
			if len(report.Observations) != wantSamples || len(report.Revisions) != wantRevisions || report.StopReason != wantStop || int(requests.Load()) != wantRequests || report.Recovered != (mode == "recovery") {
				t.Fatalf("wrong bounded curl flow: mode=%s stop=%s observations=%d revisions=%d requests=%d", mode, report.StopReason, len(report.Observations), len(report.Revisions), requests.Load())
			}
			for i, ob := range report.Observations {
				if ob.TrustedReadOnly != (mode != "untrusted_path") || ob.CheckHash != report.Observations[0].CheckHash || ob.TargetHash != report.Observations[0].TargetHash || i == 0 && (ob.Class != "transient" || ob.Success) {
					t.Fatal("original failure, target or readonly evidence lost")
				}
			}
			if mode == "untrusted_path" {
				if invalidSamples.Load() != 1 {
					t.Fatal("untrusted endpoint was replayed")
				}
			} else {
				res, err := http.Get(strings.TrimSuffix(url, "/health") + "/status")
				if err != nil {
					t.Fatal(err)
				}
				defer res.Body.Close()
				var state Object
				must(json.NewDecoder(res.Body).Decode(&state))
				if integer(state["samples"]) != wantSamples {
					t.Fatal("real endpoint samples differ from correction observations")
				}
			}
			if mode == "recovery" && view.Status != "completed" || mode != "recovery" && view.Status != "failed" {
				t.Fatal("unexpected terminal turn status", view.Status)
			}
		})
	}
}
