package ai

import (
	"context"
	"errors"
	"strings"
)

// Set only by the authorized invocation, never by model arguments. Direct SSH
// adapters share the workbench's fingerprint decision without opening a PTY.
type runtimeSSHSessionKey struct{}

func (e *Engine) prepareRuntimeSSH(ctx context.Context, target *SSH, ref string) (*SSH, error) {
	if target == nil {
		return nil, errors.New("invalid SSH target")
	}
	id, _ := ctx.Value(runtimeSSHSessionKey{}).(string)
	if e.Bridge == nil || id == "" {
		return target, nil
	}
	result, err := e.bridgeCall(ctx, id, "verify_runtime_ssh", map[string]any{"asset_ref": ref}, false)
	if err != nil {
		return nil, err
	}
	path := str(obj(result)["knownHosts"])
	if path == "" {
		return nil, errors.New("SSH host trust verification did not complete")
	}
	copy := *target
	copy.KnownHosts = path
	return &copy, nil
}

// Fixed diagnostics prevent a transport exit code from claiming passwords are
// wrong, and never expose server banners, command output or credential text.
func runtimeSSHFailure(stderr string) error {
	value := strings.ToLower(stderr)
	message := "SSH connection failed; the cause is unknown. Do not infer authentication failure from exit code 255."
	switch {
	case strings.Contains(value, "remote host identification has changed"):
		message = "SSH host key changed; verify the server fingerprint before reconnecting. Authentication was not established."
	case strings.Contains(value, "host key verification failed"), strings.Contains(value, "host key is known"):
		message = "SSH host key is not trusted; confirm the server fingerprint in Lake. This does not mean the password is wrong."
	case strings.Contains(value, "permission denied ("), strings.Contains(value, "authentication failed"):
		message = "SSH authentication failed; verify the saved username and password or key for this target."
	case strings.Contains(value, "connection refused"):
		message = "SSH connection refused by the target port; verify the SSH service and forwarded port."
	case strings.Contains(value, "connection timed out"):
		message = "SSH connection timed out; verify network reachability and the forwarded port."
	case strings.Contains(value, "could not resolve hostname"):
		message = "SSH hostname could not be resolved; verify the configured host and DNS."
	case strings.Contains(value, "no route to host"), strings.Contains(value, "network is unreachable"):
		message = "SSH target network is unreachable; verify routing and connectivity."
	case strings.Contains(value, "connection reset"), strings.Contains(value, "connection closed"), strings.Contains(value, "kex_exchange_identification"):
		message = "SSH server closed the connection; verify server connection limits and service logs. Authentication failure is not established."
	}
	return errors.New(message)
}
