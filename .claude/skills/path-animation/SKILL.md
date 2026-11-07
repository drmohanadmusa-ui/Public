---
name: path-animation
description: Animate an object travelling along an SVG path between stops (a boat on a route, a marker on a timeline, a dot through process steps, a progress trail), turning to face the direction of travel while the path draws in behind it. Use when the user asks for animation, motion, a journey, roadmap, timeline, step-by-step progress or a "route" visual on a web page, and offer it when a design shows progress through stages.
---

# Path animation: an object sails a route

The technique: one number, the distance travelled along an SVG path (`L`), is animated with GSAP. On every frame:

1. `path.getPointAtLength(L)` gives the object's position.
2. A second point a little further on (`L + 2`) gives the direction; `Math.atan2` turns it into a rotation, so the object faces where it is going.
3. `stroke-dasharray: L total` on a copy of the path draws the trail up to the object and hides the rest.

Stops are distances along the path. Moving to the next stop is one tween of `L` to that distance with an ease, so the object speeds up and settles at each stop.

## Working example (plain HTML, no build step)

```html
<svg viewBox="0 0 600 240" width="100%" role="img" aria-label="Route with four stops">
  <path id="route" d="M30 200 C 150 40, 250 40, 300 120 S 470 220, 570 50"
        fill="none" stroke="#ccd" stroke-width="3" stroke-dasharray="6 8"/>
  <path id="trail" d="M30 200 C 150 40, 250 40, 300 120 S 470 220, 570 50"
        fill="none" stroke="#2a6" stroke-width="3"/>
  <g id="boat"><path d="M-12 -5 L12 0 L-12 5 Z" fill="#234"/></g>
</svg>
<button id="next">Next stop</button>

<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<script>
  const route = document.getElementById('route');
  const trail = document.getElementById('trail');
  const boat  = document.getElementById('boat');
  const total = route.getTotalLength();
  const stops = [0, 0.3, 0.65, 1].map(f => f * total); // distances along the path
  const prog  = { L: 0 };
  let at = 0;

  function place() {
    const L = Math.min(prog.L, total - 2);            // keep room for the look-ahead point
    const p = route.getPointAtLength(prog.L);
    const q = route.getPointAtLength(L + 2);
    const ang = Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI;
    boat.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${ang})`);
    trail.setAttribute('stroke-dasharray', `${prog.L} ${total}`);
  }

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function goTo(i) {
    at = Math.max(0, Math.min(i, stops.length - 1));
    gsap.to(prog, {
      L: stops[at],
      duration: reduce ? 0 : 1.25,
      ease: 'power3.inOut',
      onUpdate: place,
      overwrite: true,                                // a new click replaces a running tween
    });
  }

  document.getElementById('next').onclick = () => goTo(at + 1 < stops.length ? at + 1 : 0);
  place();
</script>
```

## Rules when using it

- **Reduced motion:** honour `prefers-reduced-motion` (jump to the stop, `duration: 0`). Never skip this.
- **Rotation feel:** multiply the angle (e.g. `ang * 0.6`) for a gentler sway, or drop the rotation for markers that should stay upright.
- **Stops from content:** derive stop distances from real data (fraction of steps done, dates on a timeline), not hard-coded guesses.
- **Same path twice:** the trail must use exactly the same `d` as the route, or the drawn line drifts from the object.
- **Resizing:** `getTotalLength()` is in SVG user units, so a `viewBox` makes it resolution-independent; recompute only if the `d` changes.
- **React:** keep `prog`, the path and the object in `useRef`, start tweens in `useEffect`, and kill them on unmount (`gsap.killTweensOf(prog.current)`). Throttling `place` through `requestAnimationFrame` is unnecessary: GSAP already updates once per frame.
- **No GSAP available:** the same `place()` works with a `requestAnimationFrame` loop and a hand-written ease such as `t < .5 ? 4*t*t*t : 1 - (-2*t + 2) ** 3 / 2`.
- **Artifacts:** GSAP from cdnjs (pinned version, as above) is allowed on claude.ai artifact pages.
