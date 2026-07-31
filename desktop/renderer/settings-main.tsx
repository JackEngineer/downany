import { createRoot } from "react-dom/client";

import { SettingsApp } from "./SettingsApp";
import "./styles.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<SettingsApp />);
}
