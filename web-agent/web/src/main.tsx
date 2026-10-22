import './sreCollaboration.css';
import "./agentQuestion.css";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { NativeModelPanelPage } from "./NativeModelPanelPage";
import "./appSelect.css";
import "./providerIcon.css";
import "./composerModelSelect.css";
import "./composerCompletion.css";
import "./assistantProse.css";
import "./objectReferences.css";
import { initializeAppearance } from "./appearance";
import { WindowsChrome } from "./WindowsChrome";

initializeAppearance();
if (window.lakeWindowsChrome) document.documentElement.classList.add("lake-windows-chrome");

const root = document.getElementById("root");
if (!root) throw new Error("缺少应用挂载点");
const nativePanel=window.lakeNativeModelPanel?.role==="panel";
createRoot(root).render(<React.StrictMode>{nativePanel?<NativeModelPanelPage/>:<><App /><WindowsChrome /></>}</React.StrictMode>);
