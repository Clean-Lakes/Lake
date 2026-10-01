//go:build darwin && cgo

package credential

import (
	"bytes"
	"os"
	"testing"
)

func TestKeychainRoundTrip(t *testing.T) {
	if os.Getenv("LAKE_TEST_KEYCHAIN") != "1" {
		t.Skip("set LAKE_TEST_KEYCHAIN=1 to test the user's macOS keychain")
	}
	vault := Keychain{}
	want := []byte("Lake temporary keychain test value")
	ref, err := vault.Import(want)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := vault.Delete(ref); err != nil {
			t.Errorf("delete temporary keychain item: %v", err)
		}
	}()
	got, err := vault.Load(ref)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("keychain round trip changed the value")
	}
}

func TestModelAPIKeyRoundTrip(t *testing.T) {
	if os.Getenv("LAKE_TEST_KEYCHAIN") != "1" {
		t.Skip("set LAKE_TEST_KEYCHAIN=1 to test the user's macOS keychain")
	}
	vault := Keychain{}
	const provider = "lake-model-test"
	want := []byte("temporary-test-api-key")
	if err := vault.PutModelAPIKey(provider, want); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := vault.DeleteModelAPIKey(provider); err != nil {
			t.Errorf("delete temporary model key: %v", err)
		}
	}()
	got, err := vault.LoadModelAPIKey(provider)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("model keychain round trip changed the value")
	}
	replacement := []byte("replacement-test-api-key")
	if err := vault.PutModelAPIKey(provider, replacement); err != nil {
		t.Fatal(err)
	}
	got, err = vault.LoadModelAPIKey(provider)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, replacement) {
		t.Fatal("model keychain replacement did not take effect")
	}
}
