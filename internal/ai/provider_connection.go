package ai

import (
	"context"
	"errors"
	"io"
	"net"
	"syscall"
)

var ErrModelConnection = errors.New("cannot connect to model endpoint")

// Persist a bounded category, never url.Error's URL, headers or arbitrary text.
func modelConnectionReason(err error) string {
	var dns *net.DNSError
	var network net.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "request timed out"
	case errors.As(err, &dns):
		return "name lookup failed"
	case errors.As(err, &network) && network.Timeout():
		return "request timed out"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "connection refused"
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF), errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.EPIPE):
		return "connection closed"
	default:
		return "network transport failed"
	}
}
