package web

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// Explicit opt-in only: never contacts a provider in normal Go/CI tests. Reads
// the selected Dev model privately; sends ONLY frozen synthetic cases, no Home
// conversations, source databases, keys in output, or model/tool operations.
func TestNaturalPreferenceModelEvaluation(t *testing.T) {
	home := os.Getenv("LAKE_N2_EVAL_HOME")
	if home == "" {
		t.Skip("explicit Dev model evaluation only")
	}
	expected, _ := os.UserHomeDir()
	if filepath.Clean(home) != filepath.Join(expected, ".lake-dev") {
		t.Fatal("evaluation requires the explicit Dev Home")
	}
	outputPath := os.Getenv("LAKE_N2_EVAL_REPORT")
	if outputPath == "" {
		t.Fatal("private report path required")
	}
	raw, e := os.ReadFile("testdata/natural-memory-intent-v1.json")
	if e != nil {
		t.Fatal(e)
	}
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:]) != "922f2a4f4b30ae23ba5c178af1456a0a635fff69f1b37505b4bd4f62bc21f084" {
		t.Fatal("frozen dataset changed")
	}
	var data struct {
		Runs  int `json:"runs"`
		Cases []struct {
			ID       string `json:"id"`
			Text     string `json:"userText"`
			Expected struct {
				Decision    string `json:"decision"`
				Scope       string `json:"scope"`
				Replacement bool   `json:"replacement"`
			} `json:"expected"`
			Previous *struct {
				Revision int    `json:"revision"`
				Scope    string `json:"scope"`
				Body     string `json:"body"`
			} `json:"previousPreference"`
		} `json:"cases"`
	}
	if json.Unmarshal(raw, &data) != nil || len(data.Cases) != 60 || data.Runs != 3 {
		t.Fatal("invalid fixed dataset")
	}
	models := &Models{Home: home, Dir: filepath.Join(home, "web-agent")}
	model := models.CachedCapacity(models.Active())
	if model == nil {
		t.Fatal("no selected Dev model")
	}
	model.MaxOutput = 2048
	engine, e := ai.New(t.TempDir(), nil, nil)
	if e != nil {
		t.Fatal("evaluation engine unavailable")
	}
	defer engine.Shutdown()
	type item struct {
		Run          int      `json:"run"`
		ID           string   `json:"id"`
		Decision     string   `json:"decision"`
		Scope        string   `json:"scope"`
		Replacement  bool     `json:"replacement"`
		HostAccepted bool     `json:"hostAccepted"`
		Correct      bool     `json:"correct"`
		Error        string   `json:"error,omitempty"`
		Usage        ai.Usage `json:"usage"`
		DurationMS   int64    `json:"durationMs"`
	}
	combined := os.Getenv("LAKE_N2_EVAL_COMBINED") == "1"
	results := make([]item, 180)
	tasks := make(chan int)
	var workers sync.WaitGroup
	for n := 0; n < 4; n++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range tasks {
				c := data.Cases[index%60]
				run := index/60 + 1
				existing := []Object{}
				if c.Previous != nil {
					existing = append(existing, Object{"topic": "fixture-prior-preference", "revision": c.Previous.Revision, "scope": c.Previous.Scope, "body": c.Previous.Body})
				}
				ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
				started := time.Now()
				text, usage, err := engine.ExtractMemory(ctx, *model, naturalPreferenceMessages(ai.MemoryTurnSnapshot{UserText: c.Text, LegacyExtraction: combined}, existing, ""))
				cancel()
				result := item{Run: run, ID: c.ID, Usage: usage, DurationMS: time.Since(started).Milliseconds()}
				if err != nil {
					result.Error = "provider_error"
				} else {
					parsed, legacy, parseErr := parseNaturalPreferenceCompletion(text, combined)
					if len(legacy) != 0 {
						parseErr = fmt.Errorf("synthetic preference corpus must not create legacy facts")
					}
					if parseErr != nil {
						result.Error = "invalid_output"
					} else {
						result.Decision, result.Scope, result.Replacement = parsed.Decision, parsed.Scope, parsed.Replacement
						result.HostAccepted = parsed.Decision == "save" && validateNaturalPreferenceResult(c.Text, parsed) == nil
						result.Correct = parsed.Decision == c.Expected.Decision && parsed.Scope == c.Expected.Scope && parsed.Replacement == c.Expected.Replacement
						if c.Expected.Decision == "save" {
							result.Correct = result.Correct && result.HostAccepted
							if c.Previous != nil {
								result.Correct = result.Correct && parsed.ExpectedRevision == c.Previous.Revision && parsed.Topic == "fixture-prior-preference"
							}
						}
					}
				}
				results[index] = result
			}
		}()
	}
	for i := range results {
		tasks <- i
	}
	close(tasks)
	workers.Wait()
	summaries := []Object{}
	passed := true
	for run := 1; run <= 3; run++ {
		positive, falseWrites, wrongScopes, unsupported, technical, exact := 0, 0, 0, 0, 0, 0
		for _, r := range results {
			if r.Run != run {
				continue
			}
			var expectedDecision, expectedScope string
			for _, v := range data.Cases {
				if v.ID == r.ID {
					expectedDecision, expectedScope = v.Expected.Decision, v.Expected.Scope
				}
			}
			if r.Error != "" {
				technical++
			}
			if r.Correct {
				exact++
			}
			if expectedDecision == "save" && r.Correct {
				positive++
			}
			if r.HostAccepted && expectedDecision != "save" {
				falseWrites++
			}
			if r.HostAccepted && r.Scope != expectedScope {
				wrongScopes++
			}
			if r.HostAccepted && expectedDecision != "save" {
				unsupported++
			}
		}
		ok := falseWrites == 0 && wrongScopes == 0 && unsupported == 0 && positive >= 27 && technical == 0
		passed = passed && ok
		summaries = append(summaries, Object{"run": run, "positiveRecallCount": positive, "positiveCount": 30, "falseAutoWrites": falseWrites, "wrongScopes": wrongScopes, "unsupportedSources": unsupported, "technicalFailures": technical, "exactDecisions": exact, "passed": ok})
	}
	report := Object{"schemaVersion": 1, "fixtureSHA256": hex.EncodeToString(digest[:]), "promptSHA256": memoryHash(naturalPreferencePrompt), "model": Object{"name": model.Name, "protocol": model.Protocol, "identityHash": memoryHash(ai.ModelIdentity(*model)), "maxOutput": model.MaxOutput}, "casesPerRun": 60, "runs": 3, "providerDispatches": len(results), "summaries": summaries, "passed": passed, "results": results, "combined": combined, "scope": "production prompt/parser plus host source guard; no tool calls or persistence"}
	encoded, _ := json.MarshalIndent(report, "", "  ")
	if os.WriteFile(outputPath, encoded, 0600) != nil {
		t.Fatal("cannot save report")
	}
	t.Log(jsonText(summaries))
	if !passed {
		t.Fatal("fixed natural preference quality thresholds not met; see private report")
	}
}
