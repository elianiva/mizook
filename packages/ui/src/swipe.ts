import { Option, Stream } from "effect";

export type Swipe = "Left" | "Right";

const MIN_DISTANCE = 64;
const HORIZONTALITY = 1.5;
const OPENING_ZONE = 0.35;
// Content that scrolls sideways or takes a text cursor keeps its own horizontal drags.
const KEEPS_ITS_DRAGS = "pre, table, input, textarea, [data-no-swipe]";

interface Start {
  readonly x: number;
  readonly y: number;
}

const touchPoint = (event: TouchEvent): Option.Option<Start> =>
  Option.fromNullishOr(event.changedTouches[0]).pipe(
    Option.map((touch) => ({ x: touch.clientX, y: touch.clientY })),
  );

/**
 * One value per horizontal swipe, on screens at most `maxWidth` wide. A swipe
 * right counts only from the left part of the screen, so it reads as pulling a
 * side menu out; a swipe left counts anywhere.
 */
export const swipes = (options: { readonly maxWidth: number }): Stream.Stream<Swipe> =>
  Stream.suspend(() => {
    let start: Option.Option<Start> = Option.none();
    const classify = (begin: Start, end: Start): Option.Option<Swipe> => {
      const dx = end.x - begin.x;
      const dy = end.y - begin.y;
      const isSwipe =
        window.innerWidth <= options.maxWidth &&
        Math.abs(dx) >= MIN_DISTANCE &&
        Math.abs(dx) > HORIZONTALITY * Math.abs(dy);
      if (!isSwipe) return Option.none();
      if (dx < 0) return Option.some("Left");
      return begin.x <= window.innerWidth * OPENING_ZONE ? Option.some("Right") : Option.none();
    };
    const began = Stream.fromEventListener<TouchEvent>(document, "touchstart", {
      passive: true,
    }).pipe(
      Stream.map((event): Option.Option<Swipe> => {
        const inKeeper = event.target instanceof Element && event.target.closest(KEEPS_ITS_DRAGS);
        start = inKeeper ? Option.none() : touchPoint(event);
        return Option.none();
      }),
    );
    const ended = Stream.fromEventListener<TouchEvent>(document, "touchend", {
      passive: true,
    }).pipe(
      Stream.map((event): Option.Option<Swipe> => {
        const from = start;
        start = Option.none();
        return Option.flatMap(from, (begin) =>
          Option.flatMap(touchPoint(event), (end) => classify(begin, end)),
        );
      }),
    );
    return Stream.merge(began, ended).pipe(
      Stream.filter(Option.isSome),
      Stream.map((swipe) => swipe.value),
    );
  });
