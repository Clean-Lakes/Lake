package server

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/store"
)

const ProtocolVersion = 1

type Config struct {
	Store          *store.Store
	ListenAddress  string
	Token          string
	AllowedOrigins []string
	TLS            bool
}

type Server struct {
	config  Config
	remote  bool
	origins map[string]bool
	handler http.Handler
}

func New(config Config) (*Server, error) {
	if config.Store == nil {
		return nil, errors.New("Web 缺少数据存储")
	}
	host, _, err := net.SplitHostPort(config.ListenAddress)
	if err != nil {
		return nil, fmt.Errorf("Web 监听地址无效: %w", err)
	}
	ip := net.ParseIP(host)
	loopback := strings.EqualFold(host, "localhost") || ip != nil && ip.IsLoopback()
	if host == "" || host == "0.0.0.0" || host == "::" {
		loopback = false
	}
	origins := make(map[string]bool, len(config.AllowedOrigins))
	for _, raw := range config.AllowedOrigins {
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Host == "" || parsed.Path != "" && parsed.Path != "/" || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, errors.New("Web Origin 配置无效")
		}
		if !loopback && parsed.Scheme != "https" {
			return nil, errors.New("非本机 Web Origin 必须使用 HTTPS")
		}
		origins[parsed.Scheme+"://"+parsed.Host] = true
	}
	if !loopback && (len(config.Token) < 32 || len(origins) == 0 || !config.TLS) {
		return nil, errors.New("非回环 Web 监听需要至少 32 字符令牌、HTTPS Origin 和受信 TLS 终止")
	}
	s := &Server{config: config, remote: !loopback, origins: origins}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", s.health)
	mux.HandleFunc("GET /api/v1/conversations", s.conversations)
	mux.HandleFunc("GET /api/v1/conversations/{id}", s.conversation)
	mux.HandleFunc("GET /api/v1/conversations/{id}/turns", s.turns)
	mux.HandleFunc("GET /api/v1/conversations/{id}/events", s.events)
	mux.Handle("GET /api/v1/conversations/{id}/stream", s.websocketHandler())
	s.handler = s.guard(mux)
	return s, nil
}

func (s *Server) Handler() http.Handler { return s.handler }

func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if r.Method != "GET" {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !s.authorized(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !s.originAllowed(r) {
			http.Error(w, "origin forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) authorized(r *http.Request) bool {
	if !s.remote && s.config.Token == "" {
		return true
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if token == r.Header.Get("Authorization") {
		token = ""
	}
	if token == "" && strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		for _, part := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
			part = strings.TrimSpace(part)
			if strings.HasPrefix(part, "lake.token.") {
				token = strings.TrimPrefix(part, "lake.token.")
				break
			}
		}
	}
	return len(token) == len(s.config.Token) && subtle.ConstantTimeCompare([]byte(token), []byte(s.config.Token)) == 1
}

func (s *Server) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// Same-origin GET fetches commonly omit Origin. The bearer token still
		// authenticates remote HTTP requests; WebSocket handshakes send Origin.
		return !s.remote || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	if s.remote {
		return s.origins[parsed.Scheme+"://"+parsed.Host]
	}
	if len(s.origins) > 0 {
		return s.origins[parsed.Scheme+"://"+parsed.Host]
	}
	return (parsed.Scheme == "http" || parsed.Scheme == "https") && strings.EqualFold(parsed.Host, r.Host)
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(value)
}
func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"version": ProtocolVersion, "status": "ok"})
}
func (s *Server) conversations(w http.ResponseWriter, r *http.Request) {
	items, err := s.config.Store.ListConversations(r.Context())
	if err != nil {
		http.Error(w, "store unavailable", 500)
		return
	}
	writeJSON(w, items)
}
func (s *Server) conversation(w http.ResponseWriter, r *http.Request) {
	item, err := s.config.Store.GetConversation(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "store unavailable", 500)
		return
	}
	writeJSON(w, item)
}
func (s *Server) turns(w http.ResponseWriter, r *http.Request) {
	items, err := s.config.Store.ListConversationTurns(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "store unavailable", 500)
		return
	}
	writeJSON(w, items)
}
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	after, limit, err := eventCursor(r)
	if err != nil {
		http.Error(w, "invalid cursor", 400)
		return
	}
	events, err := s.eventPage(r.PathValue("id"), after, limit, r)
	if errors.Is(err, store.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "store unavailable", 500)
		return
	}
	writeJSON(w, events)
}
func eventCursor(r *http.Request) (uint64, int, error) {
	after := uint64(0)
	limit := 100
	if raw := r.URL.Query().Get("after"); raw != "" {
		value, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			return 0, 0, err
		}
		after = value
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			return 0, 0, err
		}
		limit = value
	}
	if limit < 1 || limit > 500 {
		return 0, 0, errors.New("invalid page limit")
	}
	return after, limit, nil
}

func (s *Server) eventPage(id string, after uint64, limit int, r *http.Request) ([]agent.AgentEvent, error) {
	stored, err := s.config.Store.ListAgentEvents(r.Context(), id, after, limit)
	if err != nil {
		return nil, err
	}
	events := make([]agent.AgentEvent, 0, len(stored))
	for _, item := range stored {
		events = append(events, agent.AgentEvent{Version: ProtocolVersion, SessionID: agent.SessionID(item.ConversationID), Sequence: item.Sequence, Kind: item.Kind, Actor: item.Actor, ToolCallID: agent.ToolCallID(item.ToolCallID), LegacyTurnID: item.LegacyTurnID, Payload: item.Payload, CreatedAt: item.CreatedAt})
	}
	return events, nil
}
