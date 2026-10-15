package web

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/platform"
)

const magpieConfigName = "magpie-agent.json"
const magpieSelectionName = "magpie-selection.json"

type magpieCatalogItem struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	ContextWindow      int      `json:"contextWindow"`
	MaxOutput          int      `json:"maxOutput"`
	SupportsImageInput bool     `json:"supportsImageInput"`
	ReasoningEfforts   []string `json:"reasoningEfforts"`
}

type magpieAvailableModel struct {
	ID, Label string
	Model     ai.Model
}

type magpieSelection struct {
	DefaultModel string `json:"defaultModel"`
	Model        string `json:"model"`
}

// prepareMagpieConfig gives Magpie an existing private file to edit. Magpie
// preserves an existing mode, but creates missing agent config files as 0644.
func prepareMagpieConfig(home string) error {
	dir := filepath.Join(home, "secrets")
	if err := platform.MkdirAll(dir, 0700); err != nil {
		return err
	}
	info, err := os.Stat(dir)
	if err != nil || !platform.Private(dir, info) {
		return errors.New("Lake secrets directory must be private")
	}
	path := filepath.Join(dir, magpieConfigName)
	info, err = os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		file, createErr := platform.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if createErr == nil {
			_, writeErr := file.Write([]byte("{}\n"))
			closeErr := file.Close()
			if writeErr != nil {
				return writeErr
			}
			return closeErr
		}
		if !errors.Is(createErr, os.ErrExist) {
			return createErr
		}
		info, err = os.Lstat(path)
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || !platform.Owned(info) {
		return fmt.Errorf("Lake Magpie configuration must be an owner-owned regular file")
	}
	return platform.Chmod(path, 0600)
}

// magpieModelsLocked reads Magpie's private catalog. An older plugin that
// writes only one model remains usable. Lake's own selection is separate from
// Magpie's default, so Magpie can still restore its config on disconnect.
func (m *Models) magpieModelsLocked() (result []magpieAvailableModel, selected, defaultModel string) {
	defer func() {
		if recover() != nil {
			result, selected, defaultModel = nil, "", ""
		}
	}()
	path, err := privateFile(filepath.Join(m.Home, "secrets"), magpieConfigName)
	if err != nil {
		return nil, "", ""
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) > 2097152 {
		return nil, "", ""
	}
	var cfg struct {
		Model              string              `json:"model"`
		BaseURL            string              `json:"baseURL"`
		Key                string              `json:"key"`
		ContextWindow      int                 `json:"contextWindow"`
		MaxOutput          int                 `json:"maxOutput"`
		SupportsImageInput bool                `json:"supportsImageInput"`
		ReasoningEfforts   []string            `json:"reasoningEfforts"`
		Catalog            []magpieCatalogItem `json:"catalog"`
	}
	if json.Unmarshal(data, &cfg) != nil || cfg.Model == "" || cfg.BaseURL == "" || cfg.Key == "" || len(cfg.Key) > 4096 || cfg.ContextWindow < 0 || cfg.MaxOutput < 0 {
		return nil, "", ""
	}
	if len(cfg.Catalog) > 1024 {
		cfg.Catalog = cfg.Catalog[:1024]
	}
	if strings.TrimSpace(cfg.Model) != cfg.Model || len(cfg.Model) > 200 || strings.ContainsAny(cfg.Model, "\r\n\x00") {
		return nil, "", ""
	}
	url := endpoint(cfg.BaseURL, "openai")
	defaultModel = cfg.Model
	items := make([]magpieCatalogItem, 0, len(cfg.Catalog)+1)
	items = append(items, cfg.Catalog...)
	items = append(items, magpieCatalogItem{ID: cfg.Model, Name: cfg.Model, ContextWindow: cfg.ContextWindow, MaxOutput: cfg.MaxOutput, SupportsImageInput: cfg.SupportsImageInput, ReasoningEfforts: cfg.ReasoningEfforts})
	seen := map[string]bool{}
	for _, item := range items {
		if item.ID == "" || len(item.ID) > 200 || strings.TrimSpace(item.ID) != item.ID || strings.ContainsAny(item.ID, "\r\n\x00") || seen[item.ID] || item.ContextWindow < 0 || item.MaxOutput < 0 || item.ContextWindow > 2000000 || item.MaxOutput > 2000000 {
			continue
		}
		seen[item.ID] = true
		label := item.Name
		if label == "" || len(label) > 120 || strings.ContainsAny(label, "\r\n\x00") {
			label = item.ID
		}
		model := ai.Model{URL: url, Name: item.ID, Key: cfg.Key, Protocol: "openai", SupportsImageInput: item.SupportsImageInput, ContextLimit: item.ContextWindow, MaxOutput: item.MaxOutput}
		if item.ContextWindow > 0 {
			model.ContextLimitSource = "settings"
		}
		if len(item.ReasoningEfforts) <= 8 {
			model.Reasoning = &ai.ReasoningCapability{Levels: item.ReasoningEfforts, Source: "provider"}
		}
		result = append(result, magpieAvailableModel{ID: item.ID, Label: label, Model: model})
	}
	if len(result) == 0 {
		return nil, "", ""
	}
	selected = defaultModel
	if selectionPath, err := privateFile(m.Dir, magpieSelectionName); err == nil {
		if saved, err := os.ReadFile(selectionPath); err == nil && len(saved) <= 1024 {
			var choice magpieSelection
			if json.Unmarshal(saved, &choice) == nil && choice.DefaultModel == defaultModel {
				for _, item := range result {
					if item.ID == choice.Model {
						selected = item.ID
						break
					}
				}
			}
		}
	}
	return result, selected, defaultModel
}

func (m *Models) magpieModelLocked() *ai.Model {
	models, selected, _ := m.magpieModelsLocked()
	for _, item := range models {
		if item.ID == selected {
			model := item.Model
			return &model
		}
	}
	return nil
}

// Connecting Magpie supplies models without overriding an explicit Lake choice.
func (m *Models) activeMagpieModelLocked() *ai.Model {
	if catalog, exists := m.readProviderCatalogLocked(); exists && catalog.ActiveSource == "native" && m.catalogModelLocked(catalog) != nil {
		return nil
	}
	return m.magpieModelLocked()
}

func (m *Models) activateMagpieModelLocked(id string) {
	models, _, defaultModel := m.magpieModelsLocked()
	valid := false
	for _, item := range models {
		if item.ID == id {
			valid = true
			break
		}
	}
	if !valid {
		fail(400, "Magpie 模型已不可用，请刷新模型列表")
	}
	path := filepath.Join(m.Dir, magpieSelectionName)
	if id == defaultModel {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			must(err)
		}
	} else {
		must(platform.MkdirAll(m.Dir, 0700))
		must(platform.Chmod(m.Dir, 0700))
		must(atomicFile(path, []byte(jsonText(magpieSelection{DefaultModel: defaultModel, Model: id})+"\n")))
	}
	m.capacities = nil
}
