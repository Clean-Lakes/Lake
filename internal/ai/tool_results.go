package ai

import (
	"errors"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"os"
	"path/filepath"
)

const inlineToolResultBytes = 24000
const maxStoredToolResultBytes = 16 << 20

func (e *Engine) persistToolResult(s *session, c Config, call Call, payload string) (string, error) {
	if len(payload) <= inlineToolResultBytes {
		return payload, nil
	}
	s.mu.Lock()
	id := s.state.View.Session
	s.mu.Unlock()
	dir := filepath.Join(e.Dir, "results", id)
	if err := platform.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	resultID := uid()
	sourceBytes := len(payload)
	payload = utf8Prefix(redact(payload, c), maxStoredToolResultBytes)
	file, err := platform.OpenFile(filepath.Join(dir, resultID+".txt"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", err
	}
	_, writeErr := file.Write([]byte(payload))
	closeErr := file.Close()
	if writeErr != nil {
		return "", writeErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	return js(map[string]any{"result_id": resultID, "tool": call.Name, "preview": utf8Prefix(payload, 8000), "source_bytes": sourceBytes, "stored_bytes": len(payload), "source_truncated": len(payload) < sourceBytes, "next_offset": 0, "notice": "Full stored result is available via read_tool_result. This preview is incomplete; do not rerun the operation."}), nil
}
func (e *Engine) readToolResult(id string, a map[string]any) (any, error) {
	resultID := str(a["result_id"])
	if !identifier.MatchString(resultID) {
		return nil, errors.New("invalid result id")
	}
	b, err := os.ReadFile(filepath.Join(e.Dir, "results", id, resultID+".txt"))
	if err != nil {
		return nil, errors.New("result unavailable in this session")
	}
	offset, limit := num(a["offset"], 0), num(a["limit"], 8192)
	if offset < 0 || offset > len(b) || limit < 1 || limit > 32768 {
		return nil, errors.New("invalid result page")
	}
	if offset < len(b) && b[offset]&0xc0 == 0x80 {
		return nil, errors.New("offset splits a UTF-8 character")
	}
	page := utf8Prefix(string(b[offset:]), limit)
	if len(page) == 0 && offset < len(b) {
		return nil, errors.New("limit too small for next UTF-8 character")
	}
	out := map[string]any{"result_id": resultID, "content": page, "offset": offset, "source_bytes": len(b), "complete": offset+len(page) == len(b)}
	if offset+len(page) < len(b) {
		out["next_offset"] = offset + len(page)
	}
	return out, nil
}
