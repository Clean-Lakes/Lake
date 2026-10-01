package zcode

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"testing/iotest"
)

func TestProviderKeyRedactedAcrossStreamReads(t *testing.T) {
	key := []byte("fixture-key-split")
	r := &redactedBody{ReadCloser: io.NopCloser(iotest.OneByteReader(strings.NewReader("data: before fixture-key-split after\n\n"))), key: key}
	var out bytes.Buffer
	buf := make([]byte, 3)
	for {
		n, err := r.Read(buf)
		out.Write(buf[:n])
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if out.String() != "data: before [redacted] after\n\n" {
		t.Fatal("provider error key was not redacted")
	}
}

func TestModelProxyRemovesToolsAfterPresentationStops(t *testing.T) {
	for _, api := range []string{"anthropic", "openai_chat", "openai_responses"} {
		t.Run(api, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				json.NewDecoder(r.Body).Decode(&body)
				if _, ok := body["tools"]; ok {
					t.Error("tools remained after presentation exhausted")
				}
				for _, key := range []string{"tool_choice", "parallel_tool_calls"} {
					if _, ok := body[key]; ok {
						t.Error("tool control remained after presentation exhausted")
					}
				}
				data, _ := json.Marshal(body)
				if !strings.Contains(string(data), "fixture final response instruction") || !strings.Contains(string(data), "retained result") {
					t.Error("fallback lost instruction or prior results")
				}
				io.WriteString(w, `{}`)
			}))
			defer upstream.Close()
			proxy, err := modelProxy(Options{APIType: api, BaseURL: upstream.URL, APIKey: []byte("fixture-key"), ToolStopReason: func(context.Context) string { return "fixture final response instruction" }}, []string{"mcp__lake__fixture"})
			if err != nil {
				t.Fatal(err)
			}
			body := `{"tools":[{"function":{"name":"mcp__lake__fixture"}}],"tool_choice":"auto","parallel_tool_calls":true,"system":"retained result","messages":[{"role":"user","content":"retained result"}],"instructions":"retained result"}`
			path := map[string]string{"anthropic": "/v1/messages", "openai_chat": "/chat/completions", "openai_responses": "/responses"}[api]
			recorder := httptest.NewRecorder()
			proxy.ServeHTTP(recorder, httptest.NewRequest("POST", "/model"+path, strings.NewReader(body)))
			if recorder.Code != 200 {
				t.Fatal("fallback request failed")
			}
		})
	}
}

func TestModelProxyOnlyForwardsRegisteredToolsAndReplacesCredentials(t *testing.T) {
	for _, api := range []string{"anthropic", "openai_chat", "openai_responses"} {
		t.Run(api, func(t *testing.T) {
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if api == "anthropic" {
					if r.Header.Get("X-Api-Key") != "fixture-upstream-key" || r.Header.Get("Authorization") != "" {
						t.Error("wrong Anthropic auth")
					}
				} else if r.Header.Get("Authorization") != "Bearer fixture-upstream-key" || r.Header.Get("X-Api-Key") != "" {
					t.Error("wrong OpenAI auth")
				}
				if r.Header.Get("Cookie") != "" {
					t.Error("cookie forwarded")
				}
				io.WriteString(w, `{"ok":true}`)
			}))
			defer upstream.Close()
			h, err := startHost(context.Background(), Options{APIType: api, BaseURL: upstream.URL, APIKey: []byte("fixture-upstream-key")}, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			path := map[string]string{"anthropic": "/v1/messages", "openai_chat": "/chat/completions", "openai_responses": "/responses"}[api]
			call := func(token, body, path string) int {
				req, _ := http.NewRequest("POST", h.URL+"/model"+path, strings.NewReader(body))
				req.Header.Set("Authorization", "Bearer "+token)
				req.Header.Set("Cookie", "fixture=value")
				res, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer res.Body.Close()
				io.Copy(io.Discard, res.Body)
				return res.StatusCode
			}
			if call("bad", `{}`, path) != 401 {
				t.Fatal("unauthenticated proxy accessible")
			}
			if call(h.Token, `{"tools":[{"function":{"name":"Bash"}}]}`, path) != 403 {
				t.Fatal("unregistered tool reached model")
			}
			if call(h.Token, `{}`, "/arbitrary") != 403 {
				t.Fatal("generic forwarding route accepted")
			}
			if call(h.Token, `{}`, path) != 200 || calls.Load() != 1 {
				t.Fatal("valid proxy call failed")
			}
		})
	}
}
