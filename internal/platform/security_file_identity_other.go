//go:build !unix

package platform

import (
	"errors"
	"os"
)

func SecurityFileIdentity(os.FileInfo) (string, error) {
	return "", errors.New("security: bounded file identity unsupported on this platform")
}
func SecurityFileStableIdentity(os.FileInfo) (string, error) {
	return "", errors.New("security: bounded file identity unsupported on this platform")
}
func OpenSecurityRootFile(*os.Root, string) (*os.File, error) {
	return nil, errors.New("security: bounded file open unsupported on this platform")
}
