# Facing milling

In Manufacturing, add Facing milling, assign a tool position with inherited
`TYPE=FLAT` and `CUTTER_DIAMETER`, and choose one planar face, closed sketch,
or set of closed coplanar model edges. Select the machining orientation under
Machining orientation. The setup Z axis is the default. For side or tilted work,
pick a parallel face, datum plane, or coordinate system, and flip the tool
direction if needed. Passes run along operation X.

Top and final heights are signed distances in millimetres along the tool axis
from the selected boundary plane. For example, a top height of 1 and a final
height of 0 remove 1 mm above the selected finished face. Clearance and retract
use the same plane above the higher of the boundary and top heights. An optional
maximum stepdown splits the height difference and the final pass lands at the
requested height.

The raster uses the operation-local bounding rectangle of the loop, including
the extrema inside circular arcs. It places rows on both Y extremes and divides
the interval into equal spacings no greater than the requested fraction of
cutter diameter. Every point of the rectangle is within half that spacing of a
row, so every point of the selected surface is within the cutter radius.
Row endpoints extend more than a cutter radius past both X extremes. Zigzag
alternates row directions and feeds between rows outside that envelope. One-way
retracts to clearance between rows and returns in the same cutting direction.
Each depth starts and ends at clearance. The shared neutral preview and
TIP-anchored tool assembly use the resolved indexed orientation.

One simple closed loop is supported, up to 500 straight or circular edges.
Open, intersecting, nested and disconnected loops, nonplanar geometry, and
unsupported curves are rejected. The current limits are 500 raster rows,
500 depth passes and 20,000 total rows. Concave and circular boundaries use the
entire bounding rectangle, so the swept tool can extend outside the selected
surface. The operation assumes room for this sweep and for overtravel and
clearance. It does not analyze surrounding stock, raised features, fixtures
or holder collisions. Facing stores its geometry and settings in the CAM
document and generates neutral preview motions.

## FreeCAD 1.1.0 source comparison

The [1.1.0 release](https://github.com/FreeCAD/FreeCAD/releases/tag/1.1.0)
points to revision `34a9716668b1ddeb55b914f1c5be644826bdbbbf`.

- [MillFace.py](https://raw.githubusercontent.com/FreeCAD/FreeCAD/1.1.0/src/Mod/CAM/Path/Op/MillFace.py)
  derives start and finish heights from stock and target geometry. Its boundary
  modes include bounding box, stock, perimeter and face region. Edge clearing
  enlarges the selected envelope by a tool-size-dependent margin. The operation
  can subtract raised regions and feeds the removal shape into the pocket/area
  machinery.
- [PocketBase.py](https://github.com/FreeCAD/FreeCAD/blob/1.1.0/src/Mod/CAM/Path/Op/PocketBase.py)
  and [Area.py](https://github.com/FreeCAD/FreeCAD/blob/1.1.0/src/Mod/CAM/Path/Op/Area.py)
  supply the shared pocket pattern setup, depth sections, and safe/resume and
  retract heights. [Area.cpp](https://github.com/FreeCAD/FreeCAD/blob/1.1.0/src/Mod/CAM/App/Area.cpp)
  selects the raster or offset generator and turns section geometry into tool
  motions. Its line mode uses parallel stripes, while libarea's zigzag mode
  clips passes to its machining region and can join neighboring segments.
- The FreeCAD operation uses FreeCAD Path, Part/Open CASCADE, PySide, NumPy and
  lazy-loader. The inspected FreeCAD CAM Python and C++ files are
  LGPL-2.1-or-later. The inspected libarea area and Clipper adapter files are
  BSD-3-Clause, and the bundled original Clipper header is Boost Software License
  1.0. The corresponding third-party libraries retain their own licenses.
  Whittle's implementation is original TypeScript and adds no dependency or
  upstream source.
- Whittle implements the bounding-box variant with explicit heights and fixed
  operation-X raster direction. Its radius-plus-tolerance overrun and equal
  cross-row spacing provide a direct coverage guarantee for the supported
  geometry. Its one-way return always uses clearance, and zigzag stays down
  only for the turn outside the X envelope.
