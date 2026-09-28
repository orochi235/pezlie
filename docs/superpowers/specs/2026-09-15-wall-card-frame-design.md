# The item card as a frame around its cell

**Status: built.** `ItemCard`'s anchored mode and `Wall`'s `onPick` position
landed in `7bdd28e`, and the `WallView` wiring in `ecd9133`.

This is the design for turning `WallView`'s item card from a panel beside the click into an opaque frame around the clicked cell itself. It is for whoever works on it, and assumes the `wall/` package.

## What a click does

1. **Glide in when the cell is small.** If the clicked cell is shorter on screen than the ladder's loose rung (`ladder.loose`, 128px by default: the rung with a sharp per-item thumbnail), the camera animates to `centerReveal(rect, cam, size, ladder.loose / size.height)`: centered, one loose tile tall. A cell already that tall does not move the camera.
2. **Frame the real cell.** The card is an opaque frame whose opening lines up with the cell's on-screen rect, with a fixed pad around it; the canvas cell shows through the opening. The host's details sit in a column to the right of the opening, or to the left when the right has no room inside the viewport.
3. **Follow the cell.** The frame is placed from the cell's rect under the current camera on every render, not from the click point, so it stays around the cell through the glide. Dragging the wall or wheel-zooming closes it unless the pointer is over the frame.
4. **Opaque.** The frame's background resolves to a surface with no alpha. If the theme's surface tokens are translucent, it composites them over an opaque base in CSS rather than hard-coding a color.

## Layout

- Opening: the cell rect, with `CARD_PAD` around it on all sides.
- Details column: a fixed width (the current card's text area, about 200px), at most the opening's height plus pads, scrolling if the facts are longer.
- Frame height: opening plus pads. Frame width: opening plus pads plus the details column.
- The opening has no background and `pointer-events: none`, so a click or double-click on the cell reaches the wall as it does today (a double-click still opens the detail view). `ItemCard`'s outside-press rule counts a press inside the opening as inside the card, so it does not close.

## In `wall`

- `ItemCard` gains an anchored mode: given the cell's screen rect (`{ x, y, w, h }`) instead of a point, it renders the frame and opening and positions the details column. The point mode stays for any host that wants it.
- `WallView` keeps the clicked position alongside the row in its `carded` state, computes the rect with `rectAt(laid, position)` under the current `cam` each render, and passes it to `ItemCard`.
- The click path (`onPick`) runs the glide from step 1 before opening the card. `reveal(id)` uses the same frame.
- `renderCard` keeps its signature. Hosts no longer need their own thumbnail inside it.

## Tests

- The anchored placement as a pure function (details right when it fits, left when it doesn't; opening aligned to the rect) beside `placeCard`'s tests; a `WallView` test that a card opened from `reveal` renders the frame and an opening sized to the cell.
- In the browser: at 1280×720, click a small cell and a large one; the glide happens only for the small one, the frame surrounds the cell before and after the glide, the wall does not show through, and a drag closes it. A labeled before/after goes on the slopboard wall.
