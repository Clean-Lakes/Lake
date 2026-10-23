package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync/atomic"
	"time"
)

var HTTPClient = &http.Client{Timeout: 5 * time.Minute}

var ErrModelOutputLimit = errors.New("model output limit reached")
var ErrModelStreamIdle = errors.New("model stream idle timeout; partial reply retained")
var ErrModelIncomplete = errors.New("model response incomplete")
var ErrInvalidModelToolCall = errors.New("invalid or duplicate model tool call")

type modelResult struct {
	Message Message
	Usage   Usage
}

func obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	if m == nil {
		return map[string]any{}
	}
	return m
}
func arr(v any) []any { a, _ := v.([]any); return a }
func protocol(m Model) string {
	if m.Protocol == "" {
		return "openai"
	}
	return m.Protocol
}
func modelPayload(m Model, history []Message, tools []Tool) (string, map[string]any, error) {
	p := protocol(m)
	endpoint := strings.ReplaceAll(strings.ReplaceAll(NormalizeProviderEndpoint(m.URL, p), "{model}", url.PathEscape(m.Name)), "%7Bmodel%7D", url.PathEscape(m.Name))
	u, e := url.Parse(endpoint)
	if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return "", nil, errors.New("invalid model endpoint")
	}
	for key := range u.Query() {
		if secretField.MatchString(key) {
			return "", nil, errors.New("model credentials must use the separate key field")
		}
	}
	max := m.MaxOutput
	if max <= 0 {
		max = 8192
	}
	defs := []any{}
	for _, t := range tools {
		defs = append(defs, map[string]any{"type": "function", "function": t})
	}
	messages := []any{}
	system := ""
	for _, h := range history {
		if h.Role == "system" {
			system += h.Content + "\n"
		}
		message := map[string]any{"role": h.Role, "content": h.Content}
		if h.Role == "user" && len(h.Images) > 0 && m.SupportsImageInput && p != "ollama" {
			parts := []any{}
			if h.Content != "" {
				parts = append(parts, map[string]any{"type": "text", "text": h.Content})
			}
			for _, img := range h.Images {
				parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": imageURL(img)}})
			}
			message["content"] = parts
		}
		if h.Role == "user" && p == "ollama" && m.SupportsImageInput && len(h.Images) > 0 {
			images := []string{}
			for _, img := range h.Images {
				images = append(images, img.Base64)
			}
			message["images"] = images
		}
		// DeepSeek requires the field on assistant history in thinking/tool
		// conversations, including application-generated preflight calls whose
		// reasoning is empty. Keep actual model reasoning unchanged.
		deepseek := strings.Contains(strings.ToLower(m.Name), "deepseek") || u.Hostname() == "api.deepseek.com"
		if h.Reasoning != "" || deepseek && h.Role == "assistant" {
			message["reasoning_content"] = h.Reasoning
		}
		if h.CallID != "" {
			message["tool_call_id"] = h.CallID
			message["name"] = h.Name
		}
		if len(h.Calls) > 0 {
			calls := []any{}
			for _, c := range h.Calls {
				calls = append(calls, map[string]any{"id": c.ID, "type": "function", "function": map[string]any{"name": c.Name, "arguments": c.Arguments}})
			}
			message["tool_calls"] = calls
		}
		messages = append(messages, message)
	}
	body := map[string]any{"model": m.Name, "messages": messages, "stream": true, "max_tokens": max}
	if len(defs) > 0 {
		body["tools"] = defs
	}
	switch p {
	case "openai", "azure-gpt":
		body["stream_options"] = map[string]any{"include_usage": true}
		name := modelSlug(m)
		if strings.HasPrefix(name, "gpt-5") || strings.HasPrefix(name, "gpt-6") || strings.HasPrefix(name, "o1") || strings.HasPrefix(name, "o3") || strings.HasPrefix(name, "o4") {
			delete(body, "max_tokens")
			body["max_completion_tokens"] = max
		}
	case "openai-response":
		input := []any{}
		for _, h := range history {
			if h.Role == "system" {
				continue
			}
			if h.Role == "tool" {
				input = append(input, map[string]any{"type": "function_call_output", "call_id": h.CallID, "output": h.Content})
				continue
			}
			if len(h.Native) > 0 && h.NativeProtocol == p && h.NativeModel == m.Name {
				for _, n := range h.Native {
					input = append(input, n)
				}
				continue
			}
			if h.Content != "" || len(h.Images) > 0 {
				content := any(h.Content)
				if h.Role == "user" && m.SupportsImageInput && len(h.Images) > 0 {
					parts := []any{}
					if h.Content != "" {
						parts = append(parts, map[string]any{"type": "input_text", "text": h.Content})
					}
					for _, img := range h.Images {
						parts = append(parts, map[string]any{"type": "input_image", "image_url": imageURL(img)})
					}
					content = parts
				}
				input = append(input, map[string]any{"role": h.Role, "content": content})
			}
			for _, c := range h.Calls {
				input = append(input, map[string]any{"type": "function_call", "call_id": c.ID, "name": c.Name, "arguments": c.Arguments})
			}
		}
		rdefs := []any{}
		for _, t := range tools {
			rdefs = append(rdefs, map[string]any{"type": "function", "name": t.Name, "description": t.Description, "parameters": t.Parameters, "strict": false})
		}
		body = map[string]any{"model": m.Name, "instructions": system, "input": input, "stream": true, "store": false, "max_output_tokens": max}
		if len(rdefs) > 0 {
			body["tools"] = rdefs
		}
		if m.SupportsImageOutput {
			body["tools"] = append(rdefs, map[string]any{"type": "image_generation"})
		}
	case "claude":
		list := []any{}
		for _, h := range history {
			if h.Role == "system" {
				continue
			}
			role := h.Role
			content := []any{}
			if role == "tool" {
				role = "user"
				content = append(content, map[string]any{"type": "tool_result", "tool_use_id": h.CallID, "content": h.Content})
			} else if len(h.Native) > 0 && h.NativeProtocol == p && h.NativeModel == m.Name {
				for _, n := range h.Native {
					content = append(content, n)
				}
			} else {
				if h.Content != "" {
					content = append(content, map[string]any{"type": "text", "text": h.Content})
				}
				for _, c := range h.Calls {
					a, _ := args(c)
					content = append(content, map[string]any{"type": "tool_use", "id": c.ID, "name": c.Name, "input": a})
				}
			}
			if h.Role == "user" && m.SupportsImageInput {
				for _, img := range h.Images {
					content = append(content, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": img.MimeType, "data": img.Base64}})
				}
			}
			if len(content) == 0 {
				continue
			}
			if len(list) > 0 && str(obj(list[len(list)-1])["role"]) == role {
				last := obj(list[len(list)-1])
				last["content"] = append(arr(last["content"]), content...)
			} else {
				list = append(list, map[string]any{"role": role, "content": content})
			}
		}
		cdefs := []any{}
		for _, t := range tools {
			cdefs = append(cdefs, map[string]any{"name": t.Name, "description": t.Description, "input_schema": t.Parameters})
		}
		body = map[string]any{"model": m.Name, "system": system, "messages": list, "stream": true, "max_tokens": max}
		if len(cdefs) > 0 {
			body["tools"] = cdefs
		}
	case "gemini":
		contents := []any{}
		for _, h := range history {
			if h.Role == "system" {
				continue
			}
			role := "user"
			if h.Role == "assistant" {
				role = "model"
			}
			parts := []any{}
			if h.Role == "tool" {
				parts = append(parts, map[string]any{"functionResponse": map[string]any{"id": h.CallID, "name": h.Name, "response": map[string]any{"result": h.Content}}})
			} else if len(h.Native) > 0 && h.NativeProtocol == p && h.NativeModel == m.Name {
				for _, n := range h.Native {
					parts = append(parts, n)
				}
			} else {
				if h.Content != "" {
					parts = append(parts, map[string]any{"text": h.Content})
				}
				for _, c := range h.Calls {
					a, _ := args(c)
					parts = append(parts, map[string]any{"functionCall": map[string]any{"id": c.ID, "name": c.Name, "args": a}})
				}
			}
			if h.Role == "user" && m.SupportsImageInput {
				for _, img := range h.Images {
					parts = append(parts, map[string]any{"inlineData": map[string]any{"mimeType": img.MimeType, "data": img.Base64}})
				}
			}
			if len(parts) > 0 {
				if len(contents) > 0 && str(obj(contents[len(contents)-1])["role"]) == role {
					last := obj(contents[len(contents)-1])
					last["parts"] = append(arr(last["parts"]), parts...)
				} else {
					contents = append(contents, map[string]any{"role": role, "parts": parts})
				}
			}
		}
		decls := []any{}
		for _, t := range tools {
			decls = append(decls, map[string]any{"name": t.Name, "description": t.Description, "parameters": t.Parameters})
		}
		body = map[string]any{"systemInstruction": map[string]any{"parts": []any{map[string]any{"text": system}}}, "contents": contents, "generationConfig": map[string]any{"maxOutputTokens": max}}
		if len(decls) > 0 {
			body["tools"] = []any{map[string]any{"functionDeclarations": decls}}
		}
		if m.SupportsImageOutput {
			obj(body["generationConfig"])["responseModalities"] = []string{"TEXT", "IMAGE"}
		}
		q := u.Query()
		q.Set("alt", "sse")
		u.RawQuery = q.Encode()
		endpoint = u.String()
	case "ollama":
		for _, v := range messages {
			msg := obj(v)
			if msg["role"] == "tool" {
				msg["tool_name"] = msg["name"]
			}
			if r := str(msg["reasoning_content"]); r != "" {
				msg["thinking"] = r
				delete(msg, "reasoning_content")
			}
			for _, v := range arr(msg["tool_calls"]) {
				f := obj(obj(v)["function"])
				var a any
				_ = json.Unmarshal([]byte(str(f["arguments"])), &a)
				f["arguments"] = a
			}
		}
		body["options"] = map[string]any{"num_predict": max}
		delete(body, "max_tokens")
	default:
		return "", nil, fmt.Errorf("unsupported model protocol %s", p)
	}
	if err := applyReasoning(m, body); err != nil {
		return "", nil, err
	}
	return endpoint, body, nil
}
func Stream(ctx context.Context, m Model, history []Message, tools []Tool, onDelta func(string, string)) (modelResult, error) {
	return streamWithTimeouts(ctx, m, history, tools, onDelta, time.Minute, time.Second)
}

