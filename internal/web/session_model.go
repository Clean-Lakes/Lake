package web

import "github.com/Clean-Lakes/Lake/internal/ai"

type sessionModelChoice struct {
	providerID       string
	modelID          string
	legacyConnection string
	revision         int
}

func (s *Store) readSessionModelChoice(id string) *sessionModelChoice {
	return s.read(func() any { return s.sessionModelChoiceLocked(id) }).(*sessionModelChoice)
}

func (s *Store) sessionModelChoiceLocked(id string) *sessionModelChoice {
	row := s.row("SELECT providerId,modelId,legacyConnection,revision FROM sessionModelChoices WHERE sessionId=?", id)
	if row == nil {
		return nil
	}
	return &sessionModelChoice{stringOf(row["providerId"]), stringOf(row["modelId"]), stringOf(row["legacyConnection"]), integer(row["revision"])}
}

func (s *Store) saveSessionModelChoice(id string, choice sessionModelChoice) int {
	return s.update(func() any {
		s.session(id)
		if previous := s.sessionModelChoiceLocked(id); previous != nil {
			choice.revision = previous.revision
			if *previous == choice {
				return choice.revision
			}
		}
		choice.revision++
		s.exec(`INSERT INTO sessionModelChoices(sessionId,providerId,modelId,legacyConnection,revision) VALUES(?,?,?,?,?)
			ON CONFLICT(sessionId) DO UPDATE SET providerId=excluded.providerId,modelId=excluded.modelId,legacyConnection=excluded.legacyConnection,revision=excluded.revision`,
			id, choice.providerID, choice.modelID, choice.legacyConnection, choice.revision)
		s.event(id, "session")
		return choice.revision
	}).(int)
}

// Older installations without a provider catalog discover model names on a
// single configured endpoint. Pin the choice to that endpoint and protocol.
func (m *Models) legacySessionModelLocked() *ai.Model {
	if model := m.legacySaved(); model != nil {
		return model
	}
	return m.environment()
}

func legacyModelConnection(model ai.Model) string {
	model.Name = ""
	return ai.ModelIdentity(model)
}

func (m *Models) legacySessionModelChoice(name string) sessionModelChoice {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, hasCatalog := m.configuredProviderModelsLocked(); hasCatalog {
		fail(400, "请选择已启用的供应商和模型")
	}
	model := m.legacySessionModelLocked()
	if model == nil {
		fail(400, "尚未配置模型")
	}
	return sessionModelChoice{modelID: name, legacyConnection: legacyModelConnection(*model)}
}

func (m *Models) resolveSessionModel(choice sessionModelChoice) (*ai.Model, Object) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if choice.legacyConnection != "" {
		model := m.legacySessionModelLocked()
		if model == nil || legacyModelConnection(*model) != choice.legacyConnection {
			return nil, nil
		}
		model.Name = choice.modelID
		return model, nil
	}
	if choice.providerID == "magpie" {
		models, _, _ := m.magpieModelsLocked()
		for _, item := range models {
			if item.ID == choice.modelID {
				return &item.Model, Object{"providerId": "magpie", "providerName": "Magpie", "modelId": item.ID, "name": item.ID, "displayName": item.Label, "contextWindow": item.Model.ContextLimit}
			}
		}
		return nil, nil
	}
	catalog, exists := m.readProviderCatalogLocked()
	if !exists {
		return nil, nil
	}
	provider := findProvider(catalog, choice.providerID)
	entry := findProviderModel(provider, choice.modelID)
	model := m.providerModelLocked(provider, entry)
	if model == nil {
		return nil, nil
	}
	return model, Object{"providerId": provider.ID, "providerName": provider.Name, "modelId": entry.ID, "name": entry.Name,
		"displayName": defaultText(entry.DisplayName, entry.Name), "contextWindow": entry.ContextWindow}
}

func (b *Server) sessionModelSelection(id string) (*ai.Model, Object) {
	if choice := b.Store.readSessionModelChoice(id); choice != nil {
		return b.Models.resolveSessionModel(*choice)
	}
	return b.Models.ActiveSelection()
}

func (b *Server) sessionModel(id string) *ai.Model {
	if choice := b.Store.readSessionModelChoice(id); choice != nil {
		model, _ := b.Models.resolveSessionModel(*choice)
		return model
	}
	return b.Models.Active()
}

func (b *Server) sessionModelState(id string) Object {
	if id == "" {
		return nil
	}
	choice := b.Store.readSessionModelChoice(id)
	if choice == nil {
		return nil
	}
	model, selection := b.Models.resolveSessionModel(*choice)
	state := modelDisplayState(model, selection)
	state["revision"] = choice.revision
	return state
}

func (b *Server) selectSessionModel(id string, data Object) Object {
	b.messageMu.Lock()
	defer b.messageMu.Unlock()
	if set("worker role legacy")[b.Store.superSessionKind(id)] {
		fail(409, "请在可编辑的对话中设置模型")
	}
	if b.messageBusyLocked(id) || b.Store.ActiveWorkflowRun(id) != "" || len(objects(b.Store.MessageQueue(id)["items"])) > 0 {
		fail(409, "请先结束本轮并处理待发送消息，再切换模型")
	}
	var choice sessionModelChoice
	if name, legacy := data["name"]; legacy {
		choice = b.Models.legacySessionModelChoice(text(name, "模型名称", 200))
	} else {
		choice = sessionModelChoice{providerID: text(data["providerId"], "供应商", 120), modelID: text(data["modelId"], "模型", 200)}
	}
	model, selection := b.Models.resolveSessionModel(choice)
	if model == nil {
		fail(400, "模型不可用")
	}
	state := modelDisplayState(model, selection)
	state["revision"] = b.Store.saveSessionModelChoice(id, choice)
	return state
}
