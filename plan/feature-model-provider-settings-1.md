---
goal: Replace Lake's single-model form with a ZCode-style provider and model manager
version: 1
date_created: 2026-10-12
last_updated: 2026-10-12
owner: Lake
status: Completed
tags: [feature, settings, models]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Manage multiple providers and per-provider models in a wide two-column settings dialog. Preserve the existing model and keep each provider's key isolated. Switch enabled models from the composer without restarting the client.

## 1. Requirements & Constraints

- **REQ-001**: Show a provider list on the left and editable name, Base URL, API format, masked key and model list on the right.
- **REQ-002**: Add, rename, enable, disable and delete providers; add, edit, enable, disable and delete model entries, including context size and image capabilities.
- **REQ-003**: Offer saved enabled models from every provider in the composer and switch the correct provider credentials immediately.
- **REQ-004**: Preserve existing single-model settings through migration and compatibility APIs; distinguish an empty key update from explicit clearing.
- **SEC-001**: Never return saved API keys to the browser, display them in validation errors, or store them outside private files under Lake secrets.
- **CON-001**: Build bin/lake through scripts/build_lake.sh and the installed macOS app through scripts/build_lake_desktop.sh; preserve current backend and terminal connections.
- **PAT-001**: Follow ZCode Navigation.tsx and Detail.tsx's two-column arrangement, without importing its account product integrations.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Persist provider profiles and isolate keys.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add internal/web/model_providers.go with provider catalog migration, key references, scoped CRUD, model activation and Base URL normalization. | Yes | 2026-10-12 |
| TASK-002 | Integrate active providers and legacy APIs in internal/web/model.go; retain explicit context size when adding capacity metadata. Depend on TASK-001. | Yes | 2026-10-12 |
| TASK-003 | Add authenticated provider CRUD, connection test, discovery and model activation routes in internal/web/server.go. Depend on TASK-001. | Yes | 2026-10-12 |

### Implementation Phase 2

- **GOAL-002**: Build the settings manager and composer model selector.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Add ModelSettings.tsx and modelProviderState.ts for a provider rail, editor, model rows and inline model editor; update contracts.ts and api.ts. Depend on TASK-003. | Yes | 2026-10-12 |
| TASK-005 | Replace the single-model modal and obsolete form state in App.tsx; group composer choices by provider and activate by provider/model identifiers. Depend on TASK-004. | Yes | 2026-10-12 |
| TASK-006 | Add responsive styles with fixed header/footer and independently scrolling provider/editor panes; keep conversation settings as a separate tab. Depend on TASK-004. | Yes | 2026-10-12 |

### Implementation Phase 3

- **GOAL-003**: Verify persistence, credential safety and interaction.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | Test migration, protocol endpoint generation, key isolation, blank-key preservation, disabled models, deletion fallback and context size. Depend on TASK-003. | Yes | 2026-10-12 |
| TASK-008 | Run frontend checks/tests and Go race tests; verify provider CRUD and model switching against a synthetic local backend in the browser. Depend on TASK-005 and TASK-006. | Yes | 2026-10-12 |
| TASK-009 | Build/install the signed app, capture the verified settings interface, document usage and mark the plan complete. Depend on TASK-008. | Yes | 2026-10-12 |

## 3. Alternatives

- **ALT-001**: A visual-only split of the current form cannot preserve several credentials and model lists; add real provider persistence.
- **ALT-002**: ZCode account login and subscription integrations exceed the requested settings UI and require separate credentials; retain Lake's API-key providers.

## 4. Dependencies

- **DEP-001**: Existing privateFile and atomicFile functions enforce private credential storage.
- **DEP-002**: Existing ai.Stream and ai.Models implement the supported provider protocols and connection tests.

## 5. Files

- **FILE-001**: internal/web/model_providers.go, model.go and server.go implement persistence and API routes.
- **FILE-002**: web-agent/web/src/ModelSettings.tsx, modelProviderState.ts, App.tsx, api.ts, modelSettings.css and shared/contracts.ts implement the interface.
- **FILE-003**: internal/web/model_providers_test.go and web-agent/web/test/model-provider-state.test.ts validate behavior; README.md documents settings.

## 6. Testing

- **TEST-001**: Migrate a legacy model and verify the same active endpoint/name/key without exposing the key in responses or provider metadata.
- **TEST-002**: Save two providers with distinct credentials; editing/testing/switching one must never reuse the other's key.
- **TEST-003**: Disable and delete active providers/models, verify a valid fallback or unconfigured state, and preserve other profiles.
- **TEST-004**: Normalize root, versioned and prefixed Base URLs for each supported protocol; preserve explicit full endpoint URLs and reject credentials in URLs.
- **TEST-005**: Verify provider selection, model addition/editing, immediate activation, saved-key masking and responsive scrolling in the browser.

## 7. Risks & Assumptions

- **RISK-001**: Compatible services use different Base URL prefixes; support both base URLs and explicit complete endpoints.
- **ASSUMPTION-001**: Saved keys remain server-side; newly typed keys are masked as well.

## 8. Related Specifications / Further Reading

[Credential rules](../AGENTS.md) · [ZCode provider navigation](../third_party/zcode/packages/ui/src/settings/model-provider-section/Navigation.tsx) · [ZCode provider editor](../third_party/zcode/packages/ui/src/settings/model-provider-section/Detail.tsx)

## 9. Validation Results

- TypeScript typecheck, 62 frontend tests and the provider-focused Go race suite passed.
- Browser verified provider/model creation, saved-key masking, immediate model activation, grouped composer choices, disabled-provider filtering, draft retention and separate conversation settings. Desktop 1280×720 and narrow 390×844 layouts retained the footer and avoided horizontal dialog overflow.
- Built and installed the signed macOS app with `scripts/build_lake_desktop.sh --install`; preserved the running user backend and its terminal connections. The existing process still serves the old embedded frontend until the backend is switched.
- The full `go test -race ./...` run exposed failures in the independently modified multi-agent journal/context tests and AI snapshot pending-pointer handling. Provider tests passed; those unrelated failures were recorded without changing the concurrent work.
- [Validation report](../docs/validation/lake-model-provider-settings.json) · [Verified interface](../docs/validation/lake-model-provider-settings.png)
