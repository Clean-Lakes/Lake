package extensions

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/Clean-Lakes/Lake/internal/platform"
)

var Identifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$`)
var envName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

type Server struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	Transport       string            `json:"transport"`
	Enabled         bool              `json:"enabled"`
	URL             string            `json:"url,omitempty"`
	Command         string            `json:"command,omitempty"`
	Args            []string          `json:"args"`
	Headers         map[string]string `json:"headers,omitempty"`
	Env             map[string]string `json:"env,omitempty"`
	TimeoutMS       int               `json:"timeoutMs,omitempty"`
	ProtocolVersion string            `json:"protocolVersion,omitempty"`
}
type Config struct {
	Version        int      `json:"version"`
	Servers        []Server `json:"servers"`
	SkillRoots     []string `json:"skillRoots"`
	DisabledSkills []string `json:"disabledSkills"`
}
type Store struct {
	Home    string
	mu      sync.Mutex
	skillMu sync.Mutex
}

func NewStore(home string) *Store {
	if real, err := filepath.EvalSymlinks(home); err == nil {
		home = real
	}
	return &Store{Home: home}
}
func (s *Store) Path() string { return filepath.Join(s.Home, "secrets", "extensions.json") }
func empty() Config {
	return Config{Version: 1, Servers: []Server{}, SkillRoots: []string{}, DisabledSkills: []string{}}
}
func (s *Store) Read() (Config, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.read() }
func (s *Store) read() (Config, error) {
	c := empty()
	p := s.Path()
	st, err := os.Lstat(p)
	if os.IsNotExist(err) {
		return c, nil
	}
	if err != nil || !st.Mode().IsRegular() || st.Size() > 1_000_000 || !platform.Private(p, st) {
		return c, errors.New("扩展配置文件权限无效或文件过大")
	}
	parent, err := os.Lstat(filepath.Dir(p))
	if err != nil || !parent.IsDir() || !platform.Private(filepath.Dir(p), parent) {
		return c, errors.New("扩展凭据目录权限无效")
	}
	b, err := os.ReadFile(p)
	if err != nil || json.Unmarshal(b, &c) != nil || c.Version != 1 {
		return empty(), errors.New("无法读取扩展配置")
	}
	return c, nil
}
func (s *Store) Update(change func(*Config) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, err := s.read()
	if err != nil {
		return err
	}
	if err = change(&c); err != nil {
		return err
	}
	dir := filepath.Dir(s.Path())
	if err = platform.MkdirAll(dir, 0700); err != nil {
		return errors.New("无法创建扩展凭据目录")
	}
	st, err := os.Lstat(dir)
	if err != nil || !st.IsDir() || !platform.Private(dir, st) {
		return errors.New("扩展凭据目录必须为当前用户的私有目录")
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil || len(b) > 999999 {
		return errors.New("扩展配置无效或超过 1 MB")
	}
	temp, err := os.CreateTemp(dir, ".extensions-*")
	if err != nil {
		return errors.New("无法保存扩展配置")
	}
	p := temp.Name()
	defer os.Remove(p)
	if err = platform.Chmod(p, 0600); err == nil {
		_, err = temp.Write(append(b, '\n'))
	}
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = platform.ReplaceFile(p, s.Path())
	}
	if err != nil {
		return errors.New("无法保存扩展配置")
	}
	return platform.SyncDirectory(dir)
}
func ValidateServer(c Server) error {
	if !Identifier.MatchString(c.ID) || strings.TrimSpace(c.Name) == "" || len(c.Name) > 120 {
		return errors.New("请输入有效的服务名称")
	}
	if c.Transport != "stdio" && c.Transport != "http" && c.Transport != "sse" {
		return errors.New("请选择 MCP 连接方式")
	}
	if c.TimeoutMS != 0 && (c.TimeoutMS < 1000 || c.TimeoutMS > 300000) {
		return errors.New("超时时间须为 1000～300000 毫秒")
	}
	if c.ProtocolVersion != "" && c.ProtocolVersion != "2026-07-28" && c.ProtocolVersion != "2025-11-25" && c.ProtocolVersion != "2025-06-18" && c.ProtocolVersion != "2025-03-26" && c.ProtocolVersion != "2024-11-05" {
		return errors.New("请选择支持的 MCP 协议版本")
	}
	if c.Transport == "stdio" {
		if strings.TrimSpace(c.Command) == "" || len(c.Command) > 2000 || strings.ContainsAny(c.Command, "\x00\r\n") {
			return errors.New("请输入可执行命令，不要使用 Shell 拼接")
		}
	} else {
		u, err := url.Parse(c.URL)
		if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Fragment != "" || u.RawQuery != "" || len(c.URL) > 2000 {
			return errors.New("请输入完整 HTTP(S) 地址，认证信息请放在请求头中")
		}
	}
	if len(c.Args) > 100 || len(c.Env) > 100 || len(c.Headers) > 40 {
		return errors.New("MCP 参数数量过多")
	}
	for _, arg := range c.Args {
		if len(arg) > 4000 || strings.ContainsRune(arg, '\x00') {
			return errors.New("命令参数无效")
		}
	}
	for k, v := range c.Env {
		if !envName.MatchString(k) || len(v) > 16000 || strings.ContainsRune(v, '\x00') {
			return errors.New("环境变量无效")
		}
	}
	for k, v := range c.Headers {
		canonical := http.CanonicalHeaderKey(k)
		if canonical == "" || strings.ContainsAny(k+v, "\r\n\x00") || strings.ContainsAny(k, " :\t") || len(v) > 16000 || canonical == "Host" || canonical == "Content-Length" || canonical == "Connection" || canonical == "Mcp-Session-Id" {
			return errors.New("请求头无效或使用了保留名称")
		}
	}
	return nil
}
func (s *Store) SaveServer(next Server, headersChanged, envChanged bool) error {
	return s.Update(func(c *Config) error {
		found := false
		for i, old := range c.Servers {
			if old.ID == next.ID {
				found = true
				if !headersChanged {
					next.Headers = old.Headers
				}
				if !envChanged {
					next.Env = old.Env
				}
				if err := ValidateServer(next); err != nil {
					return err
				}
				c.Servers[i] = next
				break
			}
		}
		if !found {
			if len(c.Servers) >= 50 {
				return errors.New("最多配置 50 个 MCP 服务")
			}
			if err := ValidateServer(next); err != nil {
				return err
			}
			c.Servers = append(c.Servers, next)
		}
		return nil
	})
}
func (s *Store) DeleteServer(id string) error {
	return s.Update(func(c *Config) error {
		for i, v := range c.Servers {
			if v.ID == id {
				c.Servers = append(c.Servers[:i], c.Servers[i+1:]...)
				return nil
			}
		}
		return errors.New("MCP 服务不存在")
	})
}
func (s *Store) FindServer(id string) (Server, error) {
	c, err := s.Read()
	if err != nil {
		return Server{}, err
	}
	for _, v := range c.Servers {
		if v.ID == id {
			return v, nil
		}
	}
	return Server{}, errors.New("MCP 服务不存在")
}
func PublicServer(v Server) map[string]any {
	return map[string]any{"id": v.ID, "name": v.Name, "transport": v.Transport, "enabled": v.Enabled, "url": v.URL, "command": v.Command, "args": append([]string{}, v.Args...), "headersConfigured": len(v.Headers) > 0, "envConfigured": len(v.Env) > 0, "timeoutMs": v.TimeoutMS, "protocolVersion": v.ProtocolVersion}
}

func ServerRevision(server Server) string {
	raw, _ := json.Marshal(server)
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}