func streamWithTimeouts(ctx context.Context, m Model, history []Message, tools []Tool, onDelta func(string, string), idleTimeout, completionTimeout time.Duration) (modelResult, error) {
	endpoint, body, e := modelPayload(m, history, tools)
	if e != nil {
		return modelResult{}, e
	}
	b, _ := json.Marshal(body)
	requestCtx, cancelRequest := context.WithCancel(ctx)
	defer cancelRequest()
	req, e := http.NewRequestWithContext(requestCtx, "POST", endpoint, bytes.NewReader(b))
	if e != nil {
		return modelResult{}, errors.New("invalid model request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	for k, v := range m.Headers {
		req.Header.Set(k, v)
	}
	switch protocol(m) {
	case "claude":
		req.Header.Set("anthropic-version", "2023-06-01")
		if m.Key != "" {
			if mimoAPI(req.URL) {
				req.Header.Set("Authorization", "Bearer "+m.Key)
			} else {
				req.Header.Set("x-api-key", m.Key)
			}
		}
	case "azure-gpt":
		if m.Key != "" {
			req.Header.Set("api-key", m.Key)
		}
	case "gemini":
		if m.Key != "" {
			req.Header.Set("x-goog-api-key", m.Key)
		}
	default:
		if m.Key != "" {
			req.Header.Set("Authorization", "Bearer "+m.Key)
		}
	}
	resp, e := HTTPClient.Do(req)
	if e != nil {
		if ctx.Err() != nil {
			return modelResult{}, ctx.Err()
		}
		return modelResult{}, errors.New("cannot connect to model endpoint")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var failure map[string]any
		_ = json.NewDecoder(io.LimitReader(resp.Body, 16<<10)).Decode(&failure)
		detail := str(obj(failure["error"])["message"])
		if detail == "" {
			detail = str(failure["message"])
		}
		// Expose only the provider's bounded message, never raw response bodies
		// or request headers; redact credentials before persisting/displaying it.
		detail = redact(detail, Config{Model: m})
		if len(detail) > 500 {
			detail = detail[:500] + "…"
		}
		if detail != "" {
			return modelResult{}, fmt.Errorf("model returned HTTP %d: %s", resp.StatusCode, detail)
		}
		return modelResult{}, fmt.Errorf("model returned HTTP %d", resp.StatusCode)
	}
	a := newAccumulator(protocol(m), onDelta)
	a.model = m
	ct := resp.Header.Get("Content-Type")
	if strings.Contains(ct, "application/json") && !strings.Contains(ct, "ndjson") {
		var v map[string]any
		e = json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&v)
		if e == nil {
			e = a.consume(v, true)
		}
		if e != nil {
			return modelResult{Usage: a.usage}, e
		}
		result, err := a.finish()
		result.Message.NativeProtocol = protocol(m)
		result.Message.NativeModel = m.Name
		return result, err
	}
	scanner := bufio.NewScanner(io.LimitReader(resp.Body, 32<<20))
	scanner.Buffer(make([]byte, 65536), 4<<20)
	data := []string{}
	terminal := false
	var idleExpired, completionExpired atomic.Bool
	var idleTimer, completionTimer *time.Timer
	defer func() {
		if idleTimer != nil {
			idleTimer.Stop()
		}
		if completionTimer != nil {
			completionTimer.Stop()
		}
	}()
	consume := func(line string) error {
		if line == "[DONE]" {
			a.completed = true
			terminal = true
			return nil
		}
		var v map[string]any
		if json.Unmarshal([]byte(line), &v) != nil {
			return errors.New("invalid model stream JSON")
		}
		if err := a.consume(v, false); err != nil {
			return err
		}
		// SSE heartbeats do not prove that an unfinished reply is progressing.
		if str(v["type"]) != "ping" && (a.msg.Content != "" || a.msg.Reasoning != "" || len(a.calls) > 0 || len(a.msg.Images) > 0) {
			if idleTimer == nil {
				idleTimer = time.AfterFunc(idleTimeout, func() { idleExpired.Store(true); cancelRequest() })
			} else {
				idleTimer.Reset(idleTimeout)
			}
		}
		if a.completed {
			if a.p != "openai" && a.p != "azure-gpt" || len(obj(v["usage"])) > 0 {
				terminal = true
			} else if completionTimer == nil {
				// OpenAI-compatible gateways may send usage after finish_reason.
				// Give that trailer a bounded grace period, never wait for socket EOF.
				completionTimer = time.AfterFunc(completionTimeout, func() { completionExpired.Store(true); cancelRequest() })
			}
		}
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if protocol(m) == "ollama" {
			if strings.TrimSpace(line) != "" {
				if e = consume(line); e != nil {
					return modelResult{Usage: a.usage}, e
				}
				if terminal {
					break
				}
			}
			continue
		}
		if line == "" {
			if len(data) > 0 {
				if e = consume(strings.Join(data, "\n")); e != nil {
					return modelResult{Usage: a.usage}, e
				}
				data = nil
				if terminal {
					break
				}
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if payload == "[DONE]" {
				if len(data) > 0 {
					if e = consume(strings.Join(data, "\n")); e != nil {
						return modelResult{Usage: a.usage}, e
					}
					data = nil
				}
				a.completed, terminal = true, true
				break
			}
			data = append(data, payload)
		}
	}
	if len(data) > 0 {
		if e = consume(strings.Join(data, "\n")); e != nil {
			return modelResult{Usage: a.usage}, e
		}
	}
	if e = scanner.Err(); e != nil {
		if ctx.Err() != nil {
			return modelResult{}, ctx.Err()
		}
		if !a.completed || !completionExpired.Load() {
			if idleExpired.Load() {
				return modelResult{Usage: a.usage}, ErrModelStreamIdle
			}
			return modelResult{Usage: a.usage}, errors.New("model stream interrupted")
		}
	}
	if ctx.Err() != nil {
		return modelResult{}, ctx.Err()
	}
	result, err := a.finish()
	result.Message.NativeProtocol = protocol(m)
	result.Message.NativeModel = m.Name
	return result, err
}

type accumulator struct {
	p           string
	model       Model
	msg         Message
	usage       Usage
	usageValues map[string]any
	calls       map[int]*Call
	native      map[int]map[string]any
	on          func(string, string)
	completed   bool
}

func newAccumulator(p string, on func(string, string)) *accumulator {
	return &accumulator{p: p, msg: Message{Role: "assistant"}, calls: map[int]*Call{}, native: map[int]map[string]any{}, on: on}
}
func (a *accumulator) delta(kind, s string) {
	if s == "" {
		return
	}
	if kind == "thinking" {
		a.msg.Reasoning += s
	} else {
		a.msg.Content += s
	}
	if a.on != nil {
		a.on(kind, s)
	}
}
func (a *accumulator) call(i int) *Call {
	if a.calls[i] == nil {
		a.calls[i] = &Call{}
	}
	return a.calls[i]
}
func usageCount(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, n >= 0
	case float64:
		if n >= 0 && n < 1<<50 && n == float64(int(n)) {
			return int(n), true
		}
	}
	return 0, false
}
func (a *accumulator) use(v map[string]any) {
	if a.usageValues == nil {
		a.usageValues = map[string]any{}
	}
	for key, value := range v {
		if value != nil {
			a.usageValues[key] = value
		}
	}
	u := a.usageValues
	pick := func(keys ...string) (int, bool) {
		for _, key := range keys {
			if n, ok := usageCount(u[key]); ok {
				return n, true
			}
		}
		return 0, false
	}
	if n, ok := pick("prompt_tokens", "input_tokens", "promptTokenCount"); ok {
		a.usage.Input = n
		a.usage.InputKnown = true
		a.usage.Known = true
	}
	if n, ok := pick("completion_tokens", "output_tokens", "candidatesTokenCount"); ok {
		a.usage.Output = n
		a.usage.OutputKnown = true
		a.usage.Known = true
	}
	if a.p == "claude" {
		read, readKnown := pick("cache_read_input_tokens")
		write, writeKnown := pick("cache_creation_input_tokens")
		if n, ok := pick("input_tokens"); ok || readKnown || writeKnown {
			a.usage.Input = n + read + write
			a.usage.InputKnown = true
			a.usage.Known = true
		}
	}
	if a.p == "gemini" {
		candidate, _ := pick("candidatesTokenCount")
		thoughts, thoughtKnown := pick("thoughtsTokenCount")
		a.usage.OutputKnown = a.usage.OutputKnown || thoughtKnown
		a.usage.Output = candidate + thoughts
	}
	var cached *int
	for _, value := range []any{obj(u["prompt_tokens_details"])["cached_tokens"], obj(u["input_tokens_details"])["cached_tokens"], u["prompt_cache_hit_tokens"], u["cache_read_input_tokens"], u["cachedContentTokenCount"]} {
		if n, ok := usageCount(value); ok {
			cached = &n
			break
		}
	}
	a.usage.CachedInput = cached
	a.usage.Total = a.usage.Input + a.usage.Output
	if n, ok := pick("total_tokens", "totalTokenCount"); ok {
		a.usage.Total = max(n, a.usage.Total)
		a.usage.Known = true
	}
}

