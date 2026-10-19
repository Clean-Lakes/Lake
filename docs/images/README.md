# README images

`wechat.svg` is the WeChat logo from [SuperTinyIcons](https://github.com/edent/SuperTinyIcons/blob/master/images/svg/wechat.svg), distributed under the [MIT license](wechat.LICENSE). It is stored locally for the README contact section.

`lake-workbench-light.jpg` and `lake-workbench-dark.jpg` show the current Lake macOS workspace in light and dark themes, with the red, yellow and green window controls.

These are browser-rendered presentation images of the actual React App with a standard macOS window frame, not unmodified native OS captures. Native automation overlays obscured the system window controls, so the presentation frame is rendered by the isolated fixture. The workspace, components, icons and theme come from the current application; the frame does not change shipping UI.

Capture fixture: `web-agent/web/test/fixtures/readme-macos.html`, extending the read-only `readme-workbench` fixture. All project names, resources, conversations, timestamps, versions and measurements in the images are fictional. No real data, credentials, DEV badge, developer controls, model requests or resource commands are included. Mutating API requests are rejected.

Run the Vite frontend with `npm --prefix web-agent run dev:web -- --host 127.0.0.1 --port 5194 --strictPort`, then capture `/test/fixtures/readme-macos.html?theme=light` and `?theme=dark` at **1440 × 900** with the full-page browser screenshot API. The README picture element follows the reader’s color scheme.
