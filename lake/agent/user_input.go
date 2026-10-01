package agent

import (
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"
)

type UserQuestionOption struct {
	Label       string `json:"label" jsonschema:"description=简短选项文字，可标注推荐"`
	Description string `json:"description,omitempty" jsonschema:"description=选择该选项的影响或区别"`
}

type UserQuestion struct {
	ID      string               `json:"id" jsonschema:"description=批次内唯一的英文小写标识"`
	Header  string               `json:"header" jsonschema:"description=问题的简短标题"`
	Prompt  string               `json:"prompt" jsonschema:"description=完整、自包含的问题，说明当前已知事实"`
	Options []UserQuestionOption `json:"options,omitempty" jsonschema:"description=可省略或提供2至3个互斥选项，推荐项放第一位；用户始终可自由回答"`
}

type UserQuestionInput struct {
	Questions []UserQuestion `json:"questions" jsonschema:"description=本次必须由用户决定的1至3个问题；不要索取密码或密钥"`
}

type UserQuestionRequest struct {
	ID string `json:"id"`
	UserQuestionInput
}

type UserQuestionAnswer struct {
	Answers map[string]string `json:"answers"`
}

type UserQuestionExchange struct {
	Questions []UserQuestion    `json:"questions"`
	Answers   map[string]string `json:"answers"`
}

var questionIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
var questionKeyPattern = regexp.MustCompile(`\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}`)

func validQuestionText(text string, limit int) bool {
	return utf8.ValidString(text) && strings.TrimSpace(text) != "" && utf8.RuneCountInString(text) <= limit && !strings.ContainsRune(text, 0)
}

func questionCredential(text string) bool {
	upper := strings.ToUpper(text)
	return strings.Contains(upper, "PRIVATE KEY-----") || strings.Contains(upper, "AUTHORIZATION:") || strings.Contains(upper, "BEARER ") || strings.Contains(upper, "API_KEY=") || strings.Contains(upper, "API-KEY:") || questionKeyPattern.MatchString(text)
}

func (in UserQuestionInput) Validate() error {
	if len(in.Questions) < 1 || len(in.Questions) > 3 {
		return errors.New("每次澄清需要 1 至 3 个问题")
	}
	ids := map[string]bool{}
	for _, q := range in.Questions {
		if !questionIDPattern.MatchString(q.ID) || ids[q.ID] || !validQuestionText(q.Header, 48) || !validQuestionText(q.Prompt, 1200) || questionCredential(q.Header+" "+q.Prompt) {
			return errors.New("问题标识、标题或内容无效；不要在问题中包含凭据")
		}
		ids[q.ID] = true
		if len(q.Options) != 0 && (len(q.Options) < 2 || len(q.Options) > 3) {
			return errors.New("问题选项须省略或提供 2 至 3 项")
		}
		labels := map[string]bool{}
		for _, option := range q.Options {
			if !validQuestionText(option.Label, 120) || labels[option.Label] || (option.Description != "" && !validQuestionText(option.Description, 512)) || questionCredential(option.Label+" "+option.Description) {
				return errors.New("问题选项重复、过长或包含凭据")
			}
			labels[option.Label] = true
		}
	}
	return nil
}

func (in UserQuestionInput) ValidateAnswer(answer UserQuestionAnswer) error {
	if err := in.Validate(); err != nil {
		return err
	}
	if len(answer.Answers) != len(in.Questions) {
		return errors.New("请回答本次全部问题，不要加入其他问题的回答")
	}
	if err := answer.Validate(); err != nil {
		return err
	}
	for _, q := range in.Questions {
		if !validQuestionText(answer.Answers[q.ID], 2048) || questionCredential(answer.Answers[q.ID]) {
			return errors.New("回答不能为空、超过 2048 字或包含凭据；请勿填写密码和密钥")
		}
	}
	return nil
}

func (answer UserQuestionAnswer) Validate() error {
	if len(answer.Answers) < 1 || len(answer.Answers) > 3 {
		return errors.New("回答需要 1 至 3 个问题")
	}
	for id, text := range answer.Answers {
		if !questionIDPattern.MatchString(id) || !validQuestionText(text, 2048) || questionCredential(text) {
			return errors.New("回答标识或内容无效；请勿填写密码和密钥")
		}
	}
	return nil
}
