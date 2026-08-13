import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const { registerDiffTools } = await import("@pi-archimedes/diff");
    registerDiffTools(
      pi,
      () => ctx.ui.theme,
      () => ({
        diffTheme: "github-dark",
        diffSplitMinWidth: 150,
        diffSplitMinCodeWidth: 60,
      }),
    );
  });
}
