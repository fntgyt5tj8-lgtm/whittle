# Manufacturing documents

Open the Manufacturing ribbon and choose **New CAM Document** or **Open CAM**. Use **Save CAM** to update the current file and **Save CAM As** to choose another destination. The main Save shortcut follows the active document. Whittle shows one active document per window. Ordinary New Design and Open still open CAD projects. Server-hosted Whittle uses local files for CAM. Browsers without a file picker download a new copy on save.

Use **Import** to insert a Whittle design, STEP, STL or OBJ. Whittle CAD bodies come in as individual CAM body instances. Use **Move / Copy** to translate or rotate an instance or create a new one. To align two frames, create two CAM coordinate systems before a Move step and turn on **Place between coordinate systems** in its editor. The rigid transform maps the source origin and axes to the target. It updates when those datums change. Use the existing Sketch, Construct and Parts Library tools to add CAM geometry. The existing Browser lists the bodies and datums.

## Version 1 file and reference contract

A `.cam` file is a ZIP with a `whittle-cam` format marker and schema version 1. Its `manufacturing.json` contains the CAM project, including setups, workpiece contexts, operations, the process plan and reserved tooling storage. Its `geometry.whittle` contains the CAM-owned timeline, IDs, body metadata, sketches, datums, imports and placement steps, using Whittle’s geometry codec. The project and geometry share a stable CAM document ID. Setups and operations reference CAM-local instance and sketch IDs. A native context datum is scoped to that CAM timeline.

A pinned CAD reference records its contract version, the source CAD document ID, source body ID and SHA-256 digest of the exact source file bytes. The field lives on the corresponding CAM import feature alongside its embedded snapshot. Move / Copy preserves its source through the timeline. Each placement copy has its own stable body ID. A CAD file without a document ID gets a revision-scoped fallback identity. Topology-level links and live updates are outside this contract.

CAM can reopen offline using the pinned snapshot. On the web, inserting and checking a pinned Whittle source requires HTTPS or localhost. Missing snapshot bytes, invalid revisions and missing or unbuildable source bodies surface as import failures. APT-CL export checks that the selected context’s references resolve and uses the existing deterministic exporter. **Verify CAD Source** compares a selected file with the pinned revision. A changed external file leaves the pinned geometry intact. Saving CAD again can change its byte revision even when its geometry is identical.

## Legacy migration

Open the legacy `.whittle` design, then select **Migrate Embedded Manufacturing** in Manufacturing. Use **Save CAM** to write the new document. Migration copies the geometry timeline and project, rebases local references to the new CAM document and preserves entity IDs and contextual settings. The original CAD file retains its embedded project as the migration source.

## Inherited cutting parameters

Each tool position has a native **TIP** coordinate system and stable CAM body instance IDs. TIP controls the placement of the physical assembly. The complete CAD bodies remain available for visualization and future collision checking.

Assign the **cutter** or **insert** role to the cutting part. A sole cutter or insert is selected automatically. If there are several, choose the **Cutting component** in the tool position. Holders, collets, adapters and other roles remain noncutting even when their source declares `TYPE`.

CAM resolves the designated component to its validated, pinned native `.whittle` source, including through Move / Copy. It evaluates the source part’s document-level parameters using native expressions and units. Each source file supplies one parameter set, including when it contains several bodies. Use a separate native part file for each distinct parameter set. Parameter names are case-insensitive for inheritance and must resolve uniquely.

| TYPE | Cutting family |
| --- | --- |
| 0 | FLAT |
| 1 | BALL |
| 2 | TOROIDAL |
| 3 | LOLLIPOP |
| 4 | CONICAL |
| 5 | FORM |

`TYPE` must be a dimensionless integer. A missing, invalid or unknown value leaves the cutting definition unavailable and blocks export for operations assigned to that tool. `CUTTER_DIAMETER` is required and supplies the nominal cutting diameter. `CUTTER_LENGTH`, `FLUTE_LENGTH` and `CORP_DIAMETER` (shank diameter) are optional. Declared dimensions must evaluate to positive lengths. Dimensionless lengths are interpreted in the source document's length unit. The Tools properties show resolved values in millimetres.

Circular-profile APT-CL uses the inherited nominal diameter of a FLAT cutter. The other five families are identified by their parameters for future strategies. Operation-specific contact diameter and height for conical and form tools, collision checking, and material removal simulation are deferred.

When older CAM files open, obsolete component profile definitions are dropped and any manual compensation diameter is retained as legacy data. Native sketches, parameters, bodies, component IDs and TIPs are kept. A tool whose original part lacks the required parameters needs a pinned native part with valid `TYPE` and `CUTTER_DIAMETER` before it can drive an assigned operation. Update the parameters in the source part and insert that revision in CAM to use it.
