package web

import (
	"context"
	"reflect"
	"sync"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

type capabilityDetectionJob struct {
	cancel   context.CancelFunc
	total    int
	complete int
	finished bool
}

type capabilityDetectionTarget struct {
	id, name  string
	imageAuto bool
	reasoning *ai.ReasoningCapability
}

// Existing profiles predate saved capabilities. Refresh their reasoning metadata
// after launch with a model-list GET; this never sends generation or image probes.
func (m *Models) RefreshStoredReasoning(ctx context.Context) {
	type providerTarget struct {
		id, endpoint, protocol, credentialRef, key string
	}
	m.mu.Lock()
	catalog, exists := m.readProviderCatalogLocked()
	targets := []providerTarget{}
	if exists {
		for _, provider := range catalog.Providers {
			if !provider.Enabled {
				continue
			}
			needsRefresh := false
			for _, model := range provider.Models {
				if model.Enabled && (model.Reasoning == nil || model.Reasoning.Source != "provider") {
					needsRefresh = true
					break
				}
			}
			if !needsRefresh {
				continue
			}
			if key, valid := m.providerKeyLocked(provider.CredentialRef); valid {
				targets = append(targets, providerTarget{provider.ID, providerModelEndpoint(&provider), provider.Protocol, provider.CredentialRef, key})
			}
		}
	}
	m.mu.Unlock()
	for _, target := range targets {
		if ctx.Err() != nil {
			return
		}
		found, err := ai.Models(ctx, ai.Model{URL: target.endpoint, Protocol: target.protocol, Key: target.key})
		if err != nil {
			continue
		}
		result, ok := found.(map[string]any)
		if !ok {
			continue
		}
		capabilities, ok := result["reasoningCapabilities"].(map[string]ai.ReasoningCapability)
		if !ok || len(capabilities) == 0 {
			continue
		}
		m.mu.Lock()
		catalog, exists := m.readProviderCatalogLocked()
		if !exists {
			m.mu.Unlock()
			continue
		}
		provider := findProvider(catalog, target.id)
		if provider == nil || providerModelEndpoint(provider) != target.endpoint || provider.Protocol != target.protocol || provider.CredentialRef != target.credentialRef {
			m.mu.Unlock()
			continue
		}
		changed := false
		for i := range provider.Models {
			model := &provider.Models[i]
			if capability, ok := capabilities[model.Name]; ok && !reflect.DeepEqual(model.Reasoning, &capability) {
				model.Reasoning = &capability
				changed = true
			}
		}
		if changed {
			m.saveProviderCatalogLocked(catalog)
		}
		m.mu.Unlock()
	}
}

func (m *Models) cancelCapabilityDetections() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, job := range m.capabilityJobs {
		job.cancel()
		delete(m.capabilityJobs, id)
	}
}

// Save starts detection without waiting for provider network calls. An explicit
// rerun covers providers configured before automatic detection was introduced.
func (m *Models) StartProviderCapabilityDetection(id string) Object {
	m.mu.Lock()
	defer m.mu.Unlock()
	catalog := m.catalogLocked()
	if findProvider(catalog, id) == nil {
		fail(404, "供应商不存在")
	}
	m.startProviderCapabilityDetectionLocked(id, catalog, true)
	return m.capabilityDetectionStatusLocked(id)
}

func (m *Models) ProviderCapabilityDetectionStatus(id string) Object {
	m.mu.Lock()
	defer m.mu.Unlock()
	if findProvider(m.catalogLocked(), id) == nil {
		fail(404, "供应商不存在")
	}
	return m.capabilityDetectionStatusLocked(id)
}

func (m *Models) capabilityDetectionStatusLocked(id string) Object {
	job := m.capabilityJobs[id]
	if job == nil {
		return Object{"status": "idle", "total": 0, "complete": 0}
	}
	status := "running"
	if job.finished {
		status = "complete"
	}
	return Object{"status": status, "total": job.total, "complete": job.complete}
}

func (m *Models) startProviderCapabilityDetectionLocked(id string, catalog *providerCatalog, force bool) {
	if m.capabilityJobs == nil {
		m.capabilityJobs = make(map[string]*capabilityDetectionJob)
	}
	if old := m.capabilityJobs[id]; old != nil {
		old.cancel()
	}
	provider := findProvider(catalog, id)
	if provider == nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	job := &capabilityDetectionJob{cancel: cancel}
	m.capabilityJobs[id] = job
	if !provider.Enabled {
		job.finished = true
		cancel()
		return
	}
	key, valid := m.providerKeyLocked(provider.CredentialRef)
	if !valid {
		job.finished = true
		cancel()
		return
	}
	targets := make([]capabilityDetectionTarget, 0, len(provider.Models))
	for _, model := range provider.Models {
		if model.Enabled {
			targets = append(targets, capabilityDetectionTarget{id: model.ID, name: model.Name, imageAuto: model.imageInputMode() == "auto"})
		}
	}
	job.total = len(targets)
	if len(targets) == 0 {
		job.finished = true
		cancel()
		return
	}
	// The active model is checked first so its saved capability becomes useful quickly.
	if id == catalog.ActiveProviderID {
		for i := range targets {
			if targets[i].id == catalog.ActiveModelID {
				targets[0], targets[i] = targets[i], targets[0]
				break
			}
		}
	}
	model := ai.Model{URL: providerModelEndpoint(provider), Protocol: provider.Protocol, Key: key}
	go m.detectProviderCapabilities(ctx, job, id, provider.CredentialRef, model, targets, force)
}

