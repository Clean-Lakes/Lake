# Silent diagnostic command classification

The reported mount-inspection command was incorrectly marked dangerous because the classifier scanned `/dev/disk` inside a grep regular expression as a disk operand. `hdiutil info` was also absent from the query allowlist, and stderr suppression to `/dev/null` was treated as generic file output.

The Go classifier now recognizes `hdiutil info` and `hdiutil info -plist`, distinguishes grep patterns from input files, and supports literal stdout/stderr discard redirects (`>`, `1>`, `2>` to `/dev/null`). Safe command reconstruction preserves descriptor placement and quoting, including quoted numeric arguments. Credential paths, raw-device input, destructive commands, shell substitution and arbitrary file redirects retain their previous protections. `hdiutil` attach/detach/mount and other disk-changing actions require target confirmation.

`TestSilentDiagnosticCommandUsesSavedPermission` executes the exact reported command through a real PTY and model-tool loop with `silentCommands=true`; it completes without an approval. Updated behavior on 2026-10-11: turning ordinary command silence off does not restore readonly query approvals. See lake-network-readonly.md. `TestReadOnlyQueryPolicy` covers the reported pipeline, grep pattern/file operands, protected raw devices, null redirects, unsupported redirects and real PTY rendering/output. Existing dangerous-command confirmation tests remain passing.

Service deployment preserves the user's saved conversation settings. Old history is not replayed or rewritten; newly issued tool calls use the repaired classification.
