package ai

import (
	"context"
	"errors"
	"slices"

	"github.com/Clean-Lakes/Lake/internal/security"
)

type frozenCommandContextKey struct{}

// executeFrozenCommand passes only the compiler's executable/argv/environment.
// A model's raw shell text is never used for command-profile authority.
func (e *Engine) executeFrozenCommand(ctx context.Context, c Config, a map[string]any, command security.FrozenCommand) (any, error) {
	p, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	profile := command.Profile()
	if p == nil || p.operation.Proof != security.ProofCommandProfile || p.operation.CommandProfileID != profile.ID || p.operation.CommandProfileVersion != profile.Version || p.operation.CommandArgumentsDigest != profile.ArgumentsDigest {
		return nil, &ToolNotExecutedError{Err: errors.New("security: frozen command profile permit required")}
	}
	if a["run_in_background"] == true || c.Runtime == "container" {
		return nil, &ToolNotExecutedError{Err: errors.New("security: command profile requires foreground host execution")}
	}
	ctx = context.WithValue(ctx, frozenCommandContextKey{}, command)
	ctx, cancel := context.WithTimeout(ctx, command.Timeout())
	defer cancel()
	args := make(map[string]any, len(a)+1)
	for key, value := range a {
		args[key] = value
	}
	args["timeout_ms"] = int(command.Timeout().Milliseconds())
	return e.execRuntime(ctx, c, args, append([]string{command.Executable()}, command.Arguments()...), "")
}

func checkFrozenRuntimeCommand(ctx context.Context, argv []string) (security.FrozenCommand, bool, error) {
	command, ok := ctx.Value(frozenCommandContextKey{}).(security.FrozenCommand)
	if !ok {
		return command, false, nil
	}
	expected := append([]string{command.Executable()}, command.Arguments()...)
	if !slices.Equal(argv, expected) {
		return command, true, errors.New("security: command argv changed after preparation")
	}
	return command, true, nil
}
