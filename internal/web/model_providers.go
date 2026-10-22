package web

import (
	"encoding/json"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

type ProviderModel struct {
	ID                  string                  `json:"id"`
	Name                string                  `json:"name"`
	DisplayName         string                  `json:"displayName,omitempty"`
	Enabled             bool                    `json:"enabled"`
	ContextWindow       int                     `json:"contextWindow,omitempty"`
	SupportsImageInput  bool                    `json:"supportsImageInput"`
	SupportsImageOutput bool                    `json:"supportsImageOutput"`
	ImageInputMode      string                  `json:"imageInputMode,omitempty"`
	ImageInputDetected  *bool                   `json:"imageInputDetected,omitempty"`
	Reasoning           *ai.ReasoningCapability `json:"reasoningCapability,omitempty"`
}

func (model ProviderModel) imageInputMode() string {
	if model.ImageInputMode != "" {
		return model.ImageInputMode
	}
	if model.SupportsImageInput { // Preserve explicit support in legacy catalogs.
		return "on"
	}
	return "auto"
}

func (model ProviderModel) allowsImageInput() bool {
	switch model.imageInputMode() {
	case "on":
		return true
	case "off":
		return false
	default:
		// An unknown capability must not silently strip an attached image.
		return model.ImageInputDetected == nil || *model.ImageInputDetected
	}
}

type ModelProvider struct {
	EndpointURL   string          `json:"endpointURL,omitempty"`
	ID            string          `json:"id"`
	Name          string          `json:"name"`
	BaseURL       string          `json:"baseURL"`
	Protocol      string          `json:"protocol"`
	Enabled       bool            `json:"enabled"`
	Models        []ProviderModel `json:"models"`
	CredentialRef string          `json:"credentialRef,omitempty"`
}
type providerCatalog struct {
	Version          int             `json:"version"`
	Providers        []ModelProvider `json:"providers"`
	ActiveProviderID string          `json:"activeProviderId"`
	ActiveModelID    string          `json:"activeModelId"`
	// Empty preserves automatic Magpie selection for existing installations.
	ActiveSource string `json:"activeSource,omitempty"`
}

var providerIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$`)
var providerVersionPath = regexp.MustCompile(`/v\d+(?:beta\d*|alpha\d*)?$`)

func providerEndpoint(base, protocol string) string {
	base = ai.NormalizeProviderEndpoint(base, protocol)
	validated := endpoint(base, protocol)
	u, err := url.Parse(strings.TrimSpace(base))
	if err != nil {
		fail(400, "Base URL 无效")
	}
	p := strings.TrimRight(u.Path, "/")
	for _, suffix := range []string{"/chat/completions", "/responses", "/messages", "/api/chat", ":streamGenerateContent"} {
		if strings.HasSuffix(p, suffix) {
			return validated
		}
	}
	if protocol == "ollama" {
		if strings.HasSuffix(p, "/api") {
			p += "/chat"
		} else {
			p += "/api/chat"
		}
	} else {
		if !providerVersionPath.MatchString(p) {
			if protocol == "gemini" {
				p += "/v1beta"
			} else {
				p += "/v1"
			}
		}
		p += "/" + map[string]string{"openai": "chat/completions", "azure-gpt": "chat/completions", "openai-response": "responses", "claude": "messages", "gemini": "models/{model}:streamGenerateContent"}[protocol]
	}
	u.Path = p
	return strings.ReplaceAll(u.String(), "%7Bmodel%7D", "{model}")
}
func providerBaseURL(endpoint string) string {
	u, err := url.Parse(endpoint)
	if err != nil {
		return endpoint
	}
	for _, suffix := range []string{"/chat/completions", "/messages", "/responses", "/api/chat", "/models/{model}:streamGenerateContent"} {
		if strings.HasSuffix(u.Path, suffix) {
			u.Path = strings.TrimSuffix(u.Path, suffix)
			return strings.TrimRight(u.String(), "/")
		}
	}
	return endpoint
}

// Preserve complete legacy endpoints, including custom paths that do not follow a protocol suffix.
func providerModelEndpoint(provider *ModelProvider) string {
	if provider.EndpointURL != "" {
		return endpoint(provider.EndpointURL, provider.Protocol)
	}
	return providerEndpoint(provider.BaseURL, provider.Protocol)
}
func (m *Models) readProviderCatalogLocked() (*providerCatalog, bool) {
	data, err := os.ReadFile(filepath.Join(m.Dir, "providers.json"))
	if os.IsNotExist(err) {
		return nil, false
	}
	if err != nil {
		fail(500, "无法读取模型供应商配置")
	}
	var catalog providerCatalog
	if json.Unmarshal(data, &catalog) != nil || catalog.Version != 1 || len(catalog.Providers) > 128 {
		fail(500, "模型供应商配置格式无效，请恢复配置备份")
	}
	for i := range catalog.Providers {
		provider := &catalog.Providers[i]
		if normalized := ai.NormalizeProviderEndpoint(provider.BaseURL, provider.Protocol); normalized != provider.BaseURL {
			provider.BaseURL = providerBaseURL(normalized)
		}
	}
	return &catalog, true
}
func (m *Models) saveProviderCatalogLocked(catalog *providerCatalog) {
	must(platform.MkdirAll(m.Dir, 0700))
	must(platform.Chmod(m.Dir, 0700))
	must(atomicFile(filepath.Join(m.Dir, "providers.json"), []byte(jsonText(catalog)+"\n")))
	m.capacities = nil
}
func (m *Models) saveProviderKeyLocked(key string) string {
	if key == "" {
		return ""
	}
	dir := filepath.Join(m.Home, "secrets")
	must(platform.MkdirAll(dir, 0700))
	info, err := os.Stat(dir)
	if err != nil || !platform.Private(dir, info) {
		fail(400, "Lake 凭据目录权限须为 0700")
	}
	ref := "provider-model-" + ident() + ".key"
	must(atomicFile(filepath.Join(dir, ref), []byte(key)))
	return ref
}
func (m *Models) catalogLocked() *providerCatalog {
	if catalog, exists := m.readProviderCatalogLocked(); exists {
		return catalog
	}
	catalog := &providerCatalog{Version: 1, Providers: []ModelProvider{}}
	legacy := m.legacySaved()
	if legacy == nil {
		legacy = m.environment()
	}
	if legacy != nil {
		providerID, modelID := ident(), ident()
		label := "当前供应商"
		if parsed, err := url.Parse(legacy.URL); err == nil {
			label = parsed.Hostname()
		}
		provider := ModelProvider{ID: providerID, Name: label, BaseURL: providerBaseURL(legacy.URL), Protocol: legacy.Protocol, Enabled: true, EndpointURL: legacy.URL, CredentialRef: m.saveProviderKeyLocked(legacy.Key), Models: []ProviderModel{{ID: modelID, Name: legacy.Name, Enabled: true, SupportsImageInput: legacy.SupportsImageInput, SupportsImageOutput: legacy.SupportsImageOutput}}}
		catalog.Providers = append(catalog.Providers, provider)
		catalog.ActiveProviderID, catalog.ActiveModelID = providerID, modelID
	}
	m.saveProviderCatalogLocked(catalog)
	return catalog
}
func findProvider(catalog *providerCatalog, id string) *ModelProvider {
	for i := range catalog.Providers {
		if catalog.Providers[i].ID == id {
			return &catalog.Providers[i]
		}
	}
	return nil
}
func findProviderModel(provider *ModelProvider, id string) *ProviderModel {
	if provider != nil {
		for i := range provider.Models {
			if provider.Models[i].ID == id {
				return &provider.Models[i]
			}
		}
	}
	return nil
}
func ensureActiveProvider(catalog *providerCatalog) {
	provider := findProvider(catalog, catalog.ActiveProviderID)
	model := findProviderModel(provider, catalog.ActiveModelID)
	if provider != nil && provider.Enabled && model != nil && model.Enabled {
		return
	}
	catalog.ActiveProviderID, catalog.ActiveModelID = "", ""
	for _, provider := range catalog.Providers {
		if provider.Enabled {
			for _, model := range provider.Models {
				if model.Enabled {
					catalog.ActiveProviderID, catalog.ActiveModelID = provider.ID, model.ID
					return
				}
			}
		}
	}
}
func (m *Models) providerKeyLocked(ref string) (string, bool) {
	if ref == "" {
		return "", true
	}
	p, err := privateFile(filepath.Join(m.Home, "secrets"), ref)
	if err != nil {
		return "", false
	}
	data, err := os.ReadFile(p)
	if err != nil || len(data) > 4096 {
		return "", false
	}
	return string(data), true
}
func (m *Models) catalogModelLocked(catalog *providerCatalog) *ai.Model {
	provider := findProvider(catalog, catalog.ActiveProviderID)
	model := findProviderModel(provider, catalog.ActiveModelID)
	if provider == nil || !provider.Enabled || model == nil || !model.Enabled {
		return nil
	}
	key, valid := m.providerKeyLocked(provider.CredentialRef)
	if !valid {
		return nil
	}
	config := &ai.Model{URL: providerModelEndpoint(provider), Name: model.Name, Protocol: provider.Protocol, Key: key, SupportsImageInput: model.allowsImageInput(), SupportsImageOutput: model.SupportsImageOutput, ContextLimit: model.ContextWindow, Reasoning: model.Reasoning}
	if model.ContextWindow > 0 {
		config.ContextLimitSource = "settings"
	}
	return config
}

// Resolve a stored model identity against the current provider catalog and
// credentials without switching the user's active model.
func (m *Models) ResolveModelIdentity(identity string) *ai.Model {
	m.mu.Lock()
	defer m.mu.Unlock()
	if models, _, _ := m.magpieModelsLocked(); len(models) > 0 {
		for _, item := range models {
			if ai.ModelIdentity(item.Model) == identity {
				model := item.Model
				return &model
			}
		}
	}
	catalog, exists := m.readProviderCatalogLocked()
	if !exists {
		model := m.activeLocked()
		if model != nil && ai.ModelIdentity(*model) == identity {
			return model
		}
		return nil
	}
	for _, provider := range catalog.Providers {
		if !provider.Enabled {
			continue
		}
		key, valid := m.providerKeyLocked(provider.CredentialRef)
		if !valid {
			continue
		}
		for _, item := range provider.Models {
			if !item.Enabled {
				continue
			}
			model := &ai.Model{URL: providerModelEndpoint(&provider), Name: item.Name, Protocol: provider.Protocol, Key: key, SupportsImageInput: item.allowsImageInput(), SupportsImageOutput: item.SupportsImageOutput, ContextLimit: item.ContextWindow, Reasoning: item.Reasoning}
			if item.ContextWindow > 0 {
				model.ContextLimitSource = "settings"
			}
			if ai.ModelIdentity(*model) == identity {
				return model
			}
		}
	}
	return nil
}
func (m *Models) publicProviderCatalogLocked(catalog *providerCatalog) Object {
	providers := []Object{}
	for _, provider := range catalog.Providers {
		configured := false
		if provider.CredentialRef != "" {
			_, err := privateFile(filepath.Join(m.Home, "secrets"), provider.CredentialRef)
			configured = err == nil
		}
		providers = append(providers, Object{"id": provider.ID, "name": provider.Name, "baseURL": provider.BaseURL, "protocol": provider.Protocol, "enabled": provider.Enabled, "keyConfigured": configured, "models": provider.Models})
	}
	providerID, modelID := catalog.ActiveProviderID, catalog.ActiveModelID
	if active := m.activeMagpieModelLocked(); active != nil {
		providerID, modelID = "magpie", active.Name
	}
	return Object{"providers": providers, "activeProviderId": providerID, "activeModelId": modelID}
}
func (m *Models) Providers() Object {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.publicProviderCatalogLocked(m.catalogLocked())
}

func validatedProviderReasoning(value any) *ai.ReasoningCapability {
	if value == nil {
		return nil
	}
	data, valid := value.(map[string]any)
	if !valid {
		fail(400, "思考级别配置无效")
	}
	raw, valid := data["levels"].([]any)
	if !valid || len(raw) > 8 {
		fail(400, "思考级别列表无效")
	}
	allowed := set("none minimal low medium high xhigh max ultra")
	levels := make([]string, 0, len(raw))
	seen := map[string]bool{}
	for _, value := range raw {
		level, ok := value.(string)
		if !ok || !allowed[level] || seen[level] {
			fail(400, "思考级别列表无效")
		}
		seen[level] = true
		levels = append(levels, level)
	}
	defaultLevel := stringOf(data["default"])
	if defaultLevel != "" && !seen[defaultLevel] {
		fail(400, "默认思考级别无效")
	}
	source := stringOf(data["source"])
	if source != "" && source != "provider" && source != "model" {
		fail(400, "思考级别来源无效")
	}
	return &ai.ReasoningCapability{Levels: levels, Default: defaultLevel, Source: source}
}

func validatedProviderModels(value any) []ProviderModel {
	rows, ok := value.([]any)
	if !ok || len(rows) > 256 {
		fail(400, "模型列表须为数组，最多 256 个模型")
	}
	models := []ProviderModel{}
	ids, names := map[string]bool{}, map[string]bool{}
	for _, row := range rows {
		data := object(row)
		name := text(data["name"], "模型 ID", 200)
		id := stringOf(data["id"])
		if id == "" {
			id = ident()
		}
		if !providerIDPattern.MatchString(id) || ids[id] || names[name] {
			fail(400, "模型标识重复或无效")
		}
		ids[id], names[name] = true, true
		display := stringOf(data["displayName"])
		if len(display) > 120 {
			fail(400, "模型显示名称过长")
		}
		enabled := true
		if v, exists := data["enabled"]; exists {
			var valid bool
			enabled, valid = v.(bool)
			if !valid {
				fail(400, "模型启用状态无效")
			}
		}
		context := 0
		if v, exists := data["contextWindow"]; exists {
			switch v.(type) {
			case float64, int, int64:
			default:
				fail(400, "上下文须为整数")
			}
			context = integer(v)
			if number(v) != float64(context) || context < 0 || context > 2000000 || context > 0 && context < 2048 {
				fail(400, "上下文须为 0（自动）或 2048～2000000 tokens")
			}
		}
		imageMode := stringOf(data["imageInputMode"])
		if imageMode == "" {
			if data["supportsImageInput"] == true {
				imageMode = "on"
			} else {
				imageMode = "auto"
			}
		}
		if imageMode != "auto" && imageMode != "on" && imageMode != "off" {
			fail(400, "图片输入模式无效")
		}
		var detected *bool
		if raw, exists := data["imageInputDetected"]; exists && raw != nil {
			value, ok := raw.(bool)
			if !ok {
				fail(400, "图片输入检测结果无效")
			}
			if imageMode == "auto" {
				detected = &value
			}
		}
		models = append(models, ProviderModel{ID: id, Name: name, DisplayName: display, Enabled: enabled, ContextWindow: context, SupportsImageInput: imageMode == "on" || imageMode == "auto" && detected != nil && *detected, SupportsImageOutput: data["supportsImageOutput"] == true, ImageInputMode: imageMode, ImageInputDetected: detected, Reasoning: validatedProviderReasoning(data["reasoningCapability"])})
	}
	return models
}
func (m *Models) SaveProvider(id string, data Object) Object {
	m.mu.Lock()
	defer m.mu.Unlock()
	catalog := m.catalogLocked()
	old := findProvider(catalog, id)
	if id != "" && old == nil {
		fail(404, "供应商不存在")
	}
	provider := ModelProvider{ID: ident(), Protocol: "openai", Enabled: true, Models: []ProviderModel{}}
	if old != nil {
		provider = *old
	}
	if v, exists := data["name"]; exists {
		provider.Name = text(v, "供应商名称", 120)
	}
	if v, exists := data["baseURL"]; exists {
		provider.BaseURL = text(v, "Base URL", 2000)
	}
	if v, exists := data["protocol"]; exists {
		provider.Protocol = validateProtocol(v)
	}
	if normalized := ai.NormalizeProviderEndpoint(provider.BaseURL, provider.Protocol); normalized != provider.BaseURL {
		provider.BaseURL = providerBaseURL(normalized)
	}
	if v, exists := data["enabled"]; exists {
		var ok bool
		provider.Enabled, ok = v.(bool)
		if !ok {
			fail(400, "供应商启用状态无效")
		}
	}
	if v, exists := data["models"]; exists {
		provider.Models = validatedProviderModels(v)
	}
	if provider.Name == "" {
		fail(400, "请输入供应商名称")
	}
	providerEndpoint(provider.BaseURL, provider.Protocol)
	if old == nil && len(catalog.Providers) >= 128 {
		fail(400, "最多保存 128 个供应商")
	}
	if old != nil && (provider.BaseURL != old.BaseURL || provider.Protocol != old.Protocol) {
		provider.EndpointURL = ""
	}
	previousRef := provider.CredentialRef
	if v, exists := data["apiKey"]; exists {
		if v == nil {
			provider.CredentialRef = ""
		} else {
			key, ok := v.(string)
			if !ok || len(key) > 4096 || strings.ContainsAny(key, "\r\n\x00") {
				fail(400, "API Key 格式无效")
			}
			if strings.TrimSpace(key) != "" {
				provider.CredentialRef = m.saveProviderKeyLocked(key)
			}
		}
	}
	if old != nil {
		for i := range provider.Models {
			model := &provider.Models[i]
			previous := findProviderModel(old, model.ID)
			sameTarget := previous != nil && previous.Name == model.Name && provider.BaseURL == old.BaseURL && provider.Protocol == old.Protocol && provider.CredentialRef == old.CredentialRef
			if model.imageInputMode() == "auto" && !sameTarget {
				model.ImageInputDetected = nil
				model.SupportsImageInput = false
			}
			if !sameTarget {
				model.Reasoning = nil
			} else if model.Reasoning == nil {
				model.Reasoning = previous.Reasoning
			}
		}
		*old = provider
	} else {
		if len(catalog.Providers) >= 128 {
			fail(400, "最多保存 128 个供应商")
		}
		catalog.Providers = append(catalog.Providers, provider)
	}
	ensureActiveProvider(catalog)
	m.saveProviderCatalogLocked(catalog)
	if previousRef != provider.CredentialRef {
		m.removeProviderKeyLocked(previousRef)
	}
	m.startProviderCapabilityDetectionLocked(provider.ID, catalog, false)
	result := m.publicProviderCatalogLocked(catalog)
	result["savedProviderId"] = provider.ID
	return result
}
func (m *Models) removeProviderKeyLocked(ref string) {
	if regexp.MustCompile(`^provider-model-[a-f0-9]{32}\.key$`).MatchString(ref) {
		os.Remove(filepath.Join(m.Home, "secrets", ref))
	}
}
func (m *Models) DeleteProvider(id string) Object {
	m.mu.Lock()
	defer m.mu.Unlock()
	catalog := m.catalogLocked()
	provider := findProvider(catalog, id)
	if provider == nil {
		fail(404, "供应商不存在")
	}
	ref := provider.CredentialRef
	next := []ModelProvider{}
	for _, p := range catalog.Providers {
		if p.ID != id {
			next = append(next, p)
		}
	}
	catalog.Providers = next
	ensureActiveProvider(catalog)
	m.saveProviderCatalogLocked(catalog)
	if job := m.capabilityJobs[id]; job != nil {
		job.cancel()
		delete(m.capabilityJobs, id)
	}
	m.removeProviderKeyLocked(ref)
	return m.publicProviderCatalogLocked(catalog)
}
func (m *Models) ActivateProviderModel(providerID, modelID string) Object {
	m.mu.Lock()
	defer m.mu.Unlock()
	if providerID == "magpie" {
		m.activateMagpieModelLocked(modelID)
		catalog := m.catalogLocked()
		catalog.ActiveSource = "magpie"
		m.saveProviderCatalogLocked(catalog)
		return m.publicProviderCatalogLocked(catalog)
	}
	catalog := m.catalogLocked()
	provider := findProvider(catalog, providerID)
	model := findProviderModel(provider, modelID)
	if provider == nil || !provider.Enabled || model == nil || !model.Enabled {
		fail(400, "请选择已启用的供应商和模型")
	}
	if _, valid := m.providerKeyLocked(provider.CredentialRef); !valid {
		fail(400, "供应商密钥不可用，请重新填写")
	}
	catalog.ActiveProviderID, catalog.ActiveModelID = providerID, modelID
	catalog.ActiveSource = "native"
	m.saveProviderCatalogLocked(catalog)
	return m.publicProviderCatalogLocked(catalog)
}

// Test/discovery keys are always scoped to the explicitly selected provider.
func (m *Models) ProviderInput(id string, data Object) *ai.Model {
	m.mu.Lock()
	defer m.mu.Unlock()
	base, protocol := stringOf(data["baseURL"]), stringOf(data["protocol"])
	exactURL := ""
	key, name := "", stringOf(data["model"])
	if id != "new" {
		provider := findProvider(m.catalogLocked(), id)
		if provider == nil {
			fail(404, "供应商不存在")
		}
		if base == "" {
			base = provider.BaseURL
		}
		if protocol == "" {
			protocol = provider.Protocol
		}
		if name == "" && len(provider.Models) > 0 {
			name = provider.Models[0].Name
		}
		if base == provider.BaseURL && protocol == provider.Protocol {
			exactURL = provider.EndpointURL
		}
		var valid bool
		key, valid = m.providerKeyLocked(provider.CredentialRef)
		if !valid {
			value, exists := data["apiKey"]
			if !exists || value != nil && strings.TrimSpace(stringOf(value)) == "" {
				fail(400, "供应商密钥不可用，请重新填写")
			}
		}
	}
	if protocol == "" {
		protocol = "openai"
	}
	protocol = validateProtocol(protocol)
	if value, exists := data["apiKey"]; exists {
		if value == nil {
			key = ""
		} else {
			typed, ok := value.(string)
			if !ok || len(typed) > 4096 || strings.ContainsAny(typed, "\r\n\x00") {
				fail(400, "API Key 格式无效")
			}
			if strings.TrimSpace(typed) != "" {
				key = typed
			}
		}
	}
	if name == "" {
		name = "discovery"
	}
	resolved := providerEndpoint(base, protocol)
	if exactURL != "" {
		resolved = endpoint(exactURL, protocol)
	}
	return &ai.Model{URL: resolved, Protocol: protocol, Name: text(name, "模型 ID", 200), Key: key}
}
func (m *Models) ConfiguredProviderModels() (Object, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.configuredProviderModelsLocked()
}

func (m *Models) configuredProviderModelsLocked() (Object, bool) {
	models, selected, _ := m.magpieModelsLocked()
	entries := []Object{}
	names := []string{}
	for _, item := range models {
		entries = append(entries, Object{"providerId": "magpie", "providerName": "Magpie", "modelId": item.ID, "name": item.ID, "displayName": item.Label, "contextWindow": item.Model.ContextLimit})
		names = append(names, item.ID)
	}
	catalog, exists := m.readProviderCatalogLocked()
	if !exists && len(models) == 0 {
		return nil, false
	}
	if !exists {
		catalog = &providerCatalog{}
	}
	for _, provider := range catalog.Providers {
		if provider.Enabled {
			for _, model := range provider.Models {
				if model.Enabled {
					label := model.DisplayName
					if label == "" {
						label = model.Name
					}
					entries = append(entries, Object{"providerId": provider.ID, "providerName": provider.Name, "modelId": model.ID, "name": model.Name, "displayName": label, "contextWindow": model.ContextWindow})
					names = append(names, model.Name)
				}
			}
		}
	}
	result := Object{"models": names, "entries": entries, "activeProviderId": catalog.ActiveProviderID, "activeModelId": catalog.ActiveModelID}
	if len(models) > 0 && (catalog.ActiveSource != "native" || m.catalogModelLocked(catalog) == nil) {
		result["activeProviderId"], result["activeModelId"] = "magpie", selected
		result["source"] = "magpie"
	}
	return result, true
}

func (m *Models) syncLegacyProviderLocked(cfg *ai.Model) {
	catalog, exists := m.readProviderCatalogLocked()
	if !exists {
		return
	}
	provider := findProvider(catalog, catalog.ActiveProviderID)
	if provider == nil {
		catalog.Providers = append(catalog.Providers, ModelProvider{ID: ident(), Name: "当前供应商", Enabled: true, Models: []ProviderModel{}})
		provider = &catalog.Providers[len(catalog.Providers)-1]
	}
	previous := provider.CredentialRef
	provider.CredentialRef = m.saveProviderKeyLocked(cfg.Key)
	provider.BaseURL, provider.Protocol, provider.Enabled = providerBaseURL(cfg.URL), cfg.Protocol, true
	provider.EndpointURL = cfg.URL
	var model *ProviderModel
	for i := range provider.Models {
		if provider.Models[i].Name == cfg.Name {
			model = &provider.Models[i]
			break
		}
	}
	if model == nil {
		provider.Models = append(provider.Models, ProviderModel{ID: ident(), Name: cfg.Name})
		model = &provider.Models[len(provider.Models)-1]
	}
	model.Enabled, model.SupportsImageInput, model.SupportsImageOutput = true, cfg.SupportsImageInput, cfg.SupportsImageOutput
	model.ImageInputMode, model.ImageInputDetected = "off", nil
	if cfg.SupportsImageInput {
		model.ImageInputMode = "on"
	}
	catalog.ActiveProviderID, catalog.ActiveModelID = provider.ID, model.ID
	m.saveProviderCatalogLocked(catalog)
	m.removeProviderKeyLocked(previous)
}

// Only inspect credentials already referenced by configured providers; never
// scan arbitrary files. Return a boolean, never secret material or a match.
func (m *Models) strategyContainsProviderSecret(text string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	catalog, exists := m.readProviderCatalogLocked()
	if !exists {
		return false
	}
	for _, p := range catalog.Providers {
		key, ok := m.providerKeyLocked(p.CredentialRef)
		if ok && key != "" && strings.Contains(text, key) {
			return true
		}
	}
	return false
}
