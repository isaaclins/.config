import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInterruptSubmitHandler } from "../lib/interrupt-submit.ts";

export default function (pi: ExtensionAPI) {
  const handleInterruptSubmit = createInterruptSubmitHandler(pi);

  pi.registerShortcut("ctrl+enter", {
    description: "Stop the active agent and send the current prompt immediately",
    handler: handleInterruptSubmit,
  });
}
