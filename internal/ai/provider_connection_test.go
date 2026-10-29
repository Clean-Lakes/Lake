package ai

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"testing"
)

func TestProviderConnectionFailuresRetainOnlySafeCategories(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{io.EOF, "connection closed"},
		{io.ErrUnexpectedEOF, "connection closed"},
		{syscall.ECONNRESET, "connection closed"},
		{syscall.ECONNREFUSED, "connection refused"},
		{context.DeadlineExceeded, "request timed out"},
		{&net.DNSError{Err: "synthetic-secret", Name: "private-host"}, "name lookup failed"},
		{errors.New("synthetic-secret in arbitrary transport text"), "network transport failed"},
	} {
		t.Run(tc.want+"/"+tc.err.Error()[:1], func(t *testing.T) {
			previous := HTTPClient
			t.Cleanup(func() { HTTPClient = previous })
			HTTPClient = &http.Client{Transport: mimoTransportFunc(func(*http.Request) (*http.Response, error) {
				return nil, &url.Error{Op: "Post", URL: "https://user:synthetic-secret@private-host/path", Err: tc.err}
			})}
			_, err := Stream(context.Background(), Model{URL: "https://fixture.invalid", Name: "fixture"}, []Message{{Role: "user", Content: "ping"}}, nil, nil)
			if !errors.Is(err, ErrModelConnection) || !strings.HasSuffix(err.Error(), ": "+tc.want) {
				t.Fatal("missing safe connection category")
			}
			for _, secret := range []string{"synthetic-secret", "private-host", "https://"} {
				if strings.Contains(err.Error(), secret) {
					t.Fatal("transport diagnostic exposed request information")
				}
			}
		})
	}
}
