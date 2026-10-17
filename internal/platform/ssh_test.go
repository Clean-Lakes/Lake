package platform

import "testing"

func TestSSHFileOptionQuotesValueAfterBlank(t *testing.T) {
	// The blank after "=" is load-bearing on Windows: it is what makes os/exec
	// quote the whole argument, so the value's own quotes reach ssh intact.
	got := SSHFileOption("UserKnownHostsFile", "C:/Users/O'Brien/.lake/secrets/kh")
	want := `UserKnownHostsFile= "C:/Users/O'Brien/.lake/secrets/kh"`
	if got != want {
		t.Fatalf("SSHFileOption = %q, want %q", got, want)
	}
}
