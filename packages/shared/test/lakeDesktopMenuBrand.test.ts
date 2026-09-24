import assert from "node:assert/strict";
import test from "node:test";
import { desktopMenuMessages } from "../src/desktopMenu.js";

test("desktop menus introduce the application as Lake", () => {
  for (const messages of Object.values(desktopMenuMessages)) {
    assert.match(messages["titleBar.menu.help.about"], /Lake/);
    assert.equal(messages["tray.tooltip"], "Lake");
    assert.doesNotMatch(messages["tray.menu.openZCode"], /ZCode/);
  }
});
