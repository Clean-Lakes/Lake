# Pilot operation preferences

Date: 2026-11-09. Base develop: `866ef43350e4d06040d491aa74dee970daab4ba6`. The user explicitly requested that specialists follow Pilot permissions and that enabling automatic operation suppress additional confirmation prompts, with the other operation categories audited as well.

## Diagnosis and scope

Read-only inspection of the installed production 0.3.30 showed all six Pilot automatic switches enabled. Its Worker was waiting on Bash with SDK risk high; both the actual pending Python script and a minimal Python read command were classified dangerous. The Worker did read Pilot options, but `alwaysAsk` forced an additional prompt. No production approval, setting, command or history was changed during diagnosis.

The implementation centralizes the category switch and its public SDK session rule/capability projection. It retains build mode and does not modify upstream source, add an executor/model loop or turn risk/unknown results into read-only evidence or acceptance. A compatible legacy single/either ask no longer overrides an enabled automatic category; hard deny, unsupported limits or task-grant requirements remain actual rejections.

| Managed operation | Pilot authority | Findings and change |
| --- | --- | --- |
| Bash / inspect_host | silentCommands | Removed risk- and single-ask forced prompts; risk and resource preflight remain unchanged |
| Read / FindFiles / SearchText / aliases / list_project_files | silentReadFiles | Unified resolver and SDK rules, including disabled read/search behavior |
| Write / Edit | silentWriteFiles | Same authority in independent Worker and native child |
| Skill / load_skill | silentReadFiles | Same native and registered skill path, with real content and source fences |
| WebFetch | silentReadFiles | Uses the read category, while URL/current project validation stays in place; audited code path, no new external web-service QA claimed |
| MySQL metadata/DDL/rows | silentReadSQL | Removed secondary single-ask override, retains actual read-only transactions, pins and credentials |
| MCP tools/list and tools/call | silentMCPCalls | Removed mandatory stdio discovery prompt and unrelated-server scan; disabled switch gates both discovery and calls |
| MCP metadata list | Metadata only | Can list enabled ask-capable bindings without connecting; denies and opt-outs still hide/reject them |
| Native child controls | Original task authority | Child business tools inherit identical Pilot category rules; task/control ownership stays separate |
| Human PTY opening/input/handoff | Explicit human console protocol | Native Worker Bash uses its own bound execution port, not the human PTY. No new autonomous terminal-opening tool is added; first/changed SSH trust and human control transfer are unchanged |
| Plan / prerequisite questions | Existing explicit protocols | No automatic answer, plan acceptance or host-key acceptance is synthesized |

Worker and role-channel options now project the effective Pilot defaults/values. Their configure API rejects independent switch writes, preventing a second permission store. Pilot preference updates reject nonboolean values. An explicit migrated DenyLocal flag is also checked for Bash, consistent with the existing MCP local deny.

## Local verification

Using the repository's pinned Node 24.14.0 toolchain:

| Check | Result |
| --- | --- |
| TS typecheck | Passed |
| Source tests | 251 passed, 4 existing conditional skips |
| Full bundled real-SDK suite | 208 passed |
| Frontend typecheck / full suite | Passed; 768 tests |
| ADK boundary / backend naming / diff | Passed; zero naming violations |

The SDK cases execute actual local Python from Pilot, Worker and general-purpose child with automatic on/off, actual owned-fixture deletion with automatic on, child Write, file searches/Read and Skill content, real HTTP and stdio MCP discovery/call, and MySQL's existing read/approval cases. They verify one operation/receipt and no implicit read-only promotion. Disabled categories stop before resource I/O, including both MCP stages. Current-policy updates cannot approve an old pending Worker call; current explicit deny/local deny reject without command execution or task pass. Existing SSH trust, private storage, wrong resource/configuration, stop, Plan, Memory, opaque MCP unknown and acceptance regressions passed.

An initial local invocation used ambient Node 22, incompatible with two existing frontend loader tests; those were rerun on pinned Node 24 with all 768 passing. Test fixture quoting and the previous MCP test's now-two-stage approval sequence were corrected; no real execution failure or missing guard was hidden by deleting a test. The old unresolved MCP case still proves zero tools/call and zero accepted operation after its actual approval.

## Dev and delivery

Signed clean Dev installation and real-model/native checks are pending at this initial validation commit. Record the exact installed SHA, checks and any limits after execution. This request does not authorize merging the new PR, changing production configuration, installing production or publishing a new version. Existing production pending approvals are not auto-approved or replayed by this work.
