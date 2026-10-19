package web

import "github.com/Clean-Lakes/Lake/internal/ai"

// SyncState reads local configuration only. Unlike model discovery, polling it
// never contacts a provider or changes the user's model/source preference.
func (m *Models) SyncState() Object {
	m.mu.Lock()
	defer m.mu.Unlock()
	model, selection := m.activeSelectionLocked()
	var name, id any
	imageInput := false
	if model != nil {
		name, id = model.Name, ai.ModelIdentity(*model)
		imageInput = model.SupportsImageInput
	}
	available, _ := m.configuredProviderModelsLocked()
	catalog, exists := m.readProviderCatalogLocked()
	if !exists {
		catalog = &providerCatalog{}
	}
	return Object{
		"modelConfigured": model != nil, "modelName": name, "modelId": id,
		"modelSelection": selection, "supportsImageInput": imageInput,
		"available": available, "settings": m.settingsLocked(),
		"providers": m.publicProviderCatalogLocked(catalog),
	}
}
