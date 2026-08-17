import { createRoot } from "react-dom/client";

import { SettingsApp } from "./SettingsApp";
import "./styles.css";

document.documentElement.dataset.platform = window.api.platform;

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<SettingsApp />);
}