// streamFailureDetail returns the provider's own error text from a stream error
// event so the failure names the real cause. Only this bounded, redacted text is
// exposed; raw payloads and request headers are never surfaced.
func streamFailureDetail(v map[string]any) string {
	for _, candidate := range []any{v["error"], v["message"], v} {
		if text := str(candidate); text != "" {
			return text
		}
		if item := obj(candidate); len(item) > 0 {
			if text := str(item["message"]); text != "" {
				return text
			}
			if text := str(item["code"]); text != "" {
				return text
			}
		}
	}
	return ""
}

func (a *accumulator) consume(v map[string]any, whole bool) error {
	if v["error"] != nil || str(v["type"]) == "error" {
		detail := redact(streamFailureDetail(v), Config{Model: a.model})
		if len(detail) > 500 {
			detail = detail[:500] + "…"
		}
		if detail != "" {
			return fmt.Errorf("model reported a stream error: %s", detail)
		}
		return errors.New("model reported a stream error")
	}
	switch a.p {
	case "openai", "azure-gpt":
		a.use(obj(v["usage"]))
		for _, c := range arr(v["choices"]) {
			choice := obj(c)
			if num(choice["index"], 0) != 0 {
				continue
			}
			d := obj(choice["delta"])
			if whole {
				d = obj(choice["message"])
				a.completed = true
			}
			a.content(d["content"])
			for _, v := range arr(d["images"]) {
				if img, ok := parseImageURL(str(obj(obj(v)["image_url"])["url"])); ok {
					a.addImage(img)
				}
			}
			a.delta("thinking", str(d["reasoning_content"])+str(d["reasoning"]))
			for _, v := range arr(d["tool_calls"]) {
				t := obj(v)
				f := obj(t["function"])
				i := num(t["index"], len(a.calls))
				if whole {
					i = num(t["index"], len(a.calls))
				}
				c := a.call(i)
				if id := str(t["id"]); id != "" {
					c.ID = id
				}
				c.Name += str(f["name"])
				c.Arguments += str(f["arguments"])
			}
			if reason := str(choice["finish_reason"]); reason != "" {
				if reason == "length" {
					return fmt.Errorf("%w; incomplete response discarded", ErrModelOutputLimit)
				}
				a.completed = true
			}
		}
	case "ollama":
		d := obj(v["message"])
		a.delta("message", str(d["content"]))
		a.delta("thinking", str(d["thinking"]))
		for _, v := range arr(d["tool_calls"]) {
			f := obj(obj(v)["function"])
			c := a.call(len(a.calls))
			c.Name = str(f["name"])
			c.Arguments = js(f["arguments"])
			c.ID = uid()
		}
		a.use(map[string]any{"input_tokens": v["prompt_eval_count"], "output_tokens": v["eval_count"]})
		if v["done"] == true {
			a.completed = true
		}
	case "openai-response":
		t := str(v["type"])
		i := num(v["output_index"], 0)
		switch t {
		case "response.output_text.delta", "response.refusal.delta":
			a.delta("message", str(v["delta"]))
		case "response.reasoning_summary_text.delta":
			a.delta("thinking", str(v["delta"]))
		case "response.output_item.added":
			n := obj(v["item"])
			a.native[i] = n
			if str(n["type"]) == "function_call" {
				c := a.call(i)
				c.ID = str(n["call_id"])
				c.Name = str(n["name"])
				c.Arguments = str(n["arguments"])
			}
		case "response.function_call_arguments.delta":
			a.call(i).Arguments += str(v["delta"])
		case "response.function_call_arguments.done":
			if arguments, ok := v["arguments"].(string); ok {
				a.call(i).Arguments = arguments
			}
		case "response.output_item.done":
			if err := a.responseItem(i, obj(v["item"])); err != nil {
				return err
			}
			a.responseImage(a.native[i])
		case "response.completed":
			a.completed = true
			response := obj(v["response"])
			a.use(obj(response["usage"]))
			for index, item := range arr(response["output"]) {
				if err := a.responseItem(index, obj(item)); err != nil {
					return err
				}
			}
		case "response.failed", "response.incomplete":
			response := obj(v["response"])
			a.use(obj(response["usage"]))
			if str(obj(response["incomplete_details"])["reason"]) == "max_output_tokens" {
				return ErrModelOutputLimit
			}
			return ErrModelIncomplete
		}
		if whole {
			a.use(obj(v["usage"]))
			if status := str(v["status"]); status == "incomplete" || status == "failed" {
				if str(obj(v["incomplete_details"])["reason"]) == "max_output_tokens" {
					return ErrModelOutputLimit
				}
				return ErrModelIncomplete
			}
			a.completed = true
			a.use(obj(v["usage"]))
			for i, x := range arr(v["output"]) {
				n := obj(x)
				a.native[i] = n
				a.responseImage(n)
				if str(n["type"]) == "function_call" {
					c := a.call(i)
					c.ID = str(n["call_id"])
					c.Name = str(n["name"])
					c.Arguments = str(n["arguments"])
				}
				for _, x := range arr(n["content"]) {
					a.delta("message", str(obj(x)["text"]))
				}
			}
		}
	case "claude":
		i := num(v["index"], 0)
		switch str(v["type"]) {
		case "message_start":
			a.use(obj(obj(v["message"])["usage"]))
		case "content_block_start":
			n := obj(v["content_block"])
			a.native[i] = n
			if str(n["type"]) == "tool_use" {
				c := a.call(i)
				c.ID = str(n["id"])
				c.Name = str(n["name"])
				if len(obj(n["input"])) > 0 {
					c.Arguments = js(n["input"])
				}
			}
			if s := str(n["text"]); s != "" {
				a.delta("message", s)
			}
		case "content_block_delta":
			d := obj(v["delta"])
			n := a.native[i]
			if n == nil {
				return errors.New("invalid content block")
			}
			switch str(d["type"]) {
			case "text_delta":
				s := str(d["text"])
				a.delta("message", s)
				n["text"] = str(n["text"]) + s
			case "thinking_delta":
				s := str(d["thinking"])
				a.delta("thinking", s)
				n["thinking"] = str(n["thinking"]) + s
			case "signature_delta":
				n["signature"] = str(n["signature"]) + str(d["signature"])
			case "input_json_delta":
				a.call(i).Arguments += str(d["partial_json"])
			}
		case "message_delta":
			a.use(obj(v["usage"]))
			if str(obj(v["delta"])["stop_reason"]) == "max_tokens" {
				return ErrModelOutputLimit
			}
		case "message_stop":
			a.completed = true
		}
		if whole {
			a.completed = true
			a.use(obj(v["usage"]))
			for i, x := range arr(v["content"]) {
				n := obj(x)
				a.native[i] = n
				a.delta("message", str(n["text"]))
				a.delta("thinking", str(n["thinking"]))
				if str(n["type"]) == "tool_use" {
					c := a.call(i)
					c.ID = str(n["id"])
					c.Name = str(n["name"])
					c.Arguments = js(n["input"])
				}
			}
		}
	case "gemini":
		a.use(obj(v["usageMetadata"]))
		for _, x := range arr(v["candidates"]) {
			candidate := obj(x)
			if num(candidate["index"], 0) != 0 {
				continue
			}
			if r := str(candidate["finishReason"]); r != "" {
				if r != "STOP" {
					return errors.New("Gemini response stopped without completion")
				}
				a.completed = true
			}
			for _, x := range arr(obj(candidate["content"])["parts"]) {
				part := obj(x)
				inline := obj(part["inlineData"])
				if strings.HasPrefix(str(inline["mimeType"]), "image/") {
					if images, err := ValidateImages([]ImageAttachment{{MimeType: str(inline["mimeType"]), Base64: str(inline["data"])}}); err == nil {
						a.addImage(images[0])
					}
				}
				if part["thought"] == true {
					a.delta("thinking", str(part["text"]))
				} else {
					a.delta("message", str(part["text"]))
				}
				if fc := obj(part["functionCall"]); len(fc) > 0 {
					c := a.call(len(a.calls))
					c.ID = str(fc["id"])
					if c.ID == "" {
						c.ID = uid()
						fc["id"] = c.ID
					}
					c.Name = str(fc["name"])
					c.Arguments = js(fc["args"])
				}
				a.native[len(a.native)] = part
			}
		}
	}
	return nil
}

