package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestProviderCapacityIsIndependentOfCompressionBudget(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	var reads atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Error("capacity discovery must not generate a completion")
		}
		reads.Add(1)
		reply(w, 200, Object{"data": []Object{{"id": "active-fixture", "context_length": 1000000}, {"id": "other-fixture", "context_length": 200000}}})
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "active-fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"contextWindow": 64000}, 200)
	for i := 0; i < 2; i++ {
		result := apiTest(t, h, "GET", "/api/settings/model/capacity", nil, 200)
		if result["source"] != "provider" || integer(result["limit"]) != 1000000 {
			t.Fatal("missing provider capacity", result)
		}
	}
	if reads.Load() != 1 {
		t.Fatal("uncached discovery", reads.Load())
	}
	snap := apiTest(t, h, "GET", "/api/sessions/"+id+"/snapshot", nil, 200)
	c := object(object(snap["ai"])["context"])
	if integer(c["window"]) != 1000000 || integer(c["budget"]) != 64000 || c["usedKnown"] != false {
		t.Fatal("capacity, budget, and measurement conflated", c)
	}
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "missing-fixture", Protocol: "openai"})
	unknown := apiTest(t, h, "GET", "/api/settings/model/capacity", nil, 200)
	if integer(unknown["limit"]) != 0 {
		t.Fatal("borrowed another model's capacity", unknown)
	}
}
func TestContextMeasurementNeverFallsBackToLength(t *testing.T) {
	// The engine's 64K budget and large message history are not model capacity
	// or a provider-reported token count.
	model := ai.Model{URL: "http://localhost:1/v1/chat/completions", Name: "unknown", Protocol: "openai"}
	b, _ := fixture(t)
	b.Models.Save(&model)
	got := b.Models.CachedCapacity(b.Models.Active())
	if got.ContextLimit != 0 {
		t.Fatal("default budget masquerades as capacity")
	}
	if b.Models.WithCapacity(context.Background(), &model).ContextLimit != 0 {
		t.Fatal("failed discovery became a fake limit")
	}
}
