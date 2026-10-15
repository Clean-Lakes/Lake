import assert from "node:assert/strict";
import test from "node:test";
import {modelBrand} from "../src/modelBrand";

test("chat models resolve their manufacturer through routing and aggregation",()=>{
  for(const [name,brand] of [["group/auto-gpt-6.1-sol","openai"],["anthropic/claude-sonnet-4","anthropic"],["google/gemini-2.5-pro","gemini"],["xiaomi/mimo-v2.6-flash","mimo"],["deepseek-ai/DeepSeek-V3","deepseek"],["Qwen/Qwen3-32B","qwen"],["z-ai/glm-4.5","glm"],["moonshotai/kimi-k2","kimi"],["MiniMax-M2","minimax"],["o3-mini","openai"],["x-ai/grok-4","xai"],["meta-llama/Llama-4-Maverick","meta"],["mistralai/codestral-latest","mistral"],["doubao-seed-1.6","doubao"],["tencent/Hunyuan-A13B","hunyuan"],["cohere/command-r-plus","cohere"],["step-3.5-flash","stepfun"],["ernie-4.5","baidu"]]) assert.equal(modelBrand(name,"","OpenRouter"),brand,name);
});
test("model identity takes precedence over display names and API sources",()=>{
  assert.equal(modelBrand("claude-sonnet-4","GPT replacement","OpenAI"),"anthropic");
  assert.equal(modelBrand("custom-id","Gemini Pro","OpenRouter"),"gemini");
  assert.equal(modelBrand("custom-model","","本地 Ollama"),"custom");
  assert.equal(modelBrand("custom-model","","OpenRouter"),"custom");
  assert.equal(modelBrand("custom-model","","OpenAI"),"openai");
  assert.equal(modelBrand("not-gpt-model","","Unknown proxy"),"custom");
  assert.equal(modelBrand("myclaudeclone"),"custom");
});

test("human Magpie labels retain their manufacturer before slash-separated routing notes",()=>{
  assert.equal(modelBrand("route/opaque-model","Claude Sonnet / EU routing","Magpie"),"anthropic");
  assert.equal(modelBrand("route/opaque-model","Gemini Pro / batch","Magpie"),"gemini");
  assert.equal(modelBrand("route/opaque-model","GPT-6.1-Sol / routing group","Magpie"),"openai");
  assert.equal(modelBrand("gpt-gateway/custom","gpt-gateway/custom","Magpie"),"custom");
});
