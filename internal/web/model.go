package web

import (
	"context"
	"encoding/json"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Models struct {
	mu             sync.Mutex
	Home, Dir      string
	capacities     map[string]modelCapacity
	capabilityJobs map[string]*capabilityDetectionJob
}

var protocols = set("openai azure-gpt openai-response claude gemini ollama")

func validateProtocol(v any) string {
	if v == nil {
		return "openai"
	}
	s := stringOf(v)
	if !protocols[s] {
		fail(400, "Invalid model protocol")
	}
	return s
}
func endpoint(value any, protocol string) string {
	s := text(value, "url", 2000)
	s = ai.NormalizeProviderEndpoint(s, protocol)
	u, e := url.Parse(s)
	if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		fail(400, "url must be an absolute http(s) URL")
	}
	if u.User != nil || u.Fragment != "" {
		fail(400, "Use the separate credential field")
	}
	for k := range u.Query() {
		if regexp.MustCompile(`(?i)key|token|secret`).MatchString(k) {
			fail(400, "Use the separate credential field")
		}
	}
	p := strings.TrimRight(u.Path, "/")
	base := p == "" || regexp.MustCompile(`^/v\d+$`).MatchString(p)
	if base {
		if protocol == "ollama" {
			u.Path = "/api/chat"
		} else {
			if p == "" {
				p = "/v1"
			}
			end := map[string]string{"openai": "chat/completions", "azure-gpt": "chat/completions", "claude": "messages", "openai-response": "responses", "gemini": "models/{model}:streamGenerateContent"}[protocol]
			u.Path = p + "/" + end
		}
	}
	// URL.String escapes placeholders; the Gemini provider substitutes the literal marker.
	return strings.ReplaceAll(strings.ReplaceAll(u.String(), "%7Bmodel%7D", "{model}"), "%7bmodel%7d", "{model}")
}
func privateFile(root, path string) (string, error) {
	realRoot, e := filepath.EvalSymlinks(root)
	if e != nil {
		return "", e
	}
	dir, e := os.Stat(realRoot)
	if e != nil || !platform.Private(realRoot, dir) {
		return "", os.ErrPermission
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(realRoot, path)
	}
	real, e := filepath.EvalSymlinks(path)
	if e != nil {
		return "", e
	}
	rel, e := filepath.Rel(realRoot, real)
	if e != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", os.ErrPermission
	}
	info, e := os.Stat(real)
	if e != nil || !info.Mode().IsRegular() || !platform.Private(real, info) {
		return "", os.ErrPermission
	}
	return real, nil
}
func owned(info os.FileInfo) bool { return platform.Owned(info) }

func atomicFile(path string, b []byte) error {
	f, e := platform.OpenFile(path+"."+ident()+".tmp", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	temp := f.Name()
	defer os.Remove(temp)
	if _, e = f.Write(b); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	if e = platform.ReplaceFile(temp, path); e != nil {
		return e
	}
	return platform.SyncDirectory(filepath.Dir(path))
}
func (m *Models) legacySaved() *ai.Model {
	b, e := os.ReadFile(filepath.Join(m.Dir, "model.json"))
	if e != nil {
		return nil
	}
	var cfg Object
	if json.Unmarshal(b, &cfg) != nil {
		return nil
	}
	var result *ai.Model
	func() {
		defer func() {
			if recover() != nil {
				result = nil
			}
		}()
		model := ai.Model{URL: endpoint(cfg["url"], validateProtocol(cfg["protocol"])), Name: text(cfg["name"], "name", 200), Protocol: validateProtocol(cfg["protocol"]), SupportsImageInput: cfg["supportsImageInput"] == true, SupportsImageOutput: cfg["supportsImageOutput"] == true}
		if ref := stringOf(cfg["credentialRef"]); ref != "" {
			path, e := privateFile(filepath.Join(m.Home, "secrets"), ref)
			if e != nil {
				return
			}
			key, e := os.ReadFile(path)
			if e != nil || len(key) > 4096 {
				return
			}
			model.Key = string(key)
		} else {
			model.Key = stringOf(cfg["key"])
		}
		result = &model
	}()
	return result
}
func (m *Models) environment() *ai.Model {
	if os.Getenv("LAKE_WEB_MODEL_URL") == "" || os.Getenv("LAKE_WEB_MODEL_NAME") == "" {
		return nil
	}
	var result *ai.Model
	func() {
		defer func() {
			if recover() != nil {
				result = nil
			}
		}()
		p := os.Getenv("LAKE_WEB_MODEL_PROTOCOL")
		if p == "" {
			p = "openai"
		}
		p = validateProtocol(p)
		result = &ai.Model{URL: endpoint(os.Getenv("LAKE_WEB_MODEL_URL"), p), Name: text(os.Getenv("LAKE_WEB_MODEL_NAME"), "name", 200), Key: os.Getenv("LAKE_WEB_MODEL_KEY"), Protocol: p, SupportsImageInput: os.Getenv("LAKE_WEB_MODEL_IMAGE_INPUT") == "1", SupportsImageOutput: os.Getenv("LAKE_WEB_MODEL_IMAGE_OUTPUT") == "1"}
	}()
	return result
}
func (m *Models) activeLocked() *ai.Model {
	if cfg := m.activeMagpieModelLocked(); cfg != nil {
		return cfg
	}
	return m.nativeActiveLocked()
}
func (m *Models) nativeActiveLocked() *ai.Model {
	if catalog, exists := m.readProviderCatalogLocked(); exists {
		return m.catalogModelLocked(catalog)
	}
	if cfg := m.legacySaved(); cfg != nil {
		return cfg
	}
	return m.environment()
}
func (m *Models) nativeActive() *ai.Model {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.nativeActiveLocked()
}
func (m *Models) Active() *ai.Model {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.activeLocked()
}

// ActiveSelection returns only public presentation metadata alongside the active model.
// Bootstrap uses one locked snapshot so identical IDs from different sources stay distinct.
func (m *Models) ActiveSelection() (*ai.Model, Object) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.activeSelectionLocked()
}

