package main

import (
	"encoding/xml"
	"io"
	"strings"
	"testing"
)

func TestScheduleLaunchPlistEscapesPaths(t *testing.T) {
	plist := scheduleLaunchPlist("/tmp/Lake & signed/lake", "/tmp/user <lake>", "/tmp/log")
	decoder := xml.NewDecoder(strings.NewReader(plist))
	for {
		_, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if !strings.Contains(plist, "/tmp/Lake &amp; signed/lake") || !strings.Contains(plist, "/tmp/user &lt;lake&gt;") || !strings.Contains(plist, scheduleLaunchLabel) {
		t.Fatal("plist omitted escaped fields")
	}
}
