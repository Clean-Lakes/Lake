package web

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/extensions"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/security"
)

func (s *Store) resourceUpdate(work func() any, targets ...string) any {
	if s.securityResourceMutation == nil {
		return s.update(work)
	}
	return s.securityResourceMutation(work, targets)
}
func (s *Store) resourceNavigationUpdate(kind, id string, work func() any) any {
	if kind == "resource" {
		return s.resourceUpdate(work, id)
	}
	if kind == "project" {
		return s.resourceUpdate(work, "project:"+id)
	}
	return s.update(work)
}

func (b *Server) initializeSecurityCatalog() error {
	if b.Engine == nil || b.Store == nil || b.securityRuntime == nil || b.securityRuntime.ReadOnlyView() {
		return ai.ErrSecurityCatalogUnavailable
	}
	if err := b.Engine.SetSecurityCatalogResolver(b.securityCatalogSnapshot); err != nil {
		return err
	}
	if err := b.Engine.BootstrapSecurityCatalog(b.Context); err != nil {
		return err
	}
	if config, readErr := b.Extensions.Store.Read(); readErr == nil && len(config.Servers) > 0 {
		storage, statErr := securityFileMetadata(b.Extensions.Store.Path())
		if statErr == nil {
			updates := []ai.SecurityMCPUpdate{}
			for _, server := range config.Servers {
				updates = append(updates, ai.SecurityMCPUpdate{ID: server.ID, MetadataDigest: securityMCPMetadata(server), StorageDigest: storage, Enabled: server.Enabled})
			}
			if err := b.Engine.BootstrapSecurityMCP(b.Context, updates); err != nil {
				return err
			}
		}
	}
	b.Engine.SetOrphanCleanupResolver(b.securityTerminalCleanupResolver)
	b.Store.securityResourceMutation = func(work func() any, targets []string) any {
		var result any
		must(b.Engine.MutateSecurityCatalog(b.Context, func() error { result = b.Store.update(work); return nil }, targets...))
		return result
	}
	b.Store.securityProjectCreated = func(id string) error { return b.Engine.InitializeSecurityProject(b.Context, id) }
	return nil
}

// File metadata is used only as a revision signal. Credential bytes are never
// opened or hashed. Access times are excluded so normal credential reads do not
// revoke their own operation; inode/change-time catch atomic replacements.
func securityFileMetadata(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || !platform.Private(path, info) {
		return "", os.ErrPermission
	}
	identity := map[string]any{}
	value := reflect.ValueOf(info.Sys())
	if value.Kind() == reflect.Pointer {
		value = value.Elem()
	}
	if value.IsValid() && value.Kind() == reflect.Struct {
		for _, name := range []string{"Dev", "Ino", "Gen", "Ctim", "Ctimespec", "CreationTime", "LastWriteTime", "FileIndexHigh", "FileIndexLow", "VolumeSerialNumber"} {
			field := value.FieldByName(name)
			if field.IsValid() && field.CanInterface() {
				identity[name] = field.Interface()
			}
		}
	}
	return security.ContentDigest([]byte(jsonText(Object{"size": info.Size(), "mode": uint32(info.Mode()), "mtime": info.ModTime().UnixNano(), "identity": identity}))), nil
}

func securityCredentialMetadata(home, ref string) (ai.SecurityCatalogCredential, bool) {
	root := filepath.Join(home, "secrets")
	path := ref
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, path)
	}
	path, err := filepath.Abs(path)
	id := security.ContentDigest([]byte("lake-credential-reference\x00" + path))
	missing := ai.SecurityCatalogCredential{ID: id, MetadataDigest: security.ContentDigest([]byte("unavailable\x00" + id))}
	if err != nil {
		return missing, false
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return missing, false
	}
	resolved, err := privateFile(root, path)
	if err != nil || resolved != path {
		return missing, false
	}
	meta, err := securityFileMetadata(path)
	if err != nil {
		return missing, false
	}
	return ai.SecurityCatalogCredential{ID: id, MetadataDigest: meta, Locator: path}, true
}

var securityConnectionFields = map[string][]string{
	"local":           {"shell"},
	"ssh":             {"host", "port", "username", "shell", "authMethod", "identityFile", "credentialRef"},
	"database":        {"driver", "host", "port", "username", "database", "path", "credentialRef", "tls", "sslmode"},
	"redis":           {"host", "port", "username", "db", "credentialRef", "tls"},
	"docker":          {"endpoint", "ssh_asset_ref"},
	"kubernetes":      {"endpoint", "context", "namespace", "credentialRef", "authMethod", "requestTimeout", "tlsMode"},
	"apisix":          {"endpoint", "credentialRef"},
	"prometheus":      {"endpoint", "username", "credentialRef"},
	"victoriametrics": {"endpoint", "username", "credentialRef"},
}

