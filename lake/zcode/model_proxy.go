package zcode

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

// Only the Go host knows the provider key. The Agent sees an authenticated
// loopback endpoint, never an upstream key or a generic HTTP forwarding proxy.
func modelProxy(opts Options, toolNames []string) (http.Handler, error) {
	upstream, err := url.Parse(opts.BaseURL)
	if err != nil || upstream.Host == "" || (upstream.Scheme != "https" && upstream.Scheme != "http") || upstream.User != nil {
		return nil, errors.New("无效模型地址")
	}
	var allowedPaths map[string]bool
	switch opts.APIType {
	case "anthropic":
		allowedPaths = map[string]bool{"/v1/messages": true, "/messages": true}
	case "openai_chat":
		allowedPaths = map[string]bool{"/chat/completions": true}
	case "openai_responses":
		allowedPaths = map[string]bool{"/responses": true}
	default:
		return nil, errors.New("ZCode 不支持该模型协议")
	}
	allowedTools := make(map[string]bool, len(toolNames))
	for _, name := range toolNames {
		allowedTools[name] = true
	}
	proxy := &httputil.ReverseProxy{
		Director: func(r *http.Request) {
			path := strings.TrimPrefix(r.URL.Path, "/model")
			if opts.APIType == "anthropic" && path == "/messages" {
				path = "/v1/messages"
			}
			r.URL.Scheme = upstream.Scheme
			r.URL.Host = upstream.Host
			r.URL.Path = strings.TrimRight(upstream.Path, "/") + path
			r.URL.RawPath = ""
			r.URL.RawQuery = ""
			r.Host = upstream.Host
			r.Header.Del("Authorization")
			r.Header.Del("X-Api-Key")
			r.Header.Del("Cookie")
			r.Header.Del("Accept-Encoding")
			if opts.APIType == "anthropic" {
				r.Header.Set("X-Api-Key", string(opts.APIKey))
				r.Header.Set("Anthropic-Version", "2023-06-01")
			} else {
				r.Header.Set("Authorization", "Bearer "+string(opts.APIKey))
			}
		},
		Transport:     &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 60 * time.Second, IdleConnTimeout: 30 * time.Second},
		FlushInterval: -1,
		ModifyResponse: func(response *http.Response) error {
			for name, values := range response.Header {
				for i, value := range values {
					values[i] = strings.ReplaceAll(value, string(opts.APIKey), "[redacted]")
				}
				response.Header[name] = values
			}
			response.Body = &redactedBody{ReadCloser: response.Body, key: opts.APIKey}
			response.ContentLength = -1
			response.Header.Del("Content-Length")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "模型代理连接失败", http.StatusBadGateway)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || !allowedPaths[strings.TrimPrefix(r.URL.Path, "/model")] {
			http.Error(w, "Unsupported model route", http.StatusForbidden)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16*1024*1024))
		if err != nil {
			http.Error(w, "Model request too large", http.StatusRequestEntityTooLarge)
			return
		}
		var payload struct {
			Tools []struct {
				Name     string `json:"name"`
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tools"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			http.Error(w, "Invalid model request", http.StatusBadRequest)
			return
		}
		for _, t := range payload.Tools {
			name := t.Name
			if name == "" {
				name = t.Function.Name
			}
			if !allowedTools[name] {
				http.Error(w, "Unregistered tool rejected by LAKE", http.StatusForbidden)
				return
			}
		}
		if opts.ToolStopReason != nil {
			if reason := opts.ToolStopReason(r.Context()); reason != "" {
				var fields map[string]any
				_ = json.Unmarshal(body, &fields)
				delete(fields, "tools")
				delete(fields, "tool_choice")
				delete(fields, "parallel_tool_calls")
				switch opts.APIType {
				case "anthropic":
					if text, ok := fields["system"].(string); ok {
						fields["system"] = text + "\n\n" + reason
					} else {
						blocks, _ := fields["system"].([]any)
						fields["system"] = append(blocks, map[string]string{"type": "text", "text": reason})
					}
				case "openai_chat":
					messages, _ := fields["messages"].([]any)
					fields["messages"] = append(messages, map[string]string{"role": "system", "content": reason})
				case "openai_responses":
					instructions, _ := fields["instructions"].(string)
					fields["instructions"] = instructions + "\n\n" + reason
				}
				body, err = json.Marshal(fields)
				if err != nil {
					http.Error(w, "Invalid model request", http.StatusBadRequest)
					return
				}
			}
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
		proxy.ServeHTTP(w, r)
	}), nil
}
