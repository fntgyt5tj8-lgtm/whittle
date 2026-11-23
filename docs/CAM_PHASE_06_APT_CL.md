# Phase 06 APT-CL export

Enter a positive cut feed and plunge feed in millimetres per minute. Use **Export APT-CL** on a contour, pocket, adaptive clearing, or facing operation. Select a setup and use **Export setup APT-CL** to export its milling and circular-profile operations in part-history order. A setup export stops at the first unresolved operation and identifies it. Transfer and ejection stages have no neutral milling motions.

Setup and general milling exports use CAD world coordinates in millimetres. The generator places the neutral motions in the workpiece-context frame. The serializer maps those positions and circle centers from that frame into CAD world coordinates once. It maps tool axes and circle normals as directions, without translation. IJK points from the cutter tip toward the spindle and has unit length. The TIP playback already displays the same points and orientation in CAD world coordinates. The circular-profile operation's original individual export keeps its workpiece-context coordinates. Its default tool axis is the sketch normal, even when the context is rotated. Explicit setup, planar-face, datum-plane, and CSYS orientations still require a perpendicular profile sketch and support flipping the tool axis.

## Provisional dialect

The available NC-Post.io checkout had no APT input parser to test against. The existing Whittle subset supplies the base format. Program metadata and operation boundaries use the following assumptions:

- `PARTNO` names the program. `$$` lines carry the frame, operation name, and optional RPM metadata.
- `UNITS/MM` and `MULTAX/ON` introduce metric XYZ-IJK records. Each operation begins with a six-field `FROM`, followed by six-field `GOTO` records. An operation's axis is fixed.
- `LOADTL/n` marks a change of numbered tool. `CUTTER/d` defines the flat cutter diameter in millimetres. A standalone legacy circular profile can have an unnumbered cutter.
- `RAPID` applies to the following move. After a rapid the next cutting move reasserts `FEDRAT/value,MMPM`. Axial plunge moves use plunge feed. Default cutting and helical feed moves use cut feed.
- `CIRCLE/cx,cy,cz,nx,ny,nz,r` followed by `GOTO` defines the directed minor arc from the current point. A clockwise arc reverses the circle normal, while the tool axis stays fixed. Longer sweeps use multiple analytic minor arcs.
- Setup and general milling exports approximate helical entry using feed chords with at most 0.01 mm radial sagitta. Planar arcs stay analytic. `FINI` terminates the file once.

The downstream post must interpret each `FROM` as a new operation start. The export does not supply inter-operation moves, reindexing sequences, tool-change clearances, machine kinematics, or collision checks. RPM is informational. Validate the parser and linking behavior before using this format in a machine workflow.

The golden [indexed profile program](../packages/cam/test/fixtures/indexed-profiles.apt) shows +Z, a vertical side, arbitrary tilt, and flipped tilt with analytic arcs. It includes a rotated, translated workpiece context in the test that generates it.
