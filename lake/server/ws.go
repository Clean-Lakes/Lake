package server

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/cloudwego/eino/lake/store"
	"golang.org/x/net/websocket"
)

func (s *Server) websocketHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		after, _, err := eventCursor(r)
		if err != nil {
			http.Error(w, "invalid cursor", 400)
			return
		}
		id := r.PathValue("id")
		if _, err := s.config.Store.GetConversation(r.Context(), id); errors.Is(err, store.ErrNotFound) {
			http.NotFound(w, r)
			return
		} else if err != nil {
			http.Error(w, "store unavailable", 500)
			return
		}
		protocols := strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",")
		valid := false
		for _, protocol := range protocols {
			if strings.TrimSpace(protocol) == "lake.v1" {
				valid = true
				break
			}
		}
		if !valid {
			http.Error(w, "unsupported websocket protocol", 400)
			return
		}
		server := websocket.Server{Handshake: func(config *websocket.Config, _ *http.Request) error {
			config.Protocol = []string{"lake.v1"}
			return nil
		}}
		server.Handler = func(ws *websocket.Conn) {
			defer ws.Close()
			cursor := after
			for {
				select {
				case <-r.Context().Done():
					return
				default:
				}
				page, err := s.eventPage(id, cursor, 100, r)
				if err != nil {
					return
				}
				for _, event := range page {
					if err := ws.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
						return
					}
					if err := websocket.JSON.Send(ws, event); err != nil {
						return
					}
					cursor = event.Sequence
				}
				if len(page) == 100 {
					continue
				}
				timer := time.NewTimer(400 * time.Millisecond)
				select {
				case <-r.Context().Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
		}
		server.ServeHTTP(w, r)
	})
}
