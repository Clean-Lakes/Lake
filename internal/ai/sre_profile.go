package ai

func (e *Engine) RegisterSREReferences(sessionID string, ids []string) error {
	s, err := e.get(sessionID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range ids {
		if _, err := asset(s.state.Config, id); err != nil {
			return err
		}
		found := false
		for _, known := range s.state.ReferencedAssetIDs {
			found = found || known == id
		}
		if !found {
			s.state.ReferencedAssetIDs = append(s.state.ReferencedAssetIDs, id)
		}
	}
	return e.save(s)
}
