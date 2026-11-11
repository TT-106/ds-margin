export function viewportBounds() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  return {
    left,
    top,
    right: left + (viewport?.width ?? innerWidth),
    bottom: top + (viewport?.height ?? innerHeight),
  };
}

export function watchAnchor(anchor: HTMLElement, measure: () => void) {
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; measure(); });
  };
  const observer = new ResizeObserver(schedule);
  const viewport = window.visualViewport;
  const root = anchor.getRootNode();
  observer.observe(anchor);
  window.addEventListener('resize', schedule);
  document.addEventListener('scroll', schedule, true);
  if (root instanceof ShadowRoot) root.addEventListener('scroll', schedule, true);
  root.addEventListener('animationend', schedule, true);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  measure();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener('resize', schedule);
    document.removeEventListener('scroll', schedule, true);
    if (root instanceof ShadowRoot) root.removeEventListener('scroll', schedule, true);
    root.removeEventListener('animationend', schedule, true);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
  };
}

export function watchOutsideInteraction(layer: HTMLElement, keepOpen: (event: Event, path: EventTarget[]) => boolean, dismiss: () => void) {
  const root = layer.getRootNode();
  const outside = (event: Event) => {
    const path = event.composedPath();
    if (!path.includes(layer) && !keepOpen(event, path)) dismiss();
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('focusin', outside, true);
  if (root instanceof ShadowRoot) root.addEventListener('focusin', outside, true);
  return () => {
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('focusin', outside, true);
    if (root instanceof ShadowRoot) root.removeEventListener('focusin', outside, true);
  };
}
