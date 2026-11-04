// What sends the page to another origin through a form, for the off-site rule (logic.ts offSite). It runs in the page
// (BOX_FN in cdp.ts embeds its source), so it uses nothing from outside itself.
/** Where a form control sends the page, as an origin, when that is another origin than the page's: a submit button's
 * formaction or its form's action, and the same for a field (Enter submits through the form's first submit button).
 * null for any other control. It starts from the control and its form owner, so a form in a closed shadow root counts
 * as well. Runs in the page (its source is sent), so it uses nothing from outside itself; only public DOM is read. A
 * page can plant a "verify your email" form that posts to its own server, and Drex filled one in (eval h-signup). */
export function offOriginTarget(e: Element): string | null {
  const here = location.origin;
  // read through the prototypes: a form's own field named "elements" or "getAttribute", or a form named "forms", would
  // otherwise shadow them (DOM clobbering) and hide the planted form
  const get = (proto: object, name: string, on: object): unknown =>
    Object.getOwnPropertyDescriptor(proto, name)?.get?.call(on);
  const attr = (el: Element, name: string): string | null => Element.prototype.getAttribute.call(el, name);
  const protos: Record<string, object> = {
    INPUT: HTMLInputElement.prototype,
    BUTTON: HTMLButtonElement.prototype,
    SELECT: HTMLSelectElement.prototype,
    TEXTAREA: HTMLTextAreaElement.prototype,
  };
  const proto = protos[e.tagName];
  const form = proto ? (get(proto, "form", e) as HTMLFormElement | null) : null;
  if (!form) return null;
  const base = get(Node.prototype, "baseURI", document) as string;
  const originOf = (button: Element | null): string => {
    try {
      const to = (button && attr(button, "formaction")) || attr(form, "action") || location.href;
      return new URL(to, base).origin;
    } catch {
      return here;
    }
  };
  const isSubmit = (el: Element): boolean =>
    (el.tagName === "BUTTON" && (el as HTMLButtonElement).type === "submit") ||
    (el.tagName === "INPUT" && ["submit", "image"].includes((el as HTMLInputElement).type));
  // an image button is no member of form.elements, and the default button is the first submit button in document order
  // among all the controls the form owns, also through a form attribute from outside it
  let button: Element | null;
  if (isSubmit(e)) button = e;
  else {
    button =
      Array.from(get(HTMLFormElement.prototype, "elements", form) as HTMLFormControlsCollection).find(isSubmit) ?? null;
    const root = Node.prototype.getRootNode.call(form) as Document | DocumentFragment;
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the typed overload is the one flagged
    const images = (root.nodeType === 9 ? Document.prototype : DocumentFragment.prototype).querySelectorAll.call(
      root,
      "input[type=image]",
    ) as NodeListOf<HTMLInputElement>;
    for (const i of Array.from(images)) {
      if (i.type !== "image" || get(HTMLInputElement.prototype, "form", i) !== form) continue;
      if (!button || button.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_PRECEDING) button = i;
    }
  }
  const to = originOf(button);
  return to !== here && /^https?:/.test(to) ? to : null;
}