// Responses done events carry the complete arguments. They replace the
// streamed prefix; concatenating them would duplicate JSON, while ignoring
// them loses late metadata or arguments from compatible providers.
func (a *accumulator) responseItem(index int, item map[string]any) error {
	a.native[index] = item
	if str(item["type"]) != "function_call" {
		return nil
	}
	call := a.call(index)
	for _, field := range []struct {
		name   string
		target *string
	}{{"call_id", &call.ID}, {"name", &call.Name}} {
		if value := str(item[field.name]); value != "" {
			if *field.target != "" && *field.target != value {
				return fmt.Errorf("%w: conflicting function identity", ErrInvalidModelToolCall)
			}
			*field.target = value
		}
	}
	if arguments, ok := item["arguments"].(string); ok {
		call.Arguments = arguments
	}
	return nil
}

func (a *accumulator) finish() (modelResult, error) {
	if !a.completed {
		return modelResult{Usage: a.usage}, ErrModelIncomplete
	}
	keys := []int{}
	for i := range a.calls {
		keys = append(keys, i)
	}
	sort.Ints(keys)
	ids := map[string]bool{}
	for _, i := range keys {
		c := a.calls[i]
		if c.ID == "" {
			c.ID = uid()
		}
		if c.Arguments == "" {
			c.Arguments = "{}"
		}
		if _, e := args(*c); e != nil {
			return modelResult{Usage: a.usage}, fmt.Errorf("%w: arguments must be a JSON object", ErrInvalidModelToolCall)
		}
		if c.Name == "" || ids[c.ID] {
			return modelResult{Usage: a.usage}, fmt.Errorf("%w: missing function name or duplicate call ID", ErrInvalidModelToolCall)
		}
		ids[c.ID] = true
		a.msg.Calls = append(a.msg.Calls, *c)
		if n := a.native[i]; n != nil && a.p == "claude" {
			arg, _ := args(*c)
			n["input"] = arg
		}
		if n := a.native[i]; n != nil && a.p == "openai-response" && str(n["type"]) == "function_call" {
			n["call_id"], n["name"], n["arguments"] = c.ID, c.Name, c.Arguments
		}
	}
	keys = nil
	for i := range a.native {
		keys = append(keys, i)
	}
	sort.Ints(keys)
	for _, i := range keys {
		b, _ := json.Marshal(a.native[i])
		a.msg.Native = append(a.msg.Native, b)
	}
	if a.msg.Content == "" && len(a.msg.Calls) == 0 && len(a.msg.Images) == 0 {
		return modelResult{}, errors.New("model returned no final text or image")
	}
	return modelResult{a.msg, a.usage}, nil
}