func (b *Server) securityCatalogSnapshot(ctx context.Context, query ai.SecurityCatalogQuery) (out ai.SecurityCatalogView, err error) {
	defer func() {
		if recover() != nil {
			out = ai.SecurityCatalogView{}
			err = errors.New("security: current catalog ownership or metadata unavailable")
		}
	}()
	return b.securityCatalogSnapshotUnchecked(ctx, query)
}

func (b *Server) securityCatalogSnapshotUnchecked(ctx context.Context, query ai.SecurityCatalogQuery) (out ai.SecurityCatalogView, err error) {
	if err = ctx.Err(); err != nil {
		return out, err
	}
	resources := map[string]Object{}
	b.Store.read(func() any {
		if query.SessionID != "" && stringOf(b.Store.session(query.SessionID)["projectId"]) != query.ProjectID {
			fail(403, "Session outside project")
		}
		if query.SessionID != "" {
			options := b.Store.row("SELECT value FROM aiOptions WHERE sessionId=?", query.SessionID)
			if options != nil {
				settings := object(parsed(stringOf(options["value"])))
				out.HardLocalDeny = settings["denyLocalExecution"] == true
				out.HardReferencedOnly = settings["blockUnreferencedAssets"] == true
			}
		}
		for _, row := range b.Store.rows("SELECT r.*,c.config,CASE WHEN EXISTS(SELECT 1 FROM navigationTrash d WHERE (d.kind='resource' AND d.id=r.id) OR (d.kind='project' AND d.id=r.projectId)) THEN 1 ELSE 0 END AS securityDisabled FROM resources r LEFT JOIN resourceConnections c ON c.resourceId=r.id ORDER BY r.id") {
			if query.ProjectID != "" && stringOf(row["projectId"]) != query.ProjectID {
				continue
			}
			row["settings"] = Object{}
			if raw := stringOf(row["config"]); raw != "" {
				row["settings"] = object(parsed(raw))
			}
			resources[stringOf(row["id"])] = row
		}
		return nil
	})
	credentials := map[string]ai.SecurityCatalogCredential{}
	memo := map[string]ai.SecurityCatalogResource{}
	visiting := map[string]bool{}
	var build func(string) (ai.SecurityCatalogResource, error)
	build = func(id string) (ai.SecurityCatalogResource, error) {
		if value, ok := memo[id]; ok {
			return value, nil
		}
		row, exists := resources[id]
		if !exists || visiting[id] {
			return ai.SecurityCatalogResource{}, errors.New("security: resource dependency missing or cyclic")
		}
		visiting[id] = true
		defer delete(visiting, id)
		kind := stringOf(row["kind"])
		config := object(row["settings"])
		localTarget := kind == "local" || kind == "database" && stringOf(config["driver"]) == "sqlite" || kind == "docker" && stringOf(config["ssh_asset_ref"]) == "" && strings.HasPrefix(stringOf(config["endpoint"]), "unix://")
		keys, known := securityConnectionFields[kind]
		resource := ai.SecurityCatalogResource{ID: id, ProjectID: stringOf(row["projectId"]), Kind: kind, Local: localTarget, Disabled: integer(row["securityDisabled"]) != 0 || !known}
		metadata := Object{"kind": kind, "resourceId": id, "projectId": resource.ProjectID}
		if kind == "local" {
			control, readErr := ai.ReadSecurityControl(b.Models.Home)
			if readErr != nil {
				return resource, readErr
			}
			metadata["runtimeIdentity"] = control.StoreID
			metadata["os"] = runtime.GOOS
			metadata["architecture"] = runtime.GOARCH
		}
		for key := range config {
			if !slices.Contains(keys, key) {
				resource.Disabled = true
			}
		}
		for _, key := range keys {
			value, present := config[key]
			if !present {
				continue
			}
			if key == "identityFile" || key == "credentialRef" {
				if ref := stringOf(value); ref != "" {
					credential, available := securityCredentialMetadata(b.Models.Home, ref)
					credentials[credential.ID] = credential
					resource.CredentialIDs = append(resource.CredentialIDs, credential.ID)
					metadata[key] = credential.ID
					if !available {
						resource.Disabled = true
					}
				}
				continue
			}
			if key == "endpoint" {
				parsed, parseErr := url.Parse(stringOf(value))
				if parseErr != nil || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
					resource.Disabled = true
					metadata[key] = "invalid-inline-endpoint"
					continue
				}
			}
			metadata[key] = value
		}
		if kind == "ssh" {
			if metadata["port"] == nil || integer(metadata["port"]) == 0 {
				metadata["port"] = 22
			}
			if stringOf(metadata["authMethod"]) == "" {
				metadata["authMethod"] = "key"
			}
			if stringOf(metadata["shell"]) == "" {
				metadata["shell"] = "bash"
			}
		}
		if dependency := stringOf(config["ssh_asset_ref"]); dependency != "" {
			parent, parentErr := build(dependency)
			if parentErr != nil || parent.ProjectID != resource.ProjectID {
				resource.Disabled = true
				metadata["dependencyDigest"] = "unavailable"
			} else {
				metadata["dependencyDigest"] = parent.MetadataDigest
				metadata["dependencyIdentity"] = parent.ConnectionIdentity
				resource.CredentialIDs = append(resource.CredentialIDs, parent.CredentialIDs...)
				resource.Disabled = resource.Disabled || parent.Disabled
			}
		}
		slices.Sort(resource.CredentialIDs)
		resource.CredentialIDs = slices.Compact(resource.CredentialIDs)
		resource.ConnectionIdentity = jsonText(metadata)
		resource.MetadataDigest = security.ContentDigest([]byte(resource.ConnectionIdentity))
		memo[id] = resource
		return resource, nil
	}
	ids := slices.Clone(query.ResourceIDs)
	if query.All {
		ids = nil
		for id := range resources {
			ids = append(ids, id)
		}
		slices.Sort(ids)
	}
	if query.TerminalID != "" {
		term := b.Store.projectTerminal(query.SessionID, query.TerminalID)
		b.ResolveTerminalAccess(query.SessionID, query.TerminalID, query.Write)
		if term["status"] == "disconnected" {
			return out, errors.New("security: terminal disconnected")
		}
		out.TerminalID, out.TerminalGeneration, out.TerminalContextRevision, out.TerminalResourceID = query.TerminalID, stringOf(term["generation"]), int64(integer(term["contextVersion"])), stringOf(term["resourceId"])
		if len(ids) == 0 {
			ids = []string{stringOf(term["resourceId"])}
		}
	}
	for _, id := range ids {
		resource, buildErr := build(id)
		if buildErr != nil {
			return out, buildErr
		}
		out.Resources = append(out.Resources, resource)
	}
	for _, credential := range credentials {
		out.Credentials = append(out.Credentials, credential)
	}
	slices.SortFunc(out.Credentials, func(a, b ai.SecurityCatalogCredential) int { return strings.Compare(a.ID, b.ID) })
	for _, id := range sortedResourceIDs(resources) {
		row := resources[id]
		if integer(row["securityDisabled"]) != 0 {
			continue
		}
		asset := ai.Asset{ID: id, Name: stringOf(row["name"]), Kind: stringOf(row["kind"]), Settings: object(row["settings"])}
		if asset.Kind == "ssh" {
			var ssh ai.SSH
			must(json.Unmarshal([]byte(jsonText(row["settings"])), &ssh))
			ssh.KnownHosts = b.Terminals.hostKeyPath(object(row["settings"]))
			asset.SSH = &ssh
			asset.Settings = nil
		}
		out.ExecutionAssets = append(out.ExecutionAssets, asset)
	}
	if query.MCPServerID != "" {
		server, lookupErr := b.Extensions.Store.FindServer(query.MCPServerID)
		if lookupErr != nil {
			return out, lookupErr
		}
		out.MCPServerID, out.MCPToolName, out.MCPEnabled = server.ID, query.MCPToolName, server.Enabled
		out.MCPLocal = server.Transport == "stdio"
		out.MCPMetadataDigest = securityMCPMetadata(server)
		out.MCPStorageDigest, err = securityFileMetadata(b.Extensions.Store.Path())
		if err != nil {
			return out, err
		}
		out.MCPFactory = &securityMCPFactory{server: b, serverID: server.ID, metadata: out.MCPMetadataDigest, storage: out.MCPStorageDigest}
	}
	if query.MCPDiscovery {
		out.MCPFactory = &securityMCPFactory{server: b}
	}
	return out, nil
}

