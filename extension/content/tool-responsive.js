/*
 * Tool: Responsive viewer.
 *
 * The viewer is a real tab (iframes at real CSS widths), so this tool only hands
 * the current URL over and gets out of the way.
 */
(() => {
  const F = globalThis.Fathom;
  if (!F || !F.workspace) return;

  F.workspace.register("responsive", async (api) => {
    const panel = api.panel({
      title: "Responsive viewer",
      subtitle: "Opening the viewer tab…",
      size: "compact",
      tool: "responsive",
    });

    panel.body.replaceChildren(
      F.util.h(
        "p",
        { class: "empty" },
        "Fathom opens this page in a dedicated tab at several device widths. The dock closes here so the page can take the full window.",
      ),
    );

    try {
      await F.call({ operation: "responsive-open", url: location.href });
      api.close();
    } catch (err) {
      panel.body.replaceChildren(
        F.util.h("p", { class: "empty", text: err.message || "The viewer could not be opened." }),
      );
    }
  });
})();
