# Manufacturing documents

Open the Manufacturing ribbon and choose **New CAM Document** or **Open CAM**. Use **Save CAM** to update the current file and **Save CAM As** to choose another destination. The main Save shortcut follows the active document. Whittle shows one active document per window. Ordinary New Design and Open still open CAD projects. Server-hosted Whittle uses local files for CAM. Browsers without a file picker download a new copy on save.

Use **Import** to insert a Whittle design, STEP, STL or OBJ. Whittle CAD bodies come in as individual CAM body instances. Use **Move / Copy** to translate or rotate an instance or create a new one. To align two frames, create two CAM coordinate systems before a Move step and turn on **Place between coordinate systems** in its editor. The rigid transform maps the source origin and axes to the target. It updates when those datums change. Use the existing Sketch, Construct and Parts Library tools to add CAM geometry. The existing Browser lists the bodies and datums.

## Version 1 file and reference contract

A `.cam` file is a ZIP with a `whittle-cam` format marker and schema version 1. Its `manufacturing.json` contains the CAM project, including setups, workpiece contexts, operations, the process plan and reserved tooling storage. Its `geometry.whittle` contains the CAM-owned timeline, IDs, body metadata, sketches, datums, imports and placement steps, using Whittle’s geometry codec. The project and geometry share a stable CAM document ID. Setups and operations reference CAM-local instance and sketch IDs. A native context datum is scoped to that CAM timeline.

A pinned CAD reference records its contract version, the source CAD document ID, source body ID and SHA-256 digest of the exact source file bytes. The field lives on the corresponding CAM import feature alongside its embedded snapshot. Move / Copy preserves its source through the timeline. Each placement copy has its own stable body ID. A CAD file without a document ID gets a revision-scoped fallback identity. Topology-level links and live updates are outside this contract.

CAM can reopen offline using the pinned snapshot. On the web, inserting and checking a pinned Whittle source requires HTTPS or localhost. Missing snapshot bytes, invalid revisions and missing or unbuildable source bodies surface as import failures. APT-CL export checks that the selected context’s references resolve and uses the existing deterministic exporter. **Verify CAD Source** compares a selected file with the pinned revision. A changed external file leaves the pinned geometry intact. Saving CAD again can change its byte revision even when its geometry is identical.

## Legacy migration

Open the legacy `.whittle` design, then select **Migrate Embedded Manufacturing** in Manufacturing. Use **Save CAM** to write the new document. Migration copies the geometry timeline and project, rebases local references to the new CAM document and preserves entity IDs and contextual settings. The original CAD file retains its embedded project as the migration source.
