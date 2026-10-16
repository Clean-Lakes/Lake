package platform

import (
	"path/filepath"
	"strconv"
)

// SSHFileOption renders a path-valued OpenSSH option for the command line.
//
// OpenSSH parses the value of an -o option itself, so a path containing spaces,
// quotes or comment characters has to be quoted. Quoting alone is not enough on
// Windows: Go only wraps an argument in quotes when it contains a space, so a
// quoted value without one reaches ssh as \"path\" — outside any quoted argument
// — and the bundled OpenSSH aborts with "command-line line 0: invalid quotes"
// before it opens its own diagnostics, leaving only a generic connection error.
// The blank after "=" keeps both sides in agreement: OpenSSH skips leading
// whitespace in the value, and Go quotes the argument so the path arrives intact
// whatever it contains.
func SSHFileOption(name, value string) string {
	return name + "= " + strconv.Quote(filepath.ToSlash(value))
}
