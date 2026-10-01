package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/pelletier/go-toml/v2"
	"golang.org/x/term"

	"github.com/cloudwego/eino/lake/credential"
)

type providerConfig struct {
	BaseURL string `toml:"base_url"`
	WireAPI string `toml:"wire_api"`
}

type lakeModelConfig struct {
	Model                 string                    `toml:"model"`
	ModelProvider         string                    `toml:"model_provider"`
	WebSearchEndpoint     string                    `toml:"web_search_endpoint,omitempty"`
	WebAllowedDomains     []string                  `toml:"web_allowed_domains,omitempty"`
	ModelReasoningEffort  string                    `toml:"model_reasoning_effort,omitempty"`
	ContextWindow         int                       `toml:"context_window,omitempty"`
	MaxOutputTokens       int                       `toml:"max_output_tokens,omitempty"`
	AutoCompactTokenLimit int                       `toml:"model_auto_compact_token_limit,omitempty"`
	ModelCatalog          map[string]string         `toml:"model_catalog,omitempty"`
	ModelProviders        map[string]providerConfig `toml:"model_providers"`
}

type modelEntry struct {
	Name     string `json:"name"`
	Provider string `json:"provider"`
}

type stringFlags []string

func (s *stringFlags) String() string { return strings.Join(*s, ",") }
func (s *stringFlags) Set(v string) error {
	*s = append(*s, v)
	return nil
}

type chatOptions struct {
	Model     string
	Profile   string
	Workspace string
	Config    stringFlags
	Prompt    string
}

func parseChatOptions(args []string, stderr io.Writer) (chatOptions, error) {
	var opts chatOptions
	f := flag.NewFlagSet("lake", flag.ContinueOnError)
	f.SetOutput(stderr)
	f.StringVar(&opts.Model, "m", "", "模型名称")
	f.StringVar(&opts.Model, "model", "", "模型名称")
	f.StringVar(&opts.Profile, "p", "", "配置档名称")
	f.StringVar(&opts.Profile, "profile", "", "配置档名称")
	f.StringVar(&opts.Workspace, "C", "", "代码项目目录")
	f.StringVar(&opts.Workspace, "cd", "", "代码项目目录")
	f.Var(&opts.Config, "c", "覆盖模型配置 key=value，可重复")
	f.Var(&opts.Config, "config", "覆盖模型配置 key=value，可重复")
	if err := f.Parse(args); err != nil {
		return opts, err
	}
	opts.Prompt = strings.Join(f.Args(), " ")
	return opts, nil
}

func loadModelConfig(root string, opts chatOptions) (lakeModelConfig, error) {
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return lakeModelConfig{}, err
		}
		root = filepath.Join(home, ".lake")
	}
	config := lakeModelConfig{ModelProviders: make(map[string]providerConfig)}
	if err := readConfigFile(filepath.Join(root, "config.toml"), &config, false); err != nil {
		return config, err
	}
	if opts.Profile != "" {
		for _, r := range opts.Profile {
			if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
				return config, errors.New("无效的配置档名称")
			}
		}
		if err := readConfigFile(filepath.Join(root, opts.Profile+".config.toml"), &config, true); err != nil {
			return config, err
		}
	}
	for _, override := range opts.Config {
		if err := applyModelOverride(&config, override); err != nil {
			return config, err
		}
	}
	if opts.Model != "" {
		config.Model = opts.Model
		if provider, ok := config.ModelCatalog[opts.Model]; ok {
			config.ModelProvider = provider
		}
	}
	if config.Model == "" || config.ModelProvider == "" {
		return config, errors.New("模型尚未配置；请运行 lake model configure")
	}
	provider, ok := config.ModelProviders[config.ModelProvider]
	if !ok || provider.BaseURL == "" {
		return config, errors.New("模型提供方缺少 base_url")
	}
	if provider.WireAPI == "" {
		provider.WireAPI = "anthropic"
		config.ModelProviders[config.ModelProvider] = provider
	}
	if !validWireAPI(provider.WireAPI) {
		return config, fmt.Errorf("暂不支持模型协议 %q", provider.WireAPI)
	}
	if config.ContextWindow == 0 {
		config.ContextWindow = 32000
	}
	if config.MaxOutputTokens == 0 {
		config.MaxOutputTokens = 4096
	}
	if config.ContextWindow < 1024 || config.ContextWindow > 1000000 || config.MaxOutputTokens < 1 || config.MaxOutputTokens >= config.ContextWindow {
		return config, errors.New("模型上下文窗口与最大输出 Token 配置无效")
	}
	if config.AutoCompactTokenLimit < 0 || config.AutoCompactTokenLimit > config.ContextWindow-config.MaxOutputTokens {
		return config, errors.New("自动压缩阈值必须在模型输入预算内；0表示使用默认阈值")
	}
	return config, nil
}

func validWireAPI(value string) bool {
	return value == "anthropic" || value == "openai_chat" || value == "openai_responses"
}

