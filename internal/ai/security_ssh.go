package ai

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/security"
)

// runManagedSSHProcess accepts only the existing host-verified SSH transport of
// a compiler-owned remote profile. verifiedTarget must come from prepareRuntimeSSH,
// never a model argument. It owns the local transport, not the remote process.
func (e *Engine) runManagedSSHProcess(ctx context.Context, c Config, a map[string]any, remoteArgv []string, input io.Reader, verifiedTarget *SSH, transportArgv, environment []string, directory string) (map[string]any, error) {
	if err := e.requireSecurityAdapterContext(ctx, c); err != nil {
		return nil, err
	}
	p, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	frozen, hasFrozen, err := checkFrozenRuntimeCommand(ctx, remoteArgv)
	emptyInput := input == nil
	if sized, ok := input.(interface{ Len() int }); ok && sized.Len() == 0 {
		emptyInput = true
	}
	if err != nil || p == nil || p.prepared == nil || !hasFrozen || len(p.operation.Resources) != 1 || p.operation.Resources[0].Local || !emptyInput || verifiedTarget == nil || a["run_in_background"] == true {
		return nil, &ToolNotExecutedError{Err: errors.New("security: remote execution requires exact foreground command profile and trusted SSH transport")}
	}
	prepared := p.prepared.executionConfig
	if c.Runtime != "ssh" || prepared.Runtime != "ssh" || c.AssetRef != prepared.AssetRef || c.CredentialDir != prepared.CredentialDir {
		return nil, &ToolNotExecutedError{Err: errors.New("security: SSH execution config changed")}
	}
	selected, err := asset(prepared, prepared.AssetRef)
	if err != nil || selected.Kind != "ssh" || selected.ID != p.operation.Resources[0].ID || selected.SSH == nil {
		return nil, &ToolNotExecutedError{Err: errors.New("security: frozen SSH asset unavailable")}
	}
	// Host verification may replace only the known-hosts file with its trusted pin.
	original := *verifiedTarget
	original.KnownHosts = selected.SSH.KnownHosts
	if js(original) != js(*selected.SSH) {
		return nil, &ToolNotExecutedError{Err: errors.New("security: SSH endpoint or credential changed")}
	}
	profile := frozen.Profile()
	actual := struct {
		Executable             string
		Arguments, Environment []string
		Directory              string
	}{frozen.Executable(), frozen.Arguments(), frozen.Environment(), frozen.Directory()}
	if p.operation.Proof != security.ProofCommandProfile || p.operation.CommandProfileID != profile.ID || p.operation.CommandProfileVersion != profile.Version || p.operation.CommandArgumentsDigest != profile.ArgumentsDigest || hash(js(actual)) != p.operation.ArgumentsDigest || frozen.Directory() != "/" || directory != frozen.Directory() {
		return nil, &ToolNotExecutedError{Err: errors.New("security: frozen remote command changed")}
	}
	base, err := sshBase(verifiedTarget, prepared.CredentialDir)
	if err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	expected := append([]string{platform.Executable("/usr/bin/ssh")}, base...)
	command := "cd " + quote(frozen.Directory()) + " && exec " + joinArgs(append(append([]string{"/usr/bin/env", "-i"}, frozen.Environment()...), remoteArgv...))
	expected = append(expected, "-p", fmt.Sprint(verifiedTarget.Port), "-l", verifiedTarget.Username, verifiedTarget.Host, command)
	env, err := sshEnvironment(verifiedTarget, prepared.CredentialDir)
	if err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	if !slices.Equal(expected, transportArgv) || !slices.Equal(env, environment) {
		return nil, &ToolNotExecutedError{Err: errors.New("security: SSH transport argv or environment changed")}
	}
	value, err := e.startOwnedManagedProcess(ctx, c, a, expected, env, directory, false, false, true)
	return obj(value), err
}
