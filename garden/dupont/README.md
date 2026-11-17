# Dupont Clip Frames

Browser replacement for `~/projects/library/electronics/dupont-clips/dupont-clip-gen.py`.
The script made one clip bar per header row from a `1`/`0` pattern; this page
makes both rows at once as a single "C" frame that only fits the board one way.

Served by Print Garden at `/dupont` (inside the app shell) and
`/garden/dupont/` (standalone). No build step: it reuses three.js, OrbitControls,
the STL writer, and the stylesheet from `../labels/`.

## Using it

1. Pick a board (the ESP32 DevKit 30 pin board is built in) or open/import one.
2. Click the pins you are wiring on the top-view diagram (or their names).
3. Check the 3D view: **On the board** shows the frame against the board,
   **As printed** shows the STL as it goes on the bed.
4. **Download STL** (print as it comes: wire side down, posts up) or
   **Slice & queue** to send it through the Labels slicing worker.

## The frame

- **Rails:** one per header row. A wired pin gets a Dupont housing slot
  (`pinSize + busClearance` = 3.04 mm); an unused pin gets a 1.2 mm square
  hole for the header pin. Those sizes leave a 0.42 mm fin between a slot and
  an unused neighbour (one nozzle line); the page warns if you go thinner.
  Adjacent wired pins merge into one slot. Rails run the full board length.
- **Pin spacing:** pin 1 is placed from the measured far-edge distance
  (`farEdgeToPin1`, 6 mm on the built-in board) and pin k at exactly
  `pin1 - k * pitch`, so there is no running error down the row.
- **Crossbar:** joins the rails at the far end (away from USB). The USB end
  stays open, so the open side of the C always faces the USB connector.
- **Posts:** one per corner mounting hole, on a standoff as tall as the header
  plastic, with a lead-in chamfer. The standoff collar shrinks where pin 1's
  header plastic comes close to the far corner holes, so it never touches it. Posts only fit one face of the board, so the
  frame can not go on flipped or turned round.
- **Headers up/down:** with pins pointing down the frame sits under the board
  and prints in board orientation. With pins pointing up it sits on top; the
  STL is the same part turned over about the board's long axis (a rotation,
  never a mirror), so the slots can not come out transposed.

Geometry is in `lib/clipgen.js` (pure functions). The frame is built from
axis-aligned boxes on one shared grid, so it is a single closed shell; each
post is its own closed shell sunk 0.2 mm into the frame, which slicers union.

## Board files

A board definition holds the measurements, pin labels, which pins are
selected, and the clip settings (see `DEFAULT_BOARD` in `lib/clipgen.js`).
Pin labels run top to bottom as drawn: index 0 is the far end, the last index
is next to USB. Hole position is measured the way calipers see it: board edge
to hole edge (`holes.edgeGap`), not to the hole center. Pin 1 is measured from
the far (non-USB) edge to its center. Version 1 files measured from the USB
edge; they are converted on load.

- **Save** stores it in Print Garden (`/garden/api/dupont/boards`, one JSON file
  per board under `server/data/garden/dupont/`, never `farm.db`). The id is the
  name as a slug; saving under a new name makes a copy.
- **Export / Open .json** move a board between instances or keep it in git.
- The page also keeps the current unsaved board in `localStorage`.

## Tests

```bash
node --test garden/dupont/tests/clipgen.test.mjs   # geometry (no deps)
node --test garden/dupont/tests/server.test.mjs    # board API, needs express (deps image)
```
