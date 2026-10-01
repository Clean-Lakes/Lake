package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/store"
)

func testUserQuestions() agent.UserQuestionInput {
	return agent.UserQuestionInput{Questions: []agent.UserQuestion{{ID: "target", Header: "目标", Prompt: "已发现宿主和容器 nginx，选择本次目标。", Options: []agent.UserQuestionOption{{Label: "宿主 nginx（host_nginx）"}, {Label: "容器 nginx"}}}}}
}

func TestQuestionGateRejectsWrongIncompleteAndDuplicateAnswers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	g := &bridgeQuestionGate{}
	emitted := make(chan agent.UserQuestionRequest, 1)
	done := make(chan error, 1)
	go func() {
		_, err := g.requestAnswer(ctx, "turn", testUserQuestions(), func(q agent.UserQuestionRequest) error { emitted <- q; return nil })
		done <- err
	}()
	q := <-emitted
	answer := agent.UserQuestionAnswer{Answers: map[string]string{"target": "宿主 nginx（host_nginx）"}}
	var saved int
	persist := func(agent.UserQuestionRequest, agent.UserQuestionAnswer) error { saved++; return nil }
	for _, in := range []struct {
		turn, id string
		answer   agent.UserQuestionAnswer
	}{{"wrong", q.ID, answer}, {"turn", "old", answer}, {"turn", q.ID, agent.UserQuestionAnswer{}}, {"turn", q.ID, agent.UserQuestionAnswer{Answers: map[string]string{"other": "value"}}}} {
		if err := g.respond(in.turn, in.id, in.answer, persist); err == nil {
			t.Fatal("invalid response accepted")
		}
	}
	if saved != 0 {
		t.Fatal("invalid response persisted")
	}
	if err := g.respond("turn", q.ID, answer, persist); err != nil {
		t.Fatal(err)
	}
	if err := g.respond("turn", q.ID, answer, persist); err == nil {
		t.Fatal("duplicate response accepted")
	}
	if err := <-done; err != nil || saved != 1 {
		t.Fatalf("err=%v saved=%d", err, saved)
	}
}

func TestQuestionGateCloseCancelsWait(t *testing.T) {
	g := &bridgeQuestionGate{}
	emitted := make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() {
		_, err := g.requestAnswer(context.Background(), "turn", testUserQuestions(), func(agent.UserQuestionRequest) error { emitted <- struct{}{}; return nil })
		done <- err
	}()
	<-emitted
	g.close()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("question did not cancel")
	}
}

func TestBridgeQuestionsContinueSameTurnAndSurviveReopen(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "question lake", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	var modelCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		call := modelCalls.Add(1)
		if call == 1 {
			tools, _ := json.Marshal(body["tools"])
			if !bytes.Contains(tools, []byte("lake_ask_user")) {
				t.Error("question tool not advertised")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"content": []any{map[string]any{"type": "tool_use", "id": "question-tool", "name": "lake_ask_user", "input": testUserQuestions()}}, "stop_reason": "tool_use"})
			return
		}
		messages, _ := json.Marshal(body["messages"])
		if !bytes.Contains(messages, []byte("host_nginx")) {
			t.Errorf("call %d lost answer context", call)
		}
		_, _ = io.WriteString(w, `{"content":[{"type":"text","text":"continue with chosen target"}],"stop_reason":"end_turn"}`)
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{Model: "question-model", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL, WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	input, send := io.Pipe()
	output, write := io.Pipe()
	events := make(chan bridgeEvent, 64)
	go func() {
		decoder := json.NewDecoder(output)
		for {
			var event bridgeEvent
			if decoder.Decode(&event) != nil {
				return
			}
			events <- event
		}
	}()
	done := make(chan error, 1)
	go func() { done <- runBridgeConversation(ctx, root, conversation.ID, input, write); write.Close() }()
	next := func() bridgeEvent {
		select {
		case event := <-events:
			return event
		case <-ctx.Done():
			t.Fatal(ctx.Err())
			return bridgeEvent{}
		}
	}
	if event := next(); event.Type != "ready" {
		t.Fatal(event)
	}
	encoder := json.NewEncoder(send)
	if err := encoder.Encode(bridgeRequest{Type: "ask", ID: "current-turn", Prompt: "choose nginx target"}); err != nil {
		t.Fatal(err)
	}
	var question bridgeEvent
	for {
		event := next()
		if event.Type == "result" {
			t.Fatal("turn ended before answer")
		}
		if event.Type == "question" {
			question = event
			break
		}
	}
	turns, err := s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 0 {
		t.Fatal("question saved as final turn", err)
	}
	for _, request := range []bridgeRequest{{Type: "question_answer", ID: "old-turn", QuestionID: question.Question.ID, Answers: map[string]string{"target": "host_nginx"}}, {Type: "question_answer", ID: "current-turn", QuestionID: question.Question.ID, Answers: map[string]string{}}} {
		if err := encoder.Encode(request); err != nil {
			t.Fatal(err)
		}
		for {
			event := next()
			if event.Type == "question_error" {
				break
			}
			if event.Type == "result" {
				t.Fatal("invalid answer ended turn")
			}
		}
	}
	if modelCalls.Load() != 1 {
		t.Fatal("model resumed without an answer")
	}
	if err := encoder.Encode(bridgeRequest{Type: "question_answer", ID: "current-turn", QuestionID: question.Question.ID, Answers: map[string]string{"target": "宿主 nginx（host_nginx）"}}); err != nil {
		t.Fatal(err)
	}
	for {
		event := next()
		if event.Type == "result" {
			if event.ID != "current-turn" || event.Error != "" {
				t.Fatal(event)
			}
			break
		}
	}
	if modelCalls.Load() != 2 {
		t.Fatal("question did not continue same run")
	}
	if err := encoder.Encode(bridgeRequest{Type: "close"}); err != nil {
		t.Fatal(err)
	}
	send.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	output.Close()
	persisted, err := s.ListAgentEvents(ctx, conversation.ID, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, event := range persisted {
		counts[event.Kind]++
	}
	if counts["user"] != 1 || counts["question_asked"] != 1 || counts["question_answered"] != 1 || counts["answer_finished"] != 1 {
		t.Fatalf("unexpected timeline: %v", counts)
	}
	turns, err = s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 1 {
		t.Fatal("question created extra turns", err)
	}
	var reopened bytes.Buffer
	if err := runBridgeConversation(ctx, root, conversation.ID, strings.NewReader("{\"type\":\"ask\",\"id\":\"next-turn\",\"prompt\":\"continue previous choice\"}\n"), &reopened); err != nil {
		t.Fatal(err)
	}
	if modelCalls.Load() != 3 {
		t.Fatal("reopen did not execute")
	}
}
