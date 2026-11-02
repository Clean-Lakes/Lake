package ai

import (
	"os"
	"path/filepath"
	"slices"
)

// Host-only metadata, never serialized in model/session configuration. Even a
// confirmed file root cannot expose the authority store or the local API token.
func (e *Engine) securityProtectedConfig(c Config) Config {
	owner, err := securityRootEngine(e)
	if err != nil {
		return c
	}
	roots := []string{}
	if owner.Dir != "" {
		roots = append(roots, owner.Dir)
	}
	if owner.RuntimeDir != "" {
		roots = append(roots, owner.RuntimeDir)
	}
	if h := owner.SecurityRuntime; h != nil {
		roots = append(roots, h.Home, filepath.Dir(h.RuntimeRoot))
	}
	if home, err := os.UserHomeDir(); err == nil {
		roots = append(roots, filepath.Join(home, ".lake"), filepath.Join(home, ".lake-dev"))
	}
	c.runtimeProtectedPaths = roots
	return c
}

// SetSecurityHostSecrets is used once by the trusted server before workers
// start. It adds local authentication material to normal result redaction;
// it does not read Keychain, a credential file or a model-supplied value.
func (e *Engine) SetSecurityHostSecrets(values []string) {
	owner, err := securityRootEngine(e)
	if err != nil {
		return
	}
	owner.securityHostSecretMu.Lock()
	defer owner.securityHostSecretMu.Unlock()
	owner.securityHostSecrets = slices.Clone(values)
}
func (e *Engine) securityHostSecretSnapshot() []string {
	owner, err := securityRootEngine(e)
	if err != nil {
		return nil
	}
	owner.securityHostSecretMu.RLock()
	defer owner.securityHostSecretMu.RUnlock()
	return slices.Clone(owner.securityHostSecrets)
}
