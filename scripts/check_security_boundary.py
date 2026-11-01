#!/usr/bin/env python3
"""Audit static tool coverage and security boundary hooks (not a sandbox proof).

Runtime zero-I/O, revocation, recovery and adapter tests remain required. This
audit fails when a catalog entry loses registration or a required sink loses
its boundary call; it deliberately makes no claim about remote OS confinement.
"""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
result = subprocess.run(
    ["go", "test", "./internal/ai", "./internal/security", "-run",
     "^(TestSecurityEntrypointInventory|TestKernelRegistryCoversInventory)$", "-count=1"],
    cwd=root, check=False,
)
if result.returncode:
    sys.exit(result.returncode)

required = {
    "internal/ai/security_execution.go": ["PrepareCatalogOperation", "dispatchNativeOperation", "securityPermitContext", "RequireSecurityBridgeContext"],
    "internal/ai/adk_operations.go": ["withSecurityDispatchBarrier", "acquirePreparedSecurityPermitTx", "RefundSecurityPermitTx"],
    "internal/ai/security_coordinator.go": ["ValidateExecutionOwner", "CheckResourceWriteBlock", "applyLegacySessionPolicyTx"],
    "internal/ai/adk_session.go": ["pauseSecurityTasksAfterRestart", "securityPolicyModels", "securityRecoveryModels"],
    "internal/ai/runtime.go": ["requireSecurityAdapterContext", "checkFrozenRuntimeCommand"],
    "internal/ai/provider_runtime.go": ["checkSecurityProviderContext", "securityProviderDeadlineKey"],
    "internal/ai/adk_provider_step.go": ["securityProviderContext"],
    "internal/ai/security_stdio.go": ["configureSecurityStdio", "recordSecurityStdioEntry"],
    "internal/web/security_stdio.go": ["NewSecurityStdioHost", "h.server.bridge"],
    "internal/ai/services.go": ["requireSecurityAdapterContext"],
    "internal/ai/kubernetes.go": ["requireSecurityAdapterContext"],
    "internal/web/agent.go": ["RequireSecurityBridgeContext"],
    "internal/web/server.go": ["initializeSecurityCatalog", "securityMigrationRoute", "securityBoundaryRoute", "securityWorkRoute"],
}
failures = []
for path, hooks in required.items():
    source = (root / path).read_text()
    for hook in hooks:
        if hook not in source:
            failures.append(f"{path}: missing boundary {hook}")

for path in (root / "internal/security").glob("*.go"):
    if path.name.endswith("_test.go"):
        continue
    source = path.read_text()
    for forbidden in ('"github.com/Clean-Lakes/Lake/internal/ai"',
                      '"github.com/Clean-Lakes/Lake/internal/web"',
                      '"google.golang.org/adk', '"gorm.io/'):
        if forbidden in source:
            failures.append(f"{path.relative_to(root)}: domain imports runtime/storage")
if failures:
    print("\n".join(failures), file=sys.stderr)
    sys.exit(1)
print("Security static registry and boundary hooks passed; runtime/real-adapter evidence is separate.")
