package lakeadk

import (
	lakeai "github.com/Clean-Lakes/Lake/internal/ai"
	"google.golang.org/adk/v2/model"
	"google.golang.org/genai"
)

// LakeLLM is the official ADK model adapter shared by every Lake entrypoint.
type LakeLLM = lakeai.ProviderLLM

func NewLakeLLM(m lakeai.Model) *LakeLLM { return lakeai.NewProviderLLM(m) }
func lakeRequest(req *model.LLMRequest) ([]lakeai.Message, []lakeai.Tool, error) {
	return lakeai.ADKRequest(req)
}
func lakeTools(req *model.LLMRequest) []lakeai.Tool { return lakeai.ADKTools(req) }
func lakeResponse(msg lakeai.Message, usage lakeai.Usage, name string) (*model.LLMResponse, error) {
	return lakeai.ADKResponse(msg, usage, name)
}
func contentText(content *genai.Content) string { return lakeai.ADKContentText(content) }
