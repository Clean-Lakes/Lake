package main

import (
	"bufio"
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/schema"
)

func TestTerminalQuestionsAcceptOptionAndPreserveContext(t *testing.T) {
	var out bytes.Buffer
	answer, err := terminalUserQuestions(context.Background(), testUserQuestions(), bufio.NewScanner(strings.NewReader("\n1\n")), &out)
	if err != nil || answer.Answers["target"] != "宿主 nginx（host_nginx）" {
		t.Fatalf("answer=%v err=%v", answer, err)
	}
	message := schema.UserMessage("choose target")
	contextMessage := withQuestionContext(message, []agent.UserQuestionExchange{{Questions: testUserQuestions().Questions, Answers: answer.Answers}})
	if !strings.Contains(contextMessage.Content, "host_nginx") || message.Content != "choose target" {
		t.Fatal("context lost or source mutated")
	}
}
