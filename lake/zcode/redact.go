package zcode

import (
	"bytes"
	"io"
)

// Provider errors can echo authentication values. Retain enough bytes between
// reads to redact a key even when an SSE or HTTP chunk splits it in two.
type redactedBody struct {
	io.ReadCloser
	key, pending, ready []byte
	end                 error
}

func (r *redactedBody) Read(out []byte) (int, error) {
	if len(out) == 0 {
		return 0, nil
	}
	if len(r.key) == 0 {
		return r.ReadCloser.Read(out)
	}
	for {
		if len(r.ready) > 0 {
			n := copy(out, r.ready)
			r.ready = r.ready[n:]
			return n, nil
		}
		if index := bytes.Index(r.pending, r.key); index >= 0 {
			r.ready = append(r.ready, r.pending[:index]...)
			r.ready = append(r.ready, "[redacted]"...)
			r.pending = r.pending[index+len(r.key):]
			continue
		}
		safe := len(r.pending)
		if r.end == nil {
			safe -= len(r.key) - 1
		}
		if safe > 0 {
			r.ready = append(r.ready, r.pending[:safe]...)
			r.pending = r.pending[safe:]
			continue
		}
		if r.end != nil {
			return 0, r.end
		}
		buf := make([]byte, 4096)
		n, err := r.ReadCloser.Read(buf)
		r.pending = append(r.pending, buf[:n]...)
		r.end = err
	}
}
