import { useEffect } from "react";
import { createRoot } from "react-dom/client";

import { Shell } from "./components/Shell";
import { startAppSession } from "./lib/appSession";
import "./styles.css";

document.documentElement.dataset.platform = window.api.platform;

function Bootstrap() {
  useEffect(() => startAppSession(window.api), []);

  return <Shell />;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<Bootstrap />);
}
