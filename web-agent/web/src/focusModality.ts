// Native dialog autofocus can match :focus-visible even after a mouse click.
// Keep focus and its keyboard behavior; only the painted outline follows input.
export function initializeFocusModality(target: Document = document): () => void {
  const root = target.documentElement;
  root.dataset.inputModality = "pointer";
  const pointer = () => { root.dataset.inputModality = "pointer"; };
  const keyboard = (event: KeyboardEvent) => {
    if (["Tab", "Enter", " ", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
      root.dataset.inputModality = "keyboard";
    }
  };
  target.addEventListener("pointerdown", pointer, true);
  target.addEventListener("keydown", keyboard, true);
  return () => {
    target.removeEventListener("pointerdown", pointer, true);
    target.removeEventListener("keydown", keyboard, true);
    delete root.dataset.inputModality;
  };
}
