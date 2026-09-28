# Host controls in WallView's header

**Status: built 2026-09-15.** The header row also needed pezlie's own controls made non-shrinking (`.wall-panels`, `.wall-cachefail`), which the design below did not foresee.

This is the design for letting a host put its own slot picker and item search
in `WallView`'s header. It is for whoever implements it, and assumes the
`wall/` package and `wall/README.md`'s host contract.

Before this, `WallView` drew its own single `<select>` of slots, and `header`
only appended controls after it. Nothing let a host change the slot or move the
camera.

## Decisions

**A richer slot picker stays in the host.** A host that needs more than the
built-in `<select>` draws its own through `header`; a multi-axis picker in the
library would be shaped by one host.

**`WallView` keeps its state.** A host reads and drives the slot and camera
through a function passed to `header`, not through controlled props or a ref.
That matches the existing rule: a host starts `WallView` with `initial` and
follows it with `onChange`.

## In `wall`

Two props on `WallViewProps`. `WallHeader` is exported from `index.ts`.

```ts
header?: ReactNode | ((wall: WallHeader) => ReactNode);
/** Default true. False drops the built-in slot <select>. */
slotPicker?: boolean;

export interface WallHeader {
  slots: { slot: string; n: number }[];
  slot: string;
  setSlot: (slot: string) => void;
  reveal: (id: string) => 'shown' | 'filtered' | 'absent';
}
```

A plain node renders as today. A function renders in the same place: after the
slot picker when there is one, before Legend and Cache failure.

`reveal(id)` acts on the slot being drawn:

- **`absent`:** `rowOfId` finds no row, or the items have not loaded yet.
- **`filtered`:** the row exists but is not in the current layout's order.
- **`shown`:** the camera animates to `centerReveal(rect, cam, size, 0.5)`,
  zooming until the cell fills at least half the viewport's height. The
  position becomes the explicit caret, and the item's card opens at the
  viewport's center. The move counts as the reader touching the camera, so a
  later regroup does not refit the wall.

Tests, in `wall/test/WallView.test.tsx`:

- a `header` function receives the slots and the current slot, and its `setSlot` changes the slot
- `slotPicker={false}` renders no `<select>`
- `reveal` answers `absent`, `filtered` and `shown`, and `shown` opens the card

`wall/README.md` gets a sentence on both props in its `WallView` paragraph.