func (m *Models) activeSelectionLocked() (*ai.Model, Object) {
	active := m.activeLocked()
	if active == nil {
		return nil, nil
	}
	catalog, exists := m.readProviderCatalogLocked()
	nativeSelection := func() Object {
		if !exists {
			return nil
		}
		provider := findProvider(catalog, catalog.ActiveProviderID)
		if provider == nil {
			return nil
		}
		model := findProviderModel(provider, catalog.ActiveModelID)
		if model == nil || model.Name != active.Name {
			return nil
		}
		label := model.DisplayName
		if label == "" {
			label = model.Name
		}
		return Object{"providerId": provider.ID, "providerName": provider.Name, "modelId": model.ID, "name": model.Name, "displayName": label}
	}
	if exists && catalog.ActiveSource == "native" && m.catalogModelLocked(catalog) != nil {
		return active, nativeSelection()
	}
	models, selected, _ := m.magpieModelsLocked()
	for _, model := range models {
		if model.ID == selected && model.ID == active.Name {
			return active, Object{"providerId": "magpie", "providerName": "Magpie", "modelId": model.ID, "name": model.ID, "displayName": model.Label}
		}
	}
	return active, nativeSelection()
}

func (m *Models) Settings() Object {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.settingsLocked()
}

func (m *Models) settingsLocked() Object {
	magpie := m.magpieModelLocked()
	if active := m.activeMagpieModelLocked(); active != nil {
		return Object{"source": "settings", "managedBy": "magpie", "configured": true, "url": active.URL, "name": active.Name, "keyConfigured": true, "protocol": active.Protocol, "supportsImageInput": active.SupportsImageInput, "supportsImageOutput": active.SupportsImageOutput, "providerName": "Magpie", "magpie": Object{"name": active.Name}}
	}
	active := m.activeLocked()
	source := "settings"
	if _, exists := m.readProviderCatalogLocked(); !exists && m.legacySaved() == nil {
		source = "environment"
	}
	if active == nil {
		source = "none"
		active = &ai.Model{Protocol: "openai"}
	}
	result := Object{"source": source, "configured": source != "none", "url": active.URL, "name": active.Name, "keyConfigured": active.Key != "", "protocol": active.Protocol, "supportsImageInput": active.SupportsImageInput, "supportsImageOutput": active.SupportsImageOutput}
	if magpie != nil {
		result["magpie"] = Object{"name": magpie.Name}
	}
	if catalog, exists := m.readProviderCatalogLocked(); exists {
		result["providerId"], result["providerModelId"] = catalog.ActiveProviderID, catalog.ActiveModelID
		if provider := findProvider(catalog, catalog.ActiveProviderID); provider != nil {
			result["providerName"] = provider.Name
		}
	}
	return result
}
func (m *Models) Input(data Object) *ai.Model {
	p := validateProtocol(data["protocol"])
	cfg := &ai.Model{URL: endpoint(data["url"], p), Name: text(data["name"], "name", 200), Protocol: p}
	old := m.nativeActive()
	if old != nil {
		cfg.Key = old.Key
		cfg.SupportsImageInput = old.SupportsImageInput
		cfg.SupportsImageOutput = old.SupportsImageOutput
	}
	if v, ok := data["apiKey"]; ok {
		if v == nil {
			cfg.Key = ""
		} else {
			s, ok := v.(string)
			if !ok || len(s) > 4096 {
				fail(400, "apiKey must be text (max 4096 characters)")
			}
			cfg.Key = s
			if strings.TrimSpace(s) == "" {
				cfg.Key = ""
			}
		}
	}
	if v, ok := data["supportsImageInput"]; ok {
		cfg.SupportsImageInput = v == true
	}
	if v, ok := data["supportsImageOutput"]; ok {
		cfg.SupportsImageOutput = v == true
	}
	return cfg
}
func (m *Models) Save(cfg *ai.Model) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.capacities = nil
	must(platform.MkdirAll(m.Dir, 0700))
	must(platform.Chmod(m.Dir, 0700))
	path := filepath.Join(m.Dir, "model.json")
	previous := ""
	if b, e := os.ReadFile(path); e == nil {
		var v Object
		json.Unmarshal(b, &v)
		previous = stringOf(v["credentialRef"])
	}
	data := Object{"url": cfg.URL, "name": cfg.Name, "protocol": cfg.Protocol, "supportsImageInput": cfg.SupportsImageInput, "supportsImageOutput": cfg.SupportsImageOutput}
	ref := ""
	if cfg.Key != "" {
		dir := filepath.Join(m.Home, "secrets")
		must(platform.MkdirAll(dir, 0700))
		must(platform.Chmod(dir, 0700))
		ref = "web-model-" + ident() + ".key"
		f, e := platform.OpenFile(filepath.Join(dir, ref), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		must(e)
		_, e = f.WriteString(cfg.Key)
		if e == nil {
			e = f.Sync()
		}
		f.Close()
		must(e)
		data["credentialRef"] = ref
	}
	if e := atomicFile(path, []byte(jsonText(data)+"\n")); e != nil {
		if ref != "" {
			os.Remove(filepath.Join(m.Home, "secrets", ref))
		}
		panic(e)
	}
	if regexp.MustCompile(`^web-model-[0-9a-f-]+\.key$`).MatchString(previous) {
		os.Remove(filepath.Join(m.Home, "secrets", previous))
	}
	m.syncLegacyProviderLocked(cfg)
}
func (m *Models) Clear() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if catalog, exists := m.readProviderCatalogLocked(); exists {
		catalog.ActiveProviderID, catalog.ActiveModelID = "", ""
		m.saveProviderCatalogLocked(catalog)
	}
	e := os.Remove(filepath.Join(m.Dir, "model.json"))
	if !os.IsNotExist(e) {
		must(e)
	}
}

var hostPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$`)

func validateSSH(home string, v Object) Object {
	if !hostPattern.MatchString(stringOf(v["host"])) {
		fail(400, "Invalid SSH host/username")
	}
	if stringOf(v["username"]) == "" {
		fail(400, "请在资源编辑中补充 SSH 登录信息")
	}
	if !regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$`).MatchString(stringOf(v["username"])) {
		fail(400, "Invalid SSH host/username")
	}
	port := 22
	if v["port"] != nil {
		port = integer(v["port"])
		if float64(port) != number(v["port"]) || port < 1 || port > 65535 {
			fail(400, "SSH port must be 1..65535")
		}
	}
	mode := stringOf(v["authMethod"])
	if mode == "" {
		mode = "key"
	}
	if mode != "key" && mode != "password" {
		fail(400, "SSH 登录方式须为密钥或密码")
	}
	config := Object{"host": v["host"], "username": v["username"], "port": port, "authMethod": mode, "shell": shellName(v["shell"])}
	if mode == "key" {
		path := stringOf(v["identityFile"])
		if path == "" || len(path) > 1000 || strings.ContainsAny(path, "\r\n\x00") {
			fail(400, "请选择 SSH 私钥文件")
		}
		path, e := privateFile(filepath.Join(home, "secrets"), path)
		if e != nil {
			fail(400, "SSH credential must be a private file owned by you under Lake secrets (0600 or 0400)")
		}
		config["identityFile"] = path
	}
	ref := stringOf(v["credentialRef"])
	if mode == "password" && ref == "" {
		fail(400, "请输入 SSH 登录密码")
	}
	if ref != "" {
		readSSHSecret(filepath.Join(home, "secrets"), ref)
		config["credentialRef"] = ref
	}
	return config
}
func number(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	}
	return 0
}
func validateService(kind string, v Object) Object {
	allowed := set("driver host port username database path credentialRef tls sslmode db endpoint ssh_asset_ref")
	if len(v) == 0 {
		fail(400, "Connection settings required")
	}
	for k := range v {
		if !allowed[k] {
			fail(400, "Unsupported connection field; credentials must use credentialRef")
		}
	}
	if len(jsonText(v)) > 4000 {
		fail(400, "Connection settings too large")
	}
	if ref, ok := v["credentialRef"]; ok {
		if _, ok := ref.(string); !ok {
			fail(400, "Invalid credential reference")
		}
		if stringOf(ref) == "" {
			delete(v, "credentialRef")
		}
	}
	if endpoint := stringOf(v["endpoint"]); strings.ContainsAny(endpoint, "@?") {
		fail(400, "Endpoint must not contain credentials")
	}
	if kind == "redis" || kind == "database" && v["driver"] != "sqlite" {
		if !hostPattern.MatchString(stringOf(v["host"])) {
			fail(400, "Explicit connection host required")
		}
		if v["port"] != nil && (number(v["port"]) != float64(integer(v["port"])) || integer(v["port"]) < 1 || integer(v["port"]) > 65535) {
			fail(400, "Connection port must be 1..65535")
		}
	}
	if kind == "database" && !set("postgres mysql sqlite")[stringOf(v["driver"])] {
		fail(400, "Database driver must be postgres, mysql or sqlite")
	}
	return v
}

