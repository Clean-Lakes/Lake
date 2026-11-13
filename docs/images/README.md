# README images

`wechat.svg` is the WeChat logo from [SuperTinyIcons](https://github.com/edent/SuperTinyIcons/blob/master/images/svg/wechat.svg), distributed under the [MIT license](wechat.LICENSE). It is stored locally for the README contact section.

The README images show the Lake v0.3.33 interface in light and dark themes:

- `lake-workbench-light.jpg` / `lake-workbench-dark.jpg`: Pilot and three specialists replying with their own identities, including native Lake and Codex Agent logos. Viewport: **1200 × 840**.
- `lake-specialist-tasks-light.jpg` / `lake-specialist-tasks-dark.jpg`: one specialist's four task records, executor and dates. Viewport: **1200 × 780**.

These are direct browser captures of the actual React App with a macOS presentation frame, not native OS screenshots. The workspace, components, icons and themes use the shipping v0.3.33 application source, production commit `4fe9c9a3017f4867eae9b36cf685b95289930d3f`. The fixture supplies records and the frame; it does not modify application components or styles.

Capture fixture: [`readme-macos.html`](../../web-agent/web/test/fixtures/readme-macos.html) and [`readme-macos.tsx`](../../web-agent/web/test/fixtures/readme-macos.tsx). Its data is independent of the older SRE demonstration. Names, resources, messages, versions and measurements are fictional. The fixture uses read-only in-memory responses, rejects mutating API requests with HTTP 405, and substitutes local EventSource events. It uses no backend, Lake home, credentials, model service or business resource.

To reproduce the images, use this README update's capture fixture with the application source above, install the locked dependencies, and run from the repository root:

```sh
pnpm --dir web-agent exec vite --config web/vite.config.ts --host 127.0.0.1 --port 5198 --strictPort
```

Open `/test/fixtures/readme-macos.html?theme=light&session=demo-session-0` and the matching `theme=dark` URL. Capture the Pilot conversation at 1200 × 840. Click “服务器运维专员”, wait for four task rows, and capture at 1200 × 780. Use Chromium, device scale 1, reduced motion and JPEG quality 90; wait for fonts and layout to settle, move the pointer to the outer margin, and capture the viewport directly with `Page.captureScreenshot`. No image compositing or screenshot retouching is used. Stop the temporary Vite host afterward.

Both language READMEs share these images and select the matching light/dark asset with `<picture>`. The application UI is Chinese. Asset hashes, fixture provenance and checks are recorded in [`readme-0.3.33.json`](../validation/readme-0.3.33.json).
