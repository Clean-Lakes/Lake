# README images

`wechat.svg` is the WeChat logo from [SuperTinyIcons](https://github.com/edent/SuperTinyIcons/blob/master/images/svg/wechat.svg), distributed under the [MIT license](wechat.LICENSE). It is stored locally for the README contact section.

`lake-workbench-light.jpg` and `lake-workbench-dark.jpg` show the Lake v0.3.21 macOS workspace from master commit `8a0f63962e4d110b8eb20eaacc464a9ca63d77cb` in light and dark themes, with the red, yellow and green window controls.

These are browser-rendered presentation images of the actual React App with a standard macOS window frame, not unmodified native OS captures. Native automation overlays obscured the system window controls, so the presentation frame is rendered by the isolated fixture. The workspace, components, icons and theme come from the current application; the frame does not change shipping UI.

Capture fixture: `web-agent/web/test/fixtures/readme-macos.html`, extending the read-only `readme-workbench` fixture. All project names, resources, conversations, timestamps, versions and measurements in the images are fictional. No real data, credentials, DEV badge, developer controls, model requests or resource commands are included. Mutating API requests are rejected.

To reproduce this release preview, extract `web-agent/` from the source commit above into a temporary directory, install its locked dependencies, and run the following command from that directory. This keeps newer develop UI out of the production README. No Go backend or Lake home is required.

Run the Vite frontend with `npm --prefix web-agent run dev:web -- --host 127.0.0.1 --port 5194 --strictPort`, then capture `/test/fixtures/readme-macos.html?theme=light` and `?theme=dark` at **1440 × 900** with the full-page browser screenshot API (Chrome, device scale 1, JPEG quality 90, reduced motion). Expand both resource folders before capture and move the pointer out of the workspace. Stop the temporary frontend host afterward. Both `README.md` (English default) and `README.zh-CN.md` share these images; their picture elements follow the reader’s color scheme. The application UI in these screenshots remains Chinese.