// Cache only provider metadata, never credentials. A missing limit stays unknown.
type modelCapacity struct {
	Limit     int
	Reasoning *ai.ReasoningCapability
	Expires   time.Time
}

func (m *Models) WithCapacity(ctx context.Context, model *ai.Model) *ai.Model {
	if model == nil {
		return nil
	}
	id := ai.ModelIdentity(*model)
	m.mu.Lock()
	cached, ok := m.capacities[id]
	m.mu.Unlock()
	if !ok || time.Now().After(cached.Expires) {
		query, cancel := context.WithTimeout(ctx, 3*time.Second)
		data, err := ai.Models(query, *model)
		cancel()
		limit := 0
		var reasoning *ai.ReasoningCapability
		if err == nil {
			limits, _ := object(data)["contextLimits"].(map[string]int)
			limit = limits[model.Name]
			capabilities, _ := object(data)["reasoningCapabilities"].(map[string]ai.ReasoningCapability)
			if capability, exists := capabilities[model.Name]; exists {
				reasoning = &capability
			}
		}
		ttl := 5 * time.Minute
		if limit > 0 {
			ttl = 30 * time.Minute
		}
		cached = modelCapacity{Limit: limit, Reasoning: reasoning, Expires: time.Now().Add(ttl)}
		// Do not poison the cache if the caller left before metadata arrived.
		if ctx.Err() == nil {
			m.mu.Lock()
			if m.capacities == nil {
				m.capacities = map[string]modelCapacity{}
			}
			m.capacities[id] = cached
			m.mu.Unlock()
		}
	}
	copy := *model
	if model.ContextLimitSource != "settings" {
		copy.ContextLimit = cached.Limit
	}
	if copy.Reasoning == nil {
		copy.Reasoning = cached.Reasoning
	}
	if cached.Limit > 0 && model.ContextLimitSource != "settings" {
		copy.ContextLimitSource = "provider"
	}
	return &copy
}
func (b *Server) contextView(view ai.View) ai.View {
	model := b.Models.Active()
	if view.Context != nil && model != nil && view.Context.ModelID == ai.ModelIdentity(*model) {
		model = b.Models.CachedCapacity(model)
		view.Context.Window = model.ContextLimit
		view.Context.WindowSource = model.ContextLimitSource
	}
	return view
}

func (m *Models) CachedCapacity(model *ai.Model) *ai.Model {
	if model == nil {
		return nil
	}
	m.mu.Lock()
	cached, ok := m.capacities[ai.ModelIdentity(*model)]
	m.mu.Unlock()
	copy := *model
	if ok && time.Now().Before(cached.Expires) {
		if model.ContextLimitSource != "settings" {
			copy.ContextLimit = cached.Limit
		}
		if copy.Reasoning == nil {
			copy.Reasoning = cached.Reasoning
		}
		if cached.Limit > 0 && model.ContextLimitSource != "settings" {
			copy.ContextLimitSource = "provider"
		}
	}
	return &copy
}
