export type ProviderPreset = {id:string;name:string;subtitle:string;baseURL:string;protocol:string;docs:string};

// Public API endpoints checked against each provider's documentation (2026-10-15).
// Model IDs always come from the configured API, never from these presets.
export const providerPresets:ProviderPreset[] = [
  {id:"openai",name:"OpenAI",subtitle:"GPT 系列",baseURL:"https://api.openai.com/v1",protocol:"openai-response",docs:"https://platform.openai.com/docs/api-reference/models/list"},
  {id:"anthropic",name:"Anthropic",subtitle:"Claude 系列",baseURL:"https://api.anthropic.com/v1",protocol:"claude",docs:"https://platform.claude.com/docs/en/api/overview"},
  {id:"gemini",name:"Google Gemini",subtitle:"Gemini 系列",baseURL:"https://generativelanguage.googleapis.com/v1beta",protocol:"gemini",docs:"https://ai.google.dev/api/models"},
  {id:"deepseek",name:"DeepSeek",subtitle:"DeepSeek 系列",baseURL:"https://api.deepseek.com/v1",protocol:"openai",docs:"https://api-docs.deepseek.com/"},
  {id:"qwen",name:"通义千问",subtitle:"阿里云百炼 · 北京",baseURL:"https://dashscope.aliyuncs.com/compatible-mode/v1",protocol:"openai",docs:"https://help.aliyun.com/en/model-studio/base-url"},
  {id:"glm",name:"智谱 GLM",subtitle:"BigModel 开放平台",baseURL:"https://open.bigmodel.cn/api/paas/v4",protocol:"openai",docs:"https://docs.bigmodel.cn/cn/api/introduction"},
  {id:"kimi",name:"Kimi",subtitle:"月之暗面 · 中国区",baseURL:"https://api.moonshot.cn/v1",protocol:"openai",docs:"https://platform.kimi.com/blog/posts/kimi-api-quick-start-guide"},
  {id:"mimo",name:"小米 MiMo",subtitle:"MiMo 开放平台",baseURL:"https://api.xiaomimimo.com/v1",protocol:"openai",docs:"https://mimo.mi.com/docs/zh-CN/api/model/list-models"},
  {id:"minimax",name:"MiniMax",subtitle:"MiniMax 开放平台 · 中国区",baseURL:"https://api.minimax.cn/v1",protocol:"openai",docs:"https://platform.minimax.cn/docs/api-reference/text-openai-api"},
  {id:"siliconflow",name:"硅基流动",subtitle:"多厂商模型 · 中国区",baseURL:"https://api.siliconflow.cn/v1",protocol:"openai",docs:"https://docs.siliconflow.cn/docs/userguide/quickstart"},
  {id:"openrouter",name:"OpenRouter",subtitle:"多厂商模型聚合",baseURL:"https://openrouter.ai/api/v1",protocol:"openai",docs:"https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties"},
  {id:"ollama",name:"本地 Ollama",subtitle:"使用本机已下载的模型",baseURL:"http://127.0.0.1:11434",protocol:"ollama",docs:"https://docs.ollama.com/api/tags"},
];
export const customProviderPreset:ProviderPreset = {id:"custom",name:"自定义供应商",subtitle:"填写 API 地址与密钥，获取可用模型",baseURL:"",protocol:"openai",docs:""};
