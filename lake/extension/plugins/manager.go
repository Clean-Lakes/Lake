package plugins

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/cloudwego/eino/lake/extension/skills"
	"github.com/cloudwego/eino/lake/store"
)

type Bundle struct {
	Manifest Manifest
	Digest   string
	Source   string
	files    map[string][]byte
}

// Inspect reads a bounded, declarative local bundle. Only manifest-declared
// files are accepted; executable assets must be explicitly declared and hashed.
func Inspect(source string) (Bundle, error) {
	absolute, err := filepath.Abs(source)
	if err != nil {
		return Bundle{}, err
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return Bundle{}, errors.New("插件来源必须是普通本地目录")
	}
	root, err := os.OpenRoot(absolute)
	if err != nil {
		return Bundle{}, err
	}
	defer root.Close()
	files := make(map[string][]byte)
	total := 0
	err = filepath.WalkDir(absolute, func(full string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("插件不能包含符号链接")
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return errors.New("插件只能包含普通文件")
		}
		if len(files) >= 100 {
			return errors.New("插件文件数量超过 100")
		}
		stat, err := entry.Info()
		if err != nil || stat.Size() > 1<<20 {
			return errors.New("插件单文件超过 1 MiB")
		}
		relative, err := filepath.Rel(absolute, full)
		if err != nil {
			return err
		}
		file, err := root.Open(relative)
		if err != nil {
			return errors.New("插件文件不在来源目录内")
		}
		data, readErr := io.ReadAll(io.LimitReader(file, (1<<20)+1))
		closeErr := file.Close()
		if readErr != nil || closeErr != nil || len(data) > 1<<20 {
			return errors.New("插件文件读取失败或过大")
		}
		total += len(data)
		if total > 8<<20 {
			return errors.New("插件总大小超过 8 MiB")
		}
		files[filepath.ToSlash(relative)] = data
		return nil
	})
	if err != nil {
		return Bundle{}, err
	}
	manifest, err := parseManifest(files[manifestFile])
	if err != nil {
		return Bundle{}, err
	}
	allowed := map[string]bool{manifestFile: true}
	for _, declared := range append(append(append(append([]string{}, manifest.Skills...), manifest.MCP...), manifest.Hooks...), manifest.Assets...) {
		allowed[declared] = true
		if _, ok := files[declared]; !ok {
			return Bundle{}, fmt.Errorf("插件声明的文件不存在: %s", declared)
		}
	}
	for path := range files {
		if !allowed[path] {
			return Bundle{}, fmt.Errorf("插件包含未声明文件: %s", path)
		}
	}
	if err := validateSkillDeclarations(absolute, manifest); err != nil {
		return Bundle{}, err
	}
	for _, path := range append(append([]string{}, manifest.MCP...), manifest.Hooks...) {
		if err := validateDeclaration(files[path]); err != nil {
			return Bundle{}, fmt.Errorf("插件声明 %s: %w", path, err)
		}
	}
	if err := validateRuntimeDeclarations(absolute, manifest); err != nil {
		return Bundle{}, err
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	hash := sha256.New()
	for _, name := range names {
		hash.Write([]byte(name))
		hash.Write([]byte{0})
		hash.Write(files[name])
		hash.Write([]byte{0})
	}
	return Bundle{Manifest: manifest, Digest: hex.EncodeToString(hash.Sum(nil)), Source: absolute, files: files}, nil
}

type Manager struct {
	root  string
	store *store.Store
}

func NewManager(root string, s *store.Store) *Manager { return &Manager{root: root, store: s} }

func (m *Manager) Install(ctx context.Context, source, expectedDigest string) (store.PluginExtension, error) {
	bundle, err := Inspect(source)
	if err != nil {
		return store.PluginExtension{}, err
	}
	if len(expectedDigest) != 64 || strings.ToLower(expectedDigest) != bundle.Digest {
		return store.PluginExtension{}, errors.New("插件 SHA-256 校验值不匹配")
	}
	pluginRoot := filepath.Join(m.root, "plugins")
	parent := filepath.Join(pluginRoot, bundle.Manifest.Name)
	if err := os.MkdirAll(parent, 0700); err != nil {
		return store.PluginExtension{}, err
	}
	if err := os.Chmod(pluginRoot, 0700); err != nil {
		return store.PluginExtension{}, err
	}
	if err := os.Chmod(parent, 0700); err != nil {
		return store.PluginExtension{}, err
	}
	destination := filepath.Join(parent, bundle.Manifest.Version)
	if _, err := os.Lstat(destination); err == nil {
		return store.PluginExtension{}, errors.New("插件版本已安装")
	} else if !errors.Is(err, os.ErrNotExist) {
		return store.PluginExtension{}, err
	}
	staging, err := os.MkdirTemp(parent, ".install-")
	if err != nil {
		return store.PluginExtension{}, err
	}
	defer os.RemoveAll(staging)
	if err := os.Chmod(staging, 0700); err != nil {
		return store.PluginExtension{}, err
	}
	for relative, data := range bundle.files {
		path := filepath.Join(staging, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return store.PluginExtension{}, err
		}
		if err := os.WriteFile(path, data, assetMode(relative)); err != nil {
			return store.PluginExtension{}, err
		}
	}
	if err := os.Rename(staging, destination); err != nil {
		return store.PluginExtension{}, err
	}
	item, err := m.store.SavePluginExtension(ctx, store.PluginExtensionInput{Name: bundle.Manifest.Name, Version: bundle.Manifest.Version, Source: "local:" + bundle.Source, SHA256: bundle.Digest, InstallPath: destination, ManifestJSON: bundle.files[manifestFile]})
	if err != nil {
		_ = os.RemoveAll(destination)
		return store.PluginExtension{}, err
	}
	return item, nil
}

