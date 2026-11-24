import type { Stream } from "effect";

import { fromListener } from "./internal/stream.ts";

// A side menu that follows the finger, like Twitter's: a horizontal drag is
// recognised after a slope threshold, the panel tracks the drag with resistance
// past either end, and letting go settles it open or closed by distance or by
// the speed of the last flick. A touch during a settle catches the panel where
// it is. The panel is marked with `data-swipe-panel` and its backdrop with
// `data-swipe-backdrop`; the shared preset styles both through the attributes
// this module sets on `<html>`.
const PANEL = "[data-swipe-panel]";
const BACKDROP = "[data-swipe-backdrop]";
const KEEPS_ITS_DRAGS = "pre, table, input, textarea, select, [contenteditable], [data-no-swipe]";
// A drag must pass this many pixels sideways, and be this many times longer
// than it is tall, before it counts as horizontal; until then the page scrolls.
const DECIDE_AT = 10;
const SLOPE = 1.2;
// Pixels per millisecond: a release faster than this settles the way it went,
// however far the panel travelled. Each move is smoothed over the ones before
// it, so a slow drag that ends in a flick still reads as a flick.
const FLICK = 0.4;
const SMOOTH = 0.6;
// A finger that rests this long before lifting has no speed left.
const PAUSE_MS = 100;
// Past either end the panel gives way by this fraction of its width at most.
const RUBBER = 0.18;
// A release keeps its speed: the settle covers the remaining distance at
// roughly the speed the finger left, held between these bounds. The preset
// reads the duration from `--swipe-settle`.
const SETTLE_MIN_MS = 140;
const SETTLE_MAX_MS = 260;
const SETTLE_SLOWEST = 0.5;

interface Start {
  readonly x: number;
  readonly y: number;
}

type Axis = "undecided" | "horizontal" | "vertical";

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
 * its first horizontal move and a cancelled one closes it again. The panel is
 * expected to sit flush against the left edge: while catching one mid-flight,
 * its visual left plus its width is its current offset.
 */
