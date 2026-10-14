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

// magpieModelLocked reads Magpie's independent selection without changing
// Lake's native provider catalog. Once Magpie removes the model key, Lake
// immediately falls back to the user's previous active provider.
func (m *Models) magpieModelLocked() (result *ai.Model) {
	path, err := privateFile(filepath.Join(m.Home, "secrets"), magpieConfigName)
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) > 16384 {
		return nil
	}
	var cfg struct {
		Model              string   `json:"model"`
		BaseURL            string   `json:"baseURL"`
		Key                string   `json:"key"`
		ContextWindow      int      `json:"contextWindow"`
		MaxOutput          int      `json:"maxOutput"`
		SupportsImageInput bool     `json:"supportsImageInput"`
		ReasoningEfforts   []string `json:"reasoningEfforts"`
	}
	if json.Unmarshal(data, &cfg) != nil || cfg.Model == "" || cfg.BaseURL == "" || cfg.Key == "" || len(cfg.Key) > 4096 || cfg.ContextWindow < 0 || cfg.MaxOutput < 0 {
		return nil
	}
	defer func() {
		if recover() != nil {
			result = nil
		}
	}()
	if strings.TrimSpace(cfg.Model) != cfg.Model {
		return nil
	}
	result = &ai.Model{
		URL: endpoint(cfg.BaseURL, "openai"), Name: text(cfg.Model, "name", 200),
		Key: cfg.Key, Protocol: "openai", SupportsImageInput: cfg.SupportsImageInput,
		ContextLimit: cfg.ContextWindow, MaxOutput: cfg.MaxOutput,
	}
	if cfg.ContextWindow > 0 {
		result.ContextLimitSource = "settings"
	}
	result.Reasoning = &ai.ReasoningCapability{Levels: cfg.ReasoningEfforts, Source: "provider"}
	return result
}
