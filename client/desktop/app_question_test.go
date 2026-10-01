package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

type questionBuffer struct{ bytes.Buffer }

func (*questionBuffer) Close() error { return nil }

func TestAnswerQuestionUsesCurrentRunBridgeWithoutStartingTurn(t *testing.T) {
	input := &questionBuffer{}
	a := &App{stdin: input}
	if err := a.AnswerQuestion("turn", "question", map[string]string{"target": "宿主"}); err != nil {
		t.Fatal(err)
	}
	var request map[string]any
	if err := json.Unmarshal(input.Bytes(), &request); err != nil {
		t.Fatal(err)
	}
	if request["type"] != "question_answer" || request["id"] != "turn" || request["question_id"] != "question" {
		t.Fatal(request)
	}
	before := input.Len()
	if err := a.AnswerQuestion("turn", "question", map[string]string{"target": ""}); err == nil || input.Len() != before {
		t.Fatal("invalid answer was written")
	}
}

func TestReformatResultUsesReviewOnlyBridge(t *testing.T) {
	input := &questionBuffer{}
	a := &App{stdin: input}
	if err := a.ReformatResult("review", "整理已有结果"); err != nil {
		t.Fatal(err)
	}
	var request map[string]any
	if err := json.Unmarshal(input.Bytes(), &request); err != nil {
		t.Fatal(err)
	}
	if request["type"] != "ask" || request["review_only"] != true || request["id"] != "review" {
		t.Fatal(request)
	}
	before := input.Len()
	if err := a.ReformatResult("review", " "); err == nil || input.Len() != before {
		t.Fatal("empty review request was written")
	}
}
