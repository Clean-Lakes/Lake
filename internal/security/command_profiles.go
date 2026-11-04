package security

import (
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"time"
)

const (
	CommandProfileVersion int64 = 1
	DefaultDiagnosticUses int64 = 50
	DefaultRestartUses    int64 = 1
	DefaultCommandTimeout       = 30 * time.Second
)

// CommandArguments is the entire accepted argument schema. Shell text, working
// directory, environment, arbitrary executable and privilege flags are absent.
type CommandArguments struct {
	ServiceID  string `json:"serviceId"`
	LogMinutes int    `json:"logMinutes"`
	LogLines   int    `json:"logLines"`
}

type ServiceDefinition struct {
	ID, ResourceID, Unit string
}

type CommandRequest struct {
	ProfileID  string
	Version    int64
	OS         string
	ResourceID string
	Arguments  CommandArguments
	Services   []ServiceDefinition // trusted resource configuration, never tool args
}

// FrozenCommand exposes copies, so checking a profile and later substituting a
// model-provided raw shell string cannot occur through this API.
type FrozenCommand struct {
	executable                             string
	argv, env                              []string
	profileID, argumentsDigest, capability string
	version                                int64
}

func (c FrozenCommand) Executable() string     { return c.executable }
func (c FrozenCommand) Arguments() []string    { return append([]string(nil), c.argv...) }
func (c FrozenCommand) Environment() []string  { return append([]string(nil), c.env...) }
func (c FrozenCommand) Directory() string      { return "/" }
func (c FrozenCommand) Timeout() time.Duration { return DefaultCommandTimeout }
func (c FrozenCommand) Profile() CommandProfileScope {
	return CommandProfileScope{ID: c.profileID, Version: c.version, ArgumentsDigest: c.argumentsDigest}
}
func (c FrozenCommand) Capability() string { return c.capability }

var serviceUnitPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}\.service$`)

func ValidateCommandProfileScope(scope CommandProfileScope) bool {
	return knownProfile(scope.ID, scope.Version) && isDigest(scope.ArgumentsDigest)
}

func CompileCommand(in CommandRequest) (FrozenCommand, error) {
	if in.Version != CommandProfileVersion || in.ResourceID == "" || in.OS != "linux" && in.OS != "darwin" {
		return FrozenCommand{}, errors.New("unsupported command profile")
	}
	raw, _ := json.Marshal(in.Arguments)
	c := FrozenCommand{profileID: in.ProfileID, version: in.Version, argumentsDigest: ContentDigest(raw), capability: "command.diagnostics", env: []string{"PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C"}}
	a := in.Arguments
	switch in.ProfileID {
	case "disk_usage":
		if a != (CommandArguments{}) {
			return FrozenCommand{}, errors.New("disk profile accepts no arguments")
		}
		c.executable, c.argv = "/bin/df", []string{"-k", "-P"}
	case "process_snapshot":
		if a != (CommandArguments{}) {
			return FrozenCommand{}, errors.New("process profile accepts no arguments")
		}
		c.executable, c.argv = "/bin/ps", []string{"-eo", "pid,ppid,pcpu,pmem,comm"}
	case "service_status", "service_logs", "service_restart":
		if in.OS != "linux" || a.ServiceID == "" {
			return FrozenCommand{}, errors.New("service profile requires a configured Linux service")
		}
		unit := ""
		for _, service := range in.Services {
			if service.ID == a.ServiceID && service.ResourceID == in.ResourceID {
				if unit != "" {
					return FrozenCommand{}, errors.New("ambiguous service identity")
				}
				unit = service.Unit
			}
		}
		if !serviceUnitPattern.MatchString(unit) {
			return FrozenCommand{}, errors.New("unregistered or invalid service unit")
		}
		if in.ProfileID != "service_logs" && (a.LogMinutes != 0 || a.LogLines != 0) {
			return FrozenCommand{}, errors.New("unexpected log limits")
		}
		switch in.ProfileID {
		case "service_status":
			c.executable, c.argv = "/usr/bin/systemctl", []string{"--no-pager", "--plain", "status", "--", unit}
		case "service_restart":
			c.capability = "service.restart"
			c.executable, c.argv = "/usr/bin/systemctl", []string{"restart", "--", unit}
		case "service_logs":
			if a.LogMinutes < 1 || a.LogMinutes > 15 || a.LogLines < 1 || a.LogLines > 500 {
				return FrozenCommand{}, errors.New("logs require bounded lines and time")
			}
			c.executable, c.argv = "/usr/bin/journalctl", []string{"--no-pager", "--output=short-iso", "--unit=" + unit, "--since=-" + strconv.Itoa(a.LogMinutes) + "min", "--lines=" + strconv.Itoa(a.LogLines)}
		}
	default:
		return FrozenCommand{}, errors.New("unregistered command profile")
	}
	return c, nil
}
