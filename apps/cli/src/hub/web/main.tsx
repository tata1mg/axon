// Axon Hub browser entry. Bundled by scripts/build-hub.ts into ../assets/hub.{js,css} and served
// under a strict CSP: no inline scripts or <style> elements, so nothing here may inject them.
import "./base.css";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { connect, takeLaunchToken } from "./api.ts";

const token = takeLaunchToken();
const launch = connect(token);
// The App reports failures; this only keeps an early rejection from being reported as unhandled.
launch.catch(() => {});

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<App launch={launch} hadToken={token !== undefined} />);