func readConfigFile(path string, config *lakeModelConfig, required bool) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) && !required {
		ensureModelCatalog(config)
		return nil
	}
	if err != nil {
		return fmt.Errorf("读取模型配置 %s: %w", path, err)
	}
	if err := toml.Unmarshal(data, config); err != nil {
		return fmt.Errorf("解析模型配置 %s: %w", path, err)
	}
	if config.ModelProviders == nil {
		config.ModelProviders = make(map[string]providerConfig)
	}
	ensureModelCatalog(config)
	return nil
}

func ensureModelCatalog(config *lakeModelConfig) {
	if config.ModelCatalog == nil {
		config.ModelCatalog = make(map[string]string)
	}
	if config.Model != "" && config.ModelProvider != "" {
		if _, exists := config.ModelCatalog[config.Model]; !exists {
			config.ModelCatalog[config.Model] = config.ModelProvider
		}
	}
}

func validModelName(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, ch := range value {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || strings.ContainsRune("._:/-", ch)) {
			return false
		}
	}
	return true
}

func configuredModels(config lakeModelConfig) []modelEntry {
	ensureModelCatalog(&config)
	models := make([]modelEntry, 0, len(config.ModelCatalog))
	for name, provider := range config.ModelCatalog {
		models = append(models, modelEntry{Name: name, Provider: provider})
	}
	sort.Slice(models, func(i, j int) bool { return models[i].Name < models[j].Name })
	return models
}

func applyModelOverride(config *lakeModelConfig, value string) error {
	key, raw, ok := strings.Cut(value, "=")
	if !ok || key == "" {
		return errors.New("-c 格式应为 key=value")
	}
	raw = strings.TrimSpace(raw)
	var parsed struct {
		Value string `toml:"value"`
	}
	if err := toml.Unmarshal([]byte("value = "+raw), &parsed); err != nil {
		parsed.Value = raw
	}
	switch key {
	case "model":
		config.Model = parsed.Value
	case "model_provider":
		config.ModelProvider = parsed.Value
	case "model_reasoning_effort":
		config.ModelReasoningEffort = parsed.Value
	case "model_auto_compact_token_limit":
		amount, err := strconv.Atoi(parsed.Value)
		if err != nil || amount < 0 {
			return errors.New("自动压缩阈值必须为非负整数")
		}
		config.AutoCompactTokenLimit = amount
	case "context_window", "max_output_tokens":
		amount, err := strconv.Atoi(parsed.Value)
		if err != nil || amount < 1 {
			return fmt.Errorf("模型配置项 %s 必须为正整数", key)
		}
		if key == "context_window" {
			config.ContextWindow = amount
		} else {
			config.MaxOutputTokens = amount
		}
	default:
		parts := strings.Split(key, ".")
		if len(parts) != 3 || parts[0] != "model_providers" {
			return fmt.Errorf("不支持的模型配置项 %q", key)
		}
		p := config.ModelProviders[parts[1]]
		switch parts[2] {
		case "base_url":
			p.BaseURL = parsed.Value
		case "wire_api":
			p.WireAPI = parsed.Value
		default:
			return fmt.Errorf("不支持的模型配置项 %q", key)
		}
		config.ModelProviders[parts[1]] = p
	}
	return nil
}