func Models(ctx context.Context, m Model) (any, error) {
	u, err := url.Parse(NormalizeProviderEndpoint(m.URL, protocol(m)))
	if err != nil {
		return nil, errors.New("invalid endpoint")
	}
	switch protocol(m) {
	case "openai", "openai-response":
		u.Path = strings.TrimSuffix(strings.TrimSuffix(u.Path, "/chat/completions"), "/responses") + "/models"
	case "claude":
		u.Path = strings.TrimSuffix(u.Path, "/messages") + "/models"
	case "gemini":
		i := strings.Index(u.Path, "/models/")
		if i < 0 {
			return map[string]any{"models": []string{}, "message": "请手动填写模型名称"}, nil
		}
		u.Path = u.Path[:i] + "/models"
		u.RawQuery = ""
	case "ollama":
		u.Path = "/api/tags"
	default:
		return map[string]any{"models": []string{}, "message": "此协议请手动填写模型名称"}, nil
	}
	if mimoAPI(u) && strings.HasPrefix(u.Path, "/anthropic/") {
		u.Path = "/v1/models"
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	names := []string{}
	limits := map[string]int{}
	reasoning := map[string]ReasoningCapability{}
	imageInput := map[string]bool{}
	seenNames, seenPages := map[string]bool{}, map[string]bool{}
	message := ""
	for page := 0; page < 20; page++ {
		if seenPages[u.String()] {
			return map[string]any{"models": []string{}, "message": "模型列表分页重复，请检查 API 或手动添加模型"}, nil
		}
		seenPages[u.String()] = true
		req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
		if err != nil {
			return nil, errors.New("invalid model-list endpoint")
		}
		if protocol(m) == "claude" {
			req.Header.Set("anthropic-version", "2023-06-01")
		}
		if m.Key != "" {
			switch protocol(m) {
			case "claude":
				if mimoAPI(req.URL) {
					req.Header.Set("Authorization", "Bearer "+m.Key)
				} else {
					req.Header.Set("x-api-key", m.Key)
				}
			case "gemini":
				req.Header.Set("x-goog-api-key", m.Key)
			default:
				req.Header.Set("Authorization", "Bearer "+m.Key)
			}
		}
		res, err := HTTPClient.Do(req)
		if err != nil {
			return map[string]any{"models": []string{}, "message": "无法获取完整模型列表，请检查接入地址和网络，或手动添加模型"}, nil
		}
		var body map[string]any
		decodeErr := json.NewDecoder(io.LimitReader(res.Body, 2<<20)).Decode(&body)
		res.Body.Close()
		if res.StatusCode == 401 || res.StatusCode == 403 {
			return map[string]any{"models": []string{}, "message": fmt.Sprintf("模型列表鉴权失败（HTTP %d），请检查 API Key 和接入区域", res.StatusCode)}, nil
		}
		if res.StatusCode != 200 || decodeErr != nil {
			return map[string]any{"models": []string{}, "message": "端点未提供可用模型列表；可手动添加模型 ID"}, nil
		}
		items := arr(body["data"])
		if len(items) == 0 {
			items = arr(body["models"])
		}
		for _, v := range items {
			item := obj(v)
			name := str(item["id"])
			if name == "" {
				name = str(item["name"])
			}
			if name == "" {
				name, _ = v.(string)
			}
			name = strings.TrimSpace(strings.TrimPrefix(name, "models/"))
			if name == "" || len(name) > 200 || strings.ContainsAny(name, "\r\n\x00") || seenNames[name] {
				continue
			}
			seenNames[name] = true
			names = append(names, name)
			if supported := imageInputMetadata(item); supported != nil {
				imageInput[name] = *supported
			}
			if capability := reasoningMetadata(item); capability != nil {
				reasoning[name] = *capability
			}
			for _, raw := range []any{item["context_length"], item["context_window"], item["max_context_tokens"], item["contextWindow"], item["inputTokenLimit"], obj(item["limits"])["context"]} {
				if limit, ok := usageCount(raw); ok && limit >= 2048 && limit <= 10000000 {
					limits[name] = limit
					break
				}
			}
			if len(names) >= 2048 {
				message = "模型列表较长，当前展示前 2048 个模型；也可以手动添加指定模型 ID。"
				break
			}
		}
		if len(names) >= 2048 {
			break
		}
		query := u.Query()
		switch {
		case protocol(m) == "gemini" && str(body["nextPageToken"]) != "":
			query.Set("pageToken", str(body["nextPageToken"]))
		case protocol(m) == "claude" && body["has_more"] == true:
			lastID := str(body["last_id"])
			if lastID == "" && len(items) > 0 {
				lastID = str(obj(items[len(items)-1])["id"])
			}
			if lastID == "" {
				return map[string]any{"models": []string{}, "message": "模型列表缺少分页信息，可手动添加模型 ID"}, nil
			}
			query.Set("after_id", lastID)
		default:
			return map[string]any{"models": names, "contextLimits": limits, "reasoningCapabilities": reasoning, "imageInputCapabilities": imageInput}, nil
		}
		u.RawQuery = query.Encode()
		if page == 19 {
			message = "模型列表页数较多，仅展示已获取的部分；也可以手动添加指定模型 ID。"
		}
	}
	return map[string]any{"models": names, "contextLimits": limits, "reasoningCapabilities": reasoning, "imageInputCapabilities": imageInput, "message": message}, nil
}

func imageInputMetadata(item map[string]any) *bool {
	for _, raw := range []any{item["supports_image_input"], item["supportsImageInput"], item["supports_vision"], obj(item["capabilities"])["vision"]} {
		if value, ok := raw.(bool); ok {
			return &value
		}
	}
	for _, raw := range []any{obj(item["architecture"])["input_modalities"], item["input_modalities"]} {
		values, ok := raw.([]any)
		if !ok {
			continue
		}
		supported := false
		for _, value := range values {
			if strings.EqualFold(str(value), "image") {
				supported = true
			}
		}
		return &supported
	}
	return nil
}

// Some compatible providers restart call IDs at each response. Keep persisted
// batches globally unambiguous and update only native call identifiers.
func resolveCallIDs(message *Message, history []Message) {
	seen := map[string]bool{}
	for _, m := range history {
		for _, c := range m.Calls {
			seen[c.ID] = true
		}
	}
	for i := range message.Calls {
		call := &message.Calls[i]
		old := call.ID
		if seen[old] {
			call.ID = uid()
			for i, raw := range message.Native {
				var item map[string]any
				if json.Unmarshal(raw, &item) != nil {
					continue
				}
				switch message.NativeProtocol {
				case "claude":
					if item["type"] == "tool_use" && item["id"] == old {
						item["id"] = call.ID
					}
				case "gemini":
					if fc := obj(item["functionCall"]); fc["id"] == old {
						fc["id"] = call.ID
					}
				case "openai-response":
					if item["type"] == "function_call" && item["call_id"] == old {
						item["call_id"] = call.ID
					}
				}
				message.Native[i], _ = json.Marshal(item)
			}
		}
		seen[call.ID] = true
	}
}

func (a *accumulator) addImage(img ImageAttachment) {
	if len(a.msg.Images) >= 4 {
		return
	}
	for _, old := range a.msg.Images {
		if old.Base64 == img.Base64 {
			return
		}
	}
	a.msg.Images = append(a.msg.Images, img)
	if a.on != nil {
		a.on("image", js(img))
	}
}
func (a *accumulator) responseImage(item map[string]any) {
	if item["type"] == "image_generation_call" {
		format := str(item["output_format"])
		if format == "" {
			format = "png"
		}
		images, err := ValidateImages([]ImageAttachment{{MimeType: "image/" + format, Base64: str(item["result"])}})
		if err == nil {
			a.addImage(images[0])
		}
	}
}
func (a *accumulator) content(value any) {
	if text, ok := value.(string); ok {
		a.delta("message", text)
		return
	}
	for _, v := range arr(value) {
		part := obj(v)
		a.delta("message", str(part["text"]))
		if img, ok := parseImageURL(str(obj(part["image_url"])["url"])); ok {
			a.addImage(img)
		}
	}
}