export const swipeDrawer = <Message>(
  options: SwipeDrawerOptions<Message>,
): Stream.Stream<Message> =>
  fromListener<Message>((emit) => {
    const root = document.documentElement;
    let start: Start | undefined;
    let axis: Axis = "undecided";
    let openAtStart = false;
    let freeDirection = false;
    let dragging = false;
    let width = 0;
    let offset = 0;
    let anchorX = 0;
    let anchorOffset = 0;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let lastX = 0;
    let lastAt = 0;
    let velocity = 0;

    const panelOf = (): HTMLElement | null => document.querySelector<HTMLElement>(PANEL);
    const backdropOf = (): HTMLElement | null => document.querySelector<HTMLElement>(BACKDROP);
    const clamp = (value: number, min: number, max: number): number =>
      Math.min(max, Math.max(min, value));

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
      root.style.removeProperty("--swipe-settle");
    };

    const paint = () => {
      root.style.setProperty("--swipe-offset", `${offset}px`);
      root.style.setProperty(
        "--swipe-progress",
        String(width === 0 ? 0 : clamp(offset / width, 0, 1)),
      );
    };

    // iOS's rubber band: each extra pixel pulls less than the one before it,
    // so the gap past either end never grows wider than RUBBER of the panel.
    const rubber = (value: number): number => {
      const limit = width * RUBBER;
      if (limit === 0) return value;
      if (value < 0) {
        const past = -value;
        return -(past * limit) / (limit + past);
      }
      if (value > width) {
        const past = value - width;
        return width + (past * limit) / (limit + past);
      }
      return value;
    };

    const sample = (x: number, at: number) => {
      const elapsed = at - lastAt;
      if (elapsed <= 0) return;
      // A rest resets the flick, so an old fast move cannot decide a release.
      if (elapsed > PAUSE_MS) velocity = 0;
      velocity = velocity * (1 - SMOOTH) + ((x - lastX) / elapsed) * SMOOTH;
      lastX = x;
      lastAt = at;
    };

    const settle = (toOpen: boolean, speed: number) => {
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      stopAnimations();
      root.removeAttribute("data-swiping");
      root.setAttribute("data-settling", "");
      const target = toOpen ? width : 0;
      const distance = Math.abs(target - offset);
      const duration =
        distance < 1
          ? 0
          : Math.round(
              Math.min(
                SETTLE_MAX_MS,
                Math.max(SETTLE_MIN_MS, distance / Math.max(Math.abs(speed), SETTLE_SLOWEST)),
              ),
            );
      root.style.setProperty("--swipe-settle", `${duration}ms`);
      offset = target;
      paint();
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        root.removeAttribute("data-settling");
        root.style.removeProperty("--swipe-settle");
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
      }, duration);
    };

    const reset = () => {
      start = undefined;
      axis = "undecided";
      dragging = false;
      freeDirection = false;
    };

    const beginDrag = (x: number) => {
      const panel = panelOf();
      const settling = settleTimer !== undefined;
      // Measure while the settled attributes still hold the panel in place;
      // removing `data-swiped` lets ui-sdk's entrance animation start again.
      const rect = panel?.getBoundingClientRect();
      if (settleTimer !== undefined) {
        // Catch the settle: cancel its pending close, so pulling the panel
        // back leaves the menu open.
        clearTimeout(settleTimer);
        settleTimer = undefined;
      }
      root.removeAttribute("data-settling");
      root.removeAttribute("data-swiped");
      root.style.removeProperty("--swipe-settle");
      if (rect !== undefined && rect.width > 0) width = rect.width;
      // A panel that is still entering, or settling, sits between the two ends.
      // Start the drag where it is rather than where the Model says it should be.
      const caught =
        rect === undefined || !openAtStart ? undefined : clamp(rect.left + rect.width, 0, width);
      const moving = settling || (caught !== undefined && caught > 0 && caught < width);
      freeDirection = moving;
      anchorX = start?.x ?? x;
      anchorOffset = caught ?? (openAtStart ? width : 0);
      dragging = true;
      axis = "horizontal";
      root.setAttribute("data-swiping", "");
      if (!openAtStart) emit(options.open());
      offset = anchorOffset;
      paint();
      // The drawer mounts after the Model hears `open`; catch its animation
      // as soon as it appears, not only on the next move.
      requestAnimationFrame(() => {
        if (dragging) stopAnimations();
      });
      stopAnimations();
    };

    const onStart = (event: TouchEvent) => {
      if (window.innerWidth > options.maxWidth || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (touch === undefined) return;
      if (event.target instanceof Element && event.target.closest(KEEPS_ITS_DRAGS)) return;
      const panel = panelOf();
      // A menu closed by its button or backdrop leaves the settled attributes
      // behind; the next touch clears them before measuring a closed menu.
      if (panel === null) clear();
      openAtStart = panel !== null && panel.hasAttribute("data-open");
      const rect = panel?.getBoundingClientRect();
      width = rect?.width || options.width(window.innerWidth);
      // A panel that is entering or settling has both directions: it can be
      // pulled back to rest or thrown past it. A panel at rest has only one.
      const visual = rect === undefined ? undefined : clamp(rect.left + rect.width, 0, width);
      freeDirection =
        settleTimer !== undefined ||
        (openAtStart && visual !== undefined && visual > 0 && visual < width);
      start = { x: touch.clientX, y: touch.clientY };
      axis = "undecided";
      dragging = false;
      lastX = touch.clientX;
      lastAt = performance.now();
      velocity = 0;
    };

    const onMove = (event: TouchEvent) => {
      if (start === undefined) return;
      if (event.touches.length !== 1) {
        // A second finger turns this into a pinch; keep the page, not the menu.
        if (dragging) settle(openAtStart, 0);
        reset();
        return;
      }
      const touch = event.touches[0];
      if (touch === undefined) return;
      const now = performance.now();
      sample(touch.clientX, now);
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (axis === "undecided") {
        if (Math.abs(dx) < DECIDE_AT && Math.abs(dy) < DECIDE_AT) return;
        if (Math.abs(dx) > SLOPE * Math.abs(dy)) axis = "horizontal";
        else if (Math.abs(dy) > SLOPE * Math.abs(dx)) axis = "vertical";
        else return; // neither yet: wait for the gesture to declare itself
      }
      if (axis !== "horizontal") return;
      if (!dragging) {
        // A menu moves one way from rest; the other way belongs to the page.
        if (!freeDirection && (openAtStart ? dx >= 0 : dx <= 0)) {
          axis = "vertical";
          return;
        }
        beginDrag(touch.clientX);
      }
      if (event.cancelable) event.preventDefault();
      stopAnimations();
      offset = rubber(anchorOffset + (touch.clientX - anchorX));
      paint();
    };

    const finish = (event: TouchEvent) => {
      if (start === undefined) return;
      if (!dragging) {
        reset();
        return;
      }
      if (event.cancelable) event.preventDefault();
      const now = performance.now();
      const touch = event.changedTouches[0];
      if (now - lastAt > PAUSE_MS) velocity = 0;
      const endX = touch?.clientX;
      if (endX !== undefined && endX !== lastX) sample(endX, now);
      const progress = width === 0 ? 0 : clamp(offset / width, 0, 1);
      // A flick settles the way it went, even against the distance; a slow
      // release settles by which half it is on.
      const toOpen = Math.abs(velocity) > FLICK ? velocity > 0 : progress >= 0.5;
      const speed = velocity;
      reset();
      settle(toOpen, speed);
    };

    const cancel = () => {
      if (start === undefined) return;
      if (dragging) settle(openAtStart, 0);
      reset();
    };

    const observer = new MutationObserver(() => {
      if (root.hasAttribute("data-swiping")) {
        // The panel mounts after `open`; take it off its entrance animation.
        stopAnimations();
        return;
      }
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