func sortedResourceIDs(resources map[string]Object) []string {
	ids := make([]string, 0, len(resources))
	for id := range resources {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

// Headers, env values and arbitrary command arguments are intentionally absent.
// Trusted MCP configuration writes advance a separate durable config revision.
func securityMCPMetadata(server extensions.Server) string {
	endpoint := ""
	if parsed, err := url.Parse(server.URL); err == nil {
		parsed.User = nil
		parsed.RawQuery = ""
		parsed.Fragment = ""
		endpoint = parsed.String()
	}
	return security.ContentDigest([]byte(jsonText(Object{"id": server.ID, "transport": server.Transport, "enabled": server.Enabled, "endpoint": endpoint, "executable": server.Command, "argumentCount": len(server.Args), "timeoutMs": server.TimeoutMS, "protocolVersion": server.ProtocolVersion, "workObserver": server.WorkObserver})))
}

type securityMCPFactory struct {
	server                      *Server
	serverID, metadata, storage string
}
type securityFrozenMCP struct {
	manager       *extensions.Manager
	configuration *extensions.Server
	servers       []map[string]any
}

func (f *securityMCPFactory) Freeze(ctx context.Context) (ai.SecurityMCPExecutor, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.serverID == "" {
		config, err := f.server.Extensions.Store.Read()
		if err != nil {
			return nil, err
		}
		rows := []map[string]any{}
		for _, server := range config.Servers {
			if server.Enabled {
				rows = append(rows, map[string]any{"id": server.ID, "name": server.Name, "transport": server.Transport})
			}
		}
		return &securityFrozenMCP{servers: rows}, nil
	}
	configuration, err := f.server.Extensions.Store.FindServer(f.serverID)
	if err != nil {
		return nil, err
	}
	storage, err := securityFileMetadata(f.server.Extensions.Store.Path())
	if err != nil {
		return nil, err
	}
	if !configuration.Enabled || storage != f.storage || securityMCPMetadata(configuration) != f.metadata {
		return nil, errors.New("security: MCP configuration changed before handoff")
	}
	configuration.Args = slices.Clone(configuration.Args)
	configuration.Env = cloneMCPStringMap(configuration.Env)
	configuration.Headers = cloneMCPStringMap(configuration.Headers)
	return &securityFrozenMCP{manager: f.server.Extensions, configuration: &configuration}, nil
}

func cloneMCPStringMap(input map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range input {
		out[key] = value
	}
	return out
}

func (f *securityFrozenMCP) Execute(ctx context.Context, name string, args map[string]any) (any, error) {
	if name == "list_mcp_servers" && f.configuration == nil {
		return map[string]any{"servers": f.servers}, nil
	}
	if f.configuration == nil || f.manager == nil || stringOf(args["server_id"]) != f.configuration.ID {
		return nil, errors.New("security: frozen MCP identity required")
	}
	switch name {
	case "list_mcp_tools":
		return f.manager.ToolsWithServer(ctx, *f.configuration, false)
	case "call_mcp_tool":
		return f.manager.CallWithServer(ctx, *f.configuration, stringOf(args["tool"]), object(args["arguments"]))
	}
	return nil, errors.New("security: unsupported MCP operation")
}

func (b *Server) mutateSecurityMCP(ids []string, work func() error) error {
	before, err := b.Extensions.Store.Read()
	if err != nil {
		return err
	}
	beforeStorage := ""
	if _, err = os.Lstat(b.Extensions.Store.Path()); err == nil {
		beforeStorage, err = securityFileMetadata(b.Extensions.Store.Path())
		if err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if ids == nil {
		for _, server := range before.Servers {
			ids = append(ids, server.ID)
		}
	}
	old := map[string]extensions.Server{}
	for _, server := range before.Servers {
		old[server.ID] = server
	}
	return b.Engine.MutateSecurityMCP(b.Context, ids, beforeStorage, func() ([]ai.SecurityMCPUpdate, error) {
		if err := work(); err != nil {
			currentStorage := ""
			if _, statErr := os.Lstat(b.Extensions.Store.Path()); statErr == nil {
				currentStorage, _ = securityFileMetadata(b.Extensions.Store.Path())
			}
			updates := []ai.SecurityMCPUpdate{}
			if currentStorage == beforeStorage {
				for _, id := range ids {
					server, exists := old[id]
					updates = append(updates, ai.SecurityMCPUpdate{ID: id, MetadataDigest: securityMCPMetadata(server), StorageDigest: currentStorage, Enabled: exists && server.Enabled, Deleted: !exists})
				}
			}
			return updates, err
		}
		after, err := b.Extensions.Store.Read()
		if err != nil {
			return nil, err
		}
		storage, err := securityFileMetadata(b.Extensions.Store.Path())
		if err != nil {
			return nil, err
		}
		current := map[string]extensions.Server{}
		for _, server := range after.Servers {
			current[server.ID] = server
		}
		updates := []ai.SecurityMCPUpdate{}
		for _, id := range ids {
			server, exists := current[id]
			prior, hadPrior := old[id]
			prior.Name = server.Name
			changed := !hadPrior || !exists || !reflect.DeepEqual(prior, server)
			updates = append(updates, ai.SecurityMCPUpdate{ID: id, MetadataDigest: securityMCPMetadata(server), StorageDigest: storage, Enabled: exists && server.Enabled, Deleted: !exists, ConnectionChanged: changed})
		}
		return updates, nil
	})
}