func (m *Manager) Verify(item store.PluginExtension) error {
	if item.InstallPath != filepath.Join(m.root, "plugins", item.Name, item.Version) {
		return errors.New("插件安装路径无效")
	}
	for _, dir := range []string{filepath.Join(m.root, "plugins"), filepath.Join(m.root, "plugins", item.Name), item.InstallPath} {
		info, err := os.Lstat(dir)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0700 {
			return errors.New("插件安装目录权限无效")
		}
	}
	bundle, err := Inspect(item.InstallPath)
	if err != nil {
		return err
	}
	if bundle.Digest != item.SHA256 || bundle.Manifest.Name != item.Name || bundle.Manifest.Version != item.Version {
		return errors.New("已安装插件的清单或文件已变化")
	}
	return filepath.WalkDir(item.InstallPath, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() && info.Mode().Perm() != 0700 || !entry.IsDir() && info.Mode().Perm() != assetMode(strings.TrimPrefix(filepath.ToSlash(path), filepath.ToSlash(item.InstallPath)+"/")) {
			return errors.New("插件安装目录权限无效")
		}
		return nil
	})
}

func (m *Manager) SetEnabled(ctx context.Context, name string, enabled bool) (store.PluginExtension, error) {
	item, err := m.store.GetPluginExtension(ctx, name)
	if err != nil {
		return item, err
	}
	if enabled {
		if err := m.Verify(item); err != nil {
			return item, err
		}
	}
	return m.store.SetPluginExtensionEnabled(ctx, name, enabled)
}

// EnabledSkills exposes declarations only after validating the installed bundle.
func (m *Manager) EnabledSkills(ctx context.Context) ([]skills.Skill, error) {
	items, err := m.store.ListPluginExtensions(ctx)
	if err != nil {
		return nil, err
	}
	var found []skills.Skill
	for _, item := range items {
		if !item.Enabled {
			continue
		}
		if err := m.Verify(item); err != nil {
			return nil, fmt.Errorf("插件 %s 校验失败: %w", item.Name, err)
		}
		var manifest Manifest
		if err := json.Unmarshal(item.ManifestJSON, &manifest); err != nil {
			return nil, errors.New("已安装插件清单无效")
		}
		for _, declared := range manifest.Skills {
			name := path.Base(path.Dir(declared))
			skill, err := skills.Load(item.InstallPath, "", name)
			if err != nil {
				return nil, fmt.Errorf("插件 %s Skill 无效: %w", item.Name, err)
			}
			skill.Scope = "plugin:" + item.Name
			found = append(found, skill)
		}
	}
	return found, nil
}

// LoadSkill accepts plugin-name/skill-name, or an unambiguous bare name.
func (m *Manager) LoadSkill(ctx context.Context, reference string) (skills.Skill, error) {
	pluginName, skillName := "", reference
	if strings.Contains(reference, "/") {
		parts := strings.Split(reference, "/")
		if len(parts) != 2 || !pluginNamePattern(parts[0]) || !pluginNamePattern(parts[1]) {
			return skills.Skill{}, errors.New("插件 Skill 引用格式无效")
		}
		pluginName, skillName = parts[0], parts[1]
	}
	available, err := m.EnabledSkills(ctx)
	if err != nil {
		return skills.Skill{}, err
	}
	var matched *skills.Skill
	for i := range available {
		skill := &available[i]
		if skill.Name != skillName || pluginName != "" && skill.Scope != "plugin:"+pluginName {
			continue
		}
		if matched != nil {
			return skills.Skill{}, errors.New("多个插件提供同名 Skill，请使用 插件名/Skill名")
		}
		matched = skill
	}
	if matched == nil {
		return skills.Skill{}, fmt.Errorf("插件 Skill %q 不存在或未启用", reference)
	}
	return *matched, nil
}

func pluginNamePattern(value string) bool { return pluginName.MatchString(value) }

func assetMode(relative string) os.FileMode {
	if strings.HasPrefix(relative, "assets/") {
		return 0700
	}
	return 0600
}
