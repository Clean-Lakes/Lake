import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("缺少应用挂载点");
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
