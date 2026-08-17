import { createRoot } from "react-dom/client";

import {
  DesktopCoreGallery,
  installGalleryApiMock,
} from "./components/design-system/DesktopCoreGallery";
import "./styles.css";
import "./styles/design-system-gallery.css";

installGalleryApiMock();

const root = document.getElementById("root");

if (root) {
  createRoot(root).render(<DesktopCoreGallery />);
}