func modelCommand(args []string, root string, input io.Reader, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("用法：lake model configure|add|ls|use|login")
	}
	switch args[0] {
	case "configure":
		f := flags("lake model configure", errOut)
		provider := f.String("provider", "mimo", "模型提供方名称")
		modelName := f.String("model", "", "模型名称")
		baseURL := f.String("base-url", "", "API Base URL")
		wireAPI := f.String("wire-api", "anthropic", "协议")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 || !validModelName(*modelName) || *baseURL == "" || !validWireAPI(*wireAPI) {
			return errors.New("用法：lake model configure --model 名称 --base-url URL [--provider mimo] [--wire-api anthropic|openai_chat|openai_responses]")
		}
		if !validProviderName(*provider) {
			return errors.New("无效的模型提供方名称")
		}
		configRoot := root
		if configRoot == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return err
			}
			configRoot = filepath.Join(home, ".lake")
		}
		cfg := lakeModelConfig{ModelProviders: make(map[string]providerConfig)}
		if err := readConfigFile(filepath.Join(configRoot, "config.toml"), &cfg, false); err != nil {
			return err
		}
		cfg.Model, cfg.ModelProvider = *modelName, *provider
		cfg.ModelProviders[*provider] = providerConfig{BaseURL: *baseURL, WireAPI: *wireAPI}
		cfg.ModelCatalog[*modelName] = *provider
		if err := saveModelConfig(root, cfg); err != nil {
			return err
		}
		_, err := fmt.Fprintf(out, "已配置模型 %s（%s）\n", cfg.Model, cfg.ModelProvider)
		return err
	case "add":
		f := flags("lake model add", errOut)
		provider := f.String("provider", "", "模型提供方名称")
		modelName := f.String("model", "", "模型名称")
		baseURL := f.String("base-url", "", "API Base URL；已有提供方可省略")
		wireAPI := f.String("wire-api", "", "协议；已有提供方可省略")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 || !validProviderName(*provider) || !validModelName(*modelName) || (*wireAPI != "" && !validWireAPI(*wireAPI)) {
			return errors.New("用法：lake model add --provider 名称 --model 名称 [--base-url URL] [--wire-api anthropic|openai_chat|openai_responses]")
		}
		cfg, err := readSavedModelConfig(root)
		if err != nil {
			return err
		}
		if current, exists := cfg.ModelCatalog[*modelName]; exists && current != *provider {
			return fmt.Errorf("模型 %s 已属于提供方 %s", *modelName, current)
		}
		p := cfg.ModelProviders[*provider]
		if *baseURL != "" {
			p.BaseURL = *baseURL
		}
		if p.BaseURL == "" {
			return errors.New("新提供方需要 --base-url")
		}
		if *wireAPI != "" {
			p.WireAPI = *wireAPI
		}
		if p.WireAPI == "" {
			p.WireAPI = "anthropic"
		}
		cfg.ModelProviders[*provider] = p
		cfg.ModelCatalog[*modelName] = *provider
		if err := saveModelConfig(root, cfg); err != nil {
			return err
		}
		_, err = fmt.Fprintf(out, "已添加模型 %s（%s）；当前模型仍为 %s\n", *modelName, *provider, cfg.Model)
		return err
	case "ls":
		f := flags("lake model ls", errOut)
		asJSON := f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 {
			return errors.New("用法：lake model ls [--json]")
		}
		cfg, err := readSavedModelConfig(root)
		if err != nil {
			return err
		}
		models := configuredModels(cfg)
		if *asJSON {
			return json.NewEncoder(out).Encode(map[string]any{"current": cfg.Model, "models": models})
		}
		for _, item := range models {
			marker := " "
			if item.Name == cfg.Model {
				marker = "*"
			}
			if _, err := fmt.Fprintf(out, "%s %s (%s)\n", marker, item.Name, item.Provider); err != nil {
				return err
			}
		}
		return nil
	case "use":
		if len(args) != 2 {
			return errors.New("用法：lake model use <模型名>")
		}
		cfg, err := readSavedModelConfig(root)
		if err != nil {
			return err
		}
		provider, exists := cfg.ModelCatalog[args[1]]
		if !exists {
			return fmt.Errorf("模型 %s 尚未添加", args[1])
		}
		cfg.Model, cfg.ModelProvider = args[1], provider
		if err := saveModelConfig(root, cfg); err != nil {
			return err
		}
		_, err = fmt.Fprintf(out, "当前模型：%s（%s）\n", cfg.Model, cfg.ModelProvider)
		return err
	case "login":
		f := flags("lake model login", errOut)
		provider := f.String("provider", "mimo", "模型提供方名称")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 || !validProviderName(*provider) {
			return errors.New("用法：lake model login [--provider mimo]")
		}
		if _, err := io.WriteString(errOut, "API Key: "); err != nil {
			return err
		}
		key, err := readSecret(input)
		if err != nil {
			return err
		}
		defer clearBytes(key)
		if len(key) == 0 {
			return errors.New("API Key 不能为空")
		}
		if err := (credential.FileVault{Root: root}).PutModelAPIKey(*provider, key); err != nil {
			return err
		}
		_, err = fmt.Fprintf(out, "已将 %s 的 API Key 保存到 Lake 本地凭据目录\n", *provider)
		return err
	default:
		return fmt.Errorf("未知模型命令 %q", args[0])
	}
}

func readSavedModelConfig(root string) (lakeModelConfig, error) {
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return lakeModelConfig{}, err
		}
		root = filepath.Join(home, ".lake")
	}
	cfg := lakeModelConfig{ModelProviders: make(map[string]providerConfig), ModelCatalog: make(map[string]string)}
	if err := readConfigFile(filepath.Join(root, "config.toml"), &cfg, false); err != nil {
		return cfg, err
	}
	ensureModelCatalog(&cfg)
	return cfg, nil
}

func readSecret(input io.Reader) ([]byte, error) {
	if file, ok := input.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		key, err := term.ReadPassword(int(file.Fd()))
		fmt.Fprintln(os.Stderr)
		return bytesTrimSpace(key), err
	}
	line, err := bufio.NewReader(io.LimitReader(input, 65537)).ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return bytesTrimSpace(line), nil
}

func bytesTrimSpace(value []byte) []byte {
	return bytes.TrimSpace(value)
}

func validProviderName(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func saveModelConfig(root string, config lakeModelConfig) error {
	ensureModelCatalog(&config)
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		root = filepath.Join(home, ".lake")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	data, err := toml.Marshal(config)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(root, ".config-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err := file.Chmod(0600); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), filepath.Join(root, "config.toml"))
}
