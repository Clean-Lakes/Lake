import unittest
from check_backend_naming import exception


class NamingBoundaryTest(unittest.TestCase):
    def test_real_sdk_names_only_at_binding(self):
        line = "export {AgentRuntime} from '@zcode/core';"
        self.assertEqual(exception("runtime/typescript/sdk.ts", line), "SDK binding")
        self.assertIsNone(exception("runtime/typescript/agent.ts", line))
        self.assertIsNone(exception("runtime/typescript/sdk.ts", line + " // ZCode backend"))

    def test_legacy_identifiers_only_as_exact_compatibility_inputs(self):
        self.assertEqual(exception("web-agent/shared/runtime-compat.ts", "export const legacyNativeAgentSource = 'zcode_subagent';"), "legacy record input")
        self.assertIsNone(exception("web-agent/shared/runtime-compat.ts", "export const newSource = 'zcode_subagent';"))
        self.assertIsNone(exception("runtime/typescript/session-archive.ts", "const output = 'zcode-sessions.sqlite';"))

    def test_citations_do_not_allow_branding_in_prose(self):
        citation = "[Source](https://github.com/zai-org/ZCode/blob/pin/apps/zcode-cli/source.ts)"
        self.assertEqual(exception("docs/guide.md", citation), "source citation")
        self.assertIsNone(exception("docs/guide.md", "ZCode runtime " + citation))
        self.assertIsNone(exception("docs/guide.md", "[Source](https://example.com/ZCode)"))

    def test_attribution_is_not_a_blanket_product_exception(self):
        self.assertIsNone(exception("runtime/typescript/build.mjs", 'console.log("ZCode backend");'))
        self.assertIsNone(exception("docs/third-party-notices.md", "Lake uses the ZCode backend"))
        self.assertIsNone(exception(".gitignore", "/new-zcode-runtime/"))
        self.assertEqual(exception(".gitignore", "/.zcode/"), "legacy cache guard")
        self.assertIsNone(exception(".gitignore", "/.zcode/plans/"))

    def test_removed_external_brand_has_no_product_exception(self):
        line = "export const externalAgentNames:Record<ExternalAgentId,string>={'runtime-acp':'ZCode',codex:'Codex'};"
        self.assertIsNone(exception("web-agent/shared/external-agents.ts", line))
        self.assertIsNone(exception("web-agent/web/src/AgentAssignmentControl.tsx", line))
        self.assertIsNone(exception("web-agent/shared/external-agents.ts", line + " // ZCode backend"))
        self.assertIsNone(exception("runtime/typescript/acp/catalog.ts", "'runtime-acp': { name: 'ZCode', version: '3.17.2' },"))


if __name__ == "__main__":
    unittest.main()
