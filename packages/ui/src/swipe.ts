import type { Stream } from "effect";

import { fromListener } from "./internal/stream.ts";

// A side menu that follows the finger, like Twitter's: a horizontal drag is
// recognised after a slope threshold, the panel tracks the drag, and letting go
// settles it open or closed by distance and flick speed. The panel is marked
// with `data-swipe-panel` and its backdrop with `data-swipe-backdrop`; the
// shared preset styles both through the attributes this module sets on `<html>`.
const PANEL = "[data-swipe-panel]";
const KEEPS_ITS_DRAGS = "pre, table, input, textarea, select, [data-no-swipe]";
// A drag must pass this many pixels sideways, and be this many times longer
// than it is tall, before it counts as horizontal; until then the page scrolls.
const DECIDE_AT = 10;
const SLOPE = 1.2;
// Pixels per millisecond: a short flick this fast settles the way it went.
const FLICK = 0.3;
const SETTLE_MS = 240;

interface Start {
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

export interface SwipeDrawerOptions<Message> {
  /** The widest viewport that has a side menu. */
  readonly maxWidth: number;
  /** How wide the panel is when it is not mounted to measure. */
  readonly width: (viewport: number) => number;
  /** Opens the menu in the Model, so the panel mounts under the finger. */
  readonly open: () => Message;
  /** Closes it after a drag that settles back, or one that closes an open menu. */
  readonly close: () => Message;
}

/**
 * One stream of drawer messages. The panel tracks the finger between the first
 * horizontal move and release; the stream only speaks when the menu must open
 * or close in the Model, so a drag that starts from closed mounts the panel on
 * its first horizontal move and a cancelled one closes it again.
 */
export const swipeDrawer = <Message>(
  options: SwipeDrawerOptions<Message>,
): Stream.Stream<Message> =>
  fromListener<Message>((emit) => {
    const root = document.documentElement;
    let start: Start | undefined;
    let openAtStart = false;
    let dragging = false;
    let width = 0;
    let offset = 0;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const panelOf = (): HTMLElement | null => document.querySelector<HTMLElement>(PANEL);
    const backdropOf = (): HTMLElement | null =>
      document.querySelector<HTMLElement>("[data-swipe-backdrop]");

    // ui-sdk opens the drawer with a Web Animation; an inline CSS transform
    // cannot beat it, so a drag takes the panel off its hands.
    const stopAnimations = () => {
      for (const element of [panelOf(), backdropOf()]) {
        if (element === null) continue;
        for (const animation of element.getAnimations()) animation.cancel();
      }
    };

    const clear = () => {
      root.removeAttribute("data-swiping");
      root.removeAttribute("data-settling");
      root.removeAttribute("data-swiped");
      root.style.removeProperty("--swipe-offset");
      root.style.removeProperty("--swipe-progress");
    };

    const paint = () => {
      root.style.setProperty("--swipe-offset", `${offset}px`);
      root.style.setProperty(
        "--swipe-progress",
        String(width === 0 ? 0 : Math.max(0, Math.min(1, offset / width))),
      );
    };

    const settle = (toOpen: boolean) => {
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      stopAnimations();
      root.removeAttribute("data-swiping");
      root.setAttribute("data-settling", "");
      offset = toOpen ? width : 0;
      paint();
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        root.removeAttribute("data-settling");
        if (toOpen) {
          // Keep the panel where the drag left it: the entrance animation is done.
          root.setAttribute("data-swiped", "");
        } else {
          // Stay off-screen until the Model unmounts the drawer, so it never
          // flashes back open before its exit animation starts.
          if (panelOf() === null) clear();
          else root.setAttribute("data-swiped", "");
          emit(options.close());
        }
      }, SETTLE_MS);
    };

    const reset = () => {
      start = undefined;
      dragging = false;
    };

    const onStart = (event: TouchEvent) => {
      if (window.innerWidth > options.maxWidth || event.touches.length !== 1) return;
      if (root.hasAttribute("data-settling")) return;
      const touch = event.touches[0];
      if (touch === undefined) return;
      if (event.target instanceof Element && event.target.closest(KEEPS_ITS_DRAGS)) return;
      const panel = panelOf();
      // A menu closed by its button or backdrop leaves the settled attributes
      // behind; the next touch clears them before measuring a closed menu.
      if (panel === null) clear();
      openAtStart = panel !== null && panel.hasAttribute("data-open");
      width =
        (openAtStart ? panel?.getBoundingClientRect().width : undefined) ??
        options.width(window.innerWidth);
      start = { x: touch.clientX, y: touch.clientY, at: performance.now() };
      dragging = false;
    };

    const onMove = (event: TouchEvent) => {
      if (start === undefined) return;
      if (event.touches.length !== 1) {
        // A second finger turns this into a pinch; keep the page, not the menu.
        if (dragging) settle(openAtStart);
        reset();
        return;
      }
      const touch = event.touches[0];
      if (touch === undefined) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!dragging) {
        if (Math.abs(dx) < DECIDE_AT && Math.abs(dy) < DECIDE_AT) return;
        if (Math.abs(dx) <= SLOPE * Math.abs(dy)) {
          reset();
          return;
        }
        if (openAtStart ? dx >= 0 : dx <= 0) {
          reset();
          return;
        }
        const panel = panelOf();
        width = panel?.getBoundingClientRect().width ?? options.width(window.innerWidth);
        dragging = true;
        root.removeAttribute("data-swiped");
        root.setAttribute("data-swiping", "");
        if (!openAtStart) emit(options.open());
        // The drawer mounts after the Model hears `open`; catch its animation
        // as soon as it appears, not only on the next move.
        requestAnimationFrame(() => {
          if (dragging) stopAnimations();
        });
      }
      if (event.cancelable) event.preventDefault();
      stopAnimations();
      offset = openAtStart ? width + dx : dx;
      paint();
    };

    const finish = (event: TouchEvent) => {
      if (start === undefined) return;
      if (!dragging) {
        reset();
        return;
      }
      if (event.cancelable) event.preventDefault();
      const touch = event.changedTouches[0];
      const endX = touch?.clientX ?? start.x;
      const dx = endX - start.x;
      const elapsed = Math.max(1, performance.now() - start.at);
      const velocity = dx / elapsed;
      const progress =
        width === 0 ? 0 : Math.min(1, Math.max(0, (openAtStart ? width + dx : dx) / width));
      const toOpen = openAtStart
        ? progress >= 0.5 && velocity > -FLICK
        : progress >= 0.5 || velocity > FLICK;
      reset();
      settle(toOpen);
    };

    const cancel = () => {
      if (start === undefined) return;
      if (dragging) settle(openAtStart);
      reset();
    };

    const observer = new MutationObserver(() => {
      if (
        (root.hasAttribute("data-swiped") || root.hasAttribute("data-settling")) &&
        panelOf() === null
      )
        clear();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", finish, { passive: false });
    document.addEventListener("touchcancel", cancel, { passive: true });

    return () => {
      observer.disconnect();
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", finish);
      document.removeEventListener("touchcancel", cancel);
      clear();
    };
  });
