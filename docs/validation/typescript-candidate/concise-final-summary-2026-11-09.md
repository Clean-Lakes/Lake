# Concise final chat conclusions

Date: 2026-11-09. The user reported that the delivered specialist conclusion still read like a lengthy investigation report. Read-only inspection of the corresponding installed production reply found one canonical 605-character message containing four paragraphs. It was not duplicated progress delivery. No production setting, approval, history or infrastructure was changed.

## Behavior

Ordinary conversation, Pilot and Workers now default to one compact paragraph of two or three short sentences: the answer or supported judgment, decisive evidence, and material uncertainty or a necessary next step. Chinese length guidance is usually 80–180 characters, shorter for simple results. Complex investigation alone no longer asks for a long final report. A shared instruction also accompanies the `work_finish.summary` schema and the native missing-report Stop reminder, including explicit-plan result submission.

Explicit requests for a detailed or structured deliverable retain that format. This is model communication guidance, not a hard character/paragraph validator: it does not truncate, concatenate or overwrite reports, create a second summarizer/model turn, infer success, change outcome/acceptance, repeat commands or write a new report file. Existing receipts and any requested report file retain details; material failures and uncertainty take priority over brevity. Historical chat messages are unchanged.

## Verification

Functional source and installed clean Dev SHA: `b4ca4b28ef2fca282996560e96ba0fce52e85bf9`, based on develop `866ef43350e4d06040d491aa74dee970daab4ba6`, including the PR's Pilot permission changes. Pinned Node 24.14.0 TypeScript typecheck passed; source suite 251 passed / four existing conditional skips; all 208 bundled SDK tests passed. The final-report continuation, cancellation, partial-report, task acceptance, permission and delivery regressions remain passing. ADK boundary, backend naming (zero violations) and diff checks passed. No implementation-mirroring prompt-text tests were added.

`scripts/build_lake_desktop.sh --dev --install` and deep/strict bundle signature verification passed. Installed `build-origin.json` records TypeScript, dirty false, the source SHA above and backend SHA256 `7b28ce5ab01af7f670084f7d2dd73b0b6ee679d596fb54de7ddfef83ef463451`. The unchanged Web frontend was rebuilt by that script; its full 768-test suite passed on the earlier permission commit and was not rerun for these three prompt/tool-description-only edits. No Go/native source or production package was changed.

The existing configured real model (`gpt-6.1-terra`) ran two independent tasks through the same stable specialist in the Dev-only project “结论回执验证 2026-11-09”. It read a multi-paragraph fictional local investigation fixture; the input for the first case requested a judgment without prescribing brevity. Neither task ran Shell, created children, accessed remote infrastructure or changed the file. Each used one actual Read plus work_finish, finished with host acceptance pass and delivered identical text to Pilot and the specialist channel.

| Case | Task | Observed output |
| --- | --- | --- |
| Default conclusion | `st_8fa78de449f2ebf4af6f0538f3c78ea1` | 91 characters, one paragraph, no newline; preserved unproven monitoring causality and unknown reboot cause |
| Explicit detailed report | `st_889cb1aaa9fda5af55e190002b2de61e` | 979 characters, four numbered findings plus limitations and next steps; explicit format retained |

The actual default reply was:

> 记录尚未证实监控与这次重启存在因果关系：连接模式与监控采集一致，但没有保留实际执行的命令。重启的具体原因也未查明，关键缺口是事发时虚拟化平台和宿主机的相关事件；以上均为虚构测试记录。

Native Lake Dev review confirmed the short paragraph and the separately requested detailed report in the specialist channel. The original HexHub 服务器 / 发布专员 view was restored. These are local fictional-record communication tests, not a fresh production investigation or proof of any real reboot diagnosis. The missing-report repair path remains covered by the existing controlled-provider SDK cases; the real-model cases submitted normally. The QA project is retained for review. Subsequent changes add this evidence record only; PR merge and a new production release are not performed by this fix.
