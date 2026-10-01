package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/store"
	"golang.org/x/net/websocket"
)

func TestHTTPEventsAndWebSocketResumeSequence(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.CreateLake(ctx, "ops", ""); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, "ops")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"first", "second"} {
		if _, err := s.AppendAgentEvent(ctx, conversation.ID, store.AgentEventInput{Kind: "assistant_progress", Actor: "assistant", Payload: json.RawMessage(`{"preview":"` + name + `"}`)}); err != nil {
			t.Fatal(err)
		}
	}
	server, err := New(Config{Store: s, ListenAddress: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()
	request, err := http.NewRequest("GET", httpServer.URL+"/api/v1/conversations/"+conversation.ID+"/events?after=1&limit=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", httpServer.URL)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("status=%d", response.StatusCode)
	}
	var page []agent.AgentEvent
	if err := json.NewDecoder(response.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	if len(page) != 1 || page[0].Version != 1 || page[0].Sequence != 2 || page[0].SessionID != agent.SessionID(conversation.ID) {
		t.Fatalf("page=%+v", page)
	}
	config, err := websocket.NewConfig("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/api/v1/conversations/"+conversation.ID+"/stream?after=1", httpServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	config.Protocol = []string{"lake.v1"}
	connection, err := websocket.DialConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(3 * time.Second))
	var streamed agent.AgentEvent
	if err := websocket.JSON.Receive(connection, &streamed); err != nil {
		t.Fatal(err)
	}
	if streamed.Sequence != 2 || streamed.Kind != "assistant_progress" {
		t.Fatalf("streamed=%+v", streamed)
	}
	if _, err := s.AppendAgentEvent(ctx, conversation.ID, store.AgentEventInput{Kind: "answer_finished", Actor: "assistant", Payload: json.RawMessage(`{"status":"completed"}`)}); err != nil {
		t.Fatal(err)
	}
	if err := websocket.JSON.Receive(connection, &streamed); err != nil {
		t.Fatal(err)
	}
	if streamed.Sequence != 3 {
		t.Fatalf("sequence=%d", streamed.Sequence)
	}
}

func TestWebSecurityGates(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := New(Config{Store: s, ListenAddress: "0.0.0.0:8765"}); err == nil {
		t.Fatal("remote without token/TLS accepted")
	}
	if _, err := New(Config{Store: s, ListenAddress: "0.0.0.0:8765", Token: strings.Repeat("x", 32), AllowedOrigins: []string{"http://example.com"}, TLS: true}); err == nil {
		t.Fatal("insecure remote origin accepted")
	}
	server, err := New(Config{Store: s, ListenAddress: "0.0.0.0:8765", Token: strings.Repeat("x", 32), AllowedOrigins: []string{"https://lake.example.com"}, TLS: true})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", "https://lake.example.com/api/v1/health", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != 401 {
		t.Fatalf("missing token=%d", response.Code)
	}
	request.Header.Set("Authorization", "Bearer "+strings.Repeat("x", 32))
	request.Header.Set("Origin", "https://evil.example.com")
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != 403 {
		t.Fatalf("bad origin=%d", response.Code)
	}
	request.Header.Set("Origin", "https://lake.example.com")
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatalf("authorized=%d", response.Code)
	}
	request.Header.Del("Origin")
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatalf("same-origin fetch without Origin=%d", response.Code)
	}
	request.Method = "POST"
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != 405 {
		t.Fatalf("mutating method=%d", response.Code)
	}
}

func TestConversationTurnsAndLinkedEvent(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.CreateLake(ctx, "ops", ""); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, "ops")
	if err != nil {
		t.Fatal(err)
	}
	turn, err := s.AppendConversationTurn(ctx, conversation.ID, "完整提问", "完整回答", "完整回答", "")
	if err != nil {
		t.Fatal(err)
	}
	web, err := New(Config{Store: s, ListenAddress: "127.0.0.1:8765"})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	web.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/api/v1/conversations/"+conversation.ID+"/turns", nil))
	if response.Code != 200 {
		t.Fatalf("turn status=%d", response.Code)
	}
	var turns []store.ConversationTurn
	if err := json.Unmarshal(response.Body.Bytes(), &turns); err != nil {
		t.Fatal(err)
	}
	if len(turns) != 1 || turns[0].Answer != "完整回答" {
		t.Fatalf("turns=%+v", turns)
	}
	response = httptest.NewRecorder()
	web.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/api/v1/conversations/"+conversation.ID+"/events", nil))
	var events []agent.AgentEvent
	if err := json.Unmarshal(response.Body.Bytes(), &events); err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].LegacyTurnID != turn.ID || events[1].LegacyTurnID != turn.ID {
		t.Fatalf("events=%+v", events)
	}
}