func (m *Models) detectProviderCapabilities(ctx context.Context, job *capabilityDetectionJob, providerID, credentialRef string, config ai.Model, targets []capabilityDetectionTarget, force bool) {
	defer func() {
		m.mu.Lock()
		if m.capabilityJobs[providerID] == job {
			job.finished = true
		}
		m.mu.Unlock()
		job.cancel()
	}()
	capabilities := map[string]bool{}
	reasoningCapabilities := map[string]ai.ReasoningCapability{}
	if found, err := ai.Models(ctx, config); err == nil {
		if result, ok := found.(map[string]any); ok {
			if values, ok := result["imageInputCapabilities"].(map[string]bool); ok {
				capabilities = values
			}
			if values, ok := result["reasoningCapabilities"].(map[string]ai.ReasoningCapability); ok {
				reasoningCapabilities = values
			}
		}
	}
	remaining := make([]capabilityDetectionTarget, 0, len(targets))
	for _, target := range targets {
		if ctx.Err() != nil {
			return
		}
		if capability, ok := reasoningCapabilities[target.name]; ok {
			target.reasoning = &capability
		} else {
			fallback := ai.ReasoningSupport(ai.Model{Name: target.name, Protocol: config.Protocol})
			target.reasoning = &fallback
		}
		if !target.imageAuto {
			m.applyModelCapabilities(job, providerID, credentialRef, config.URL, target, nil)
		} else if supported, ok := capabilities[target.name]; ok {
			m.applyModelCapabilities(job, providerID, credentialRef, config.URL, target, &supported)
		} else if force || m.imageProbeNeeded(job, providerID, target) {
			// Reasoning metadata is available now; do not make the selector wait for
			// the separate image request to finish.
			m.saveReasoningCapability(job, providerID, credentialRef, config.URL, target)
			remaining = append(remaining, target)
		} else {
			m.applyModelCapabilities(job, providerID, credentialRef, config.URL, target, nil)
		}
	}
	queue := make(chan capabilityDetectionTarget)
	var workers sync.WaitGroup
	for range min(2, len(remaining)) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for target := range queue {
				probe := config
				probe.Name = target.name
				result, _ := ai.ProbeImageInput(ctx, probe)
				m.applyModelCapabilities(job, providerID, credentialRef, config.URL, target, result)
			}
		}()
	}
send:
	for _, target := range remaining {
		select {
		case <-ctx.Done():
			break send
		case queue <- target:
		}
	}
	close(queue)
	workers.Wait()
}

func (m *Models) saveReasoningCapability(job *capabilityDetectionJob, providerID, credentialRef, endpoint string, target capabilityDetectionTarget) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.capabilityJobs[providerID] != job || target.reasoning == nil {
		return
	}
	catalog, exists := m.readProviderCatalogLocked()
	if !exists {
		return
	}
	provider := findProvider(catalog, providerID)
	model := findProviderModel(provider, target.id)
	if provider == nil || model == nil || model.Name != target.name || providerModelEndpoint(provider) != endpoint || provider.CredentialRef != credentialRef {
		return
	}
	if target.reasoning.Source == "provider" || len(target.reasoning.Levels) > 0 && model.Reasoning == nil {
		model.Reasoning = target.reasoning
		m.saveProviderCatalogLocked(catalog)
	}
}

func (m *Models) imageProbeNeeded(job *capabilityDetectionJob, providerID string, target capabilityDetectionTarget) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.capabilityJobs[providerID] != job {
		return false
	}
	catalog, exists := m.readProviderCatalogLocked()
	if !exists {
		return false
	}
	model := findProviderModel(findProvider(catalog, providerID), target.id)
	return model != nil && model.Name == target.name && model.ImageInputDetected == nil
}

func (m *Models) applyModelCapabilities(job *capabilityDetectionJob, providerID, credentialRef, endpoint string, target capabilityDetectionTarget, detected *bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.capabilityJobs[providerID] != job {
		return
	}
	job.complete++
	catalog, exists := m.readProviderCatalogLocked()
	if !exists {
		return
	}
	provider := findProvider(catalog, providerID)
	model := findProviderModel(provider, target.id)
	if provider == nil || model == nil || model.Name != target.name || providerModelEndpoint(provider) != endpoint || provider.CredentialRef != credentialRef {
		return
	}
	if detected != nil && model.imageInputMode() == "auto" {
		model.ImageInputDetected = detected
		model.SupportsImageInput = *detected
	}
	if target.reasoning != nil && (target.reasoning.Source == "provider" || len(target.reasoning.Levels) > 0 && model.Reasoning == nil) {
		model.Reasoning = target.reasoning
	}
	m.saveProviderCatalogLocked(catalog)
}
