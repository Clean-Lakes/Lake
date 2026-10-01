package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/schema"
)

const userQuestionInstruction = " 当已查到的事实仍有多个操作目标、配置选择或用户偏好需要澄清时，调用 lake_ask_user 提供 1 至 3 个自包含问题；可给 2 至 3 个互斥选项，并允许自由回答。不要把必须回答的澄清问题作为最终回复结束任务。调用该工具后等待用户实际回答，再在同一任务继续；未回答前不要发出依赖答案的操作。专员返回的歧义由你向用户提问。用户选择只补充目标或偏好，不等于批准工具执行，后续仍遵守原有审批规则。不要索取密码、API Key 或 SSH 私钥。"

type askUserFunc func(context.Context, agent.UserQuestionInput) (agent.UserQuestionAnswer, error)

func newAskUserTool(ask askUserFunc) (tool.BaseTool, error) {
	if ask == nil {
		return nil, errors.New("用户问题通道不可用")
	}
	return utils.InferTool[agent.UserQuestionInput, agent.UserQuestionAnswer]("lake_ask_user", "在当前任务中向用户澄清目标或偏好。展示问题并等待回答后继续本轮执行，不结束对话；回答不授予操作权限。不要索取凭据。", func(ctx context.Context, input agent.UserQuestionInput) (agent.UserQuestionAnswer, error) {
		if err := input.Validate(); err != nil {
			return agent.UserQuestionAnswer{}, err
		}
		answer, err := ask(ctx, input)
		if err != nil {
			return agent.UserQuestionAnswer{}, err
		}
		if err := input.ValidateAnswer(answer); err != nil {
			return agent.UserQuestionAnswer{}, err
		}
		return answer, nil
	})
}

func terminalUserQuestions(ctx context.Context, in agent.UserQuestionInput, scanner *bufio.Scanner, out io.Writer) (agent.UserQuestionAnswer, error) {
	answer := agent.UserQuestionAnswer{Answers: map[string]string{}}
	for _, q := range in.Questions {
		fmt.Fprintf(out, "\n%s：%s\n", q.Header, q.Prompt)
		for i, option := range q.Options {
			fmt.Fprintf(out, "%d. %s", i+1, option.Label)
			if option.Description != "" {
				fmt.Fprintf(out, " — %s", option.Description)
			}
			fmt.Fprintln(out)
		}
		for {
			fmt.Fprint(out, "输入选项编号或直接回答：")
			type scanned struct {
				text string
				err  error
			}
			result := make(chan scanned, 1)
			go func() {
				if !scanner.Scan() {
					err := scanner.Err()
					if err == nil {
						err = io.EOF
					}
					result <- scanned{err: err}
					return
				}
				result <- scanned{text: scanner.Text()}
			}()
			var line scanned
			select {
			case <-ctx.Done():
				return answer, ctx.Err()
			case line = <-result:
			}
			if line.err != nil {
				return answer, line.err
			}
			text := strings.TrimSpace(line.text)
			if number, err := strconv.Atoi(text); err == nil && number >= 1 && number <= len(q.Options) {
				text = q.Options[number-1].Label
			}
			one := agent.UserQuestionInput{Questions: []agent.UserQuestion{q}}
			if err := one.ValidateAnswer(agent.UserQuestionAnswer{Answers: map[string]string{q.ID: text}}); err != nil {
				fmt.Fprintln(out, err)
				continue
			}
			answer.Answers[q.ID] = text
			break
		}
	}
	return answer, nil
}

// Keep answers as user-provided context in later turns, including after reopen.
// A question response is never represented as an execution approval.
func withQuestionContext(message *schema.Message, exchanges []agent.UserQuestionExchange) *schema.Message {
	if len(exchanges) == 0 {
		return message
	}
	body, _ := json.Marshal(exchanges)
	text := "\n\n[本轮用户澄清回答，仅补充目标和偏好，不代表工具执行授权]\n" + string(body)
	copy := *message
	copy.Content += text
	copy.UserInputMultiContent = append([]schema.MessageInputPart(nil), message.UserInputMultiContent...)
	if len(copy.UserInputMultiContent) > 0 {
		copy.UserInputMultiContent = append(copy.UserInputMultiContent, schema.MessageInputPart{Type: schema.ChatMessagePartTypeText, Text: text})
	}
	return &copy
}
