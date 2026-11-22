import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    localStorage.setItem("whittle.debug", "1");
    const files = new Map();
    const writes = [];
    const makeHandle = (name) => ({
      name,
      createWritable: async () => ({
        write: async (bytes) => { files.set(name, new File([bytes], name)); writes.push(name); },
        close: async () => {},
      }),
      getFile: async () => files.get(name),
    });
    const handles = {
      cad: makeHandle("manufacturing-source.whittle"),
      cam: makeHandle("manufacturing-regression.cam"),
      copy: makeHandle("manufacturing-copy.cam"),
    };
    window.camTestFiles = { files, writes };
    window.showSaveFilePicker = async ({ suggestedName }) => {
      if (window.camTestFiles.wrongSuffix) return handles.cad;
      if (!suggestedName.endsWith(".cam")) return handles.cad;
      return files.has(handles.cam.name) ? handles.copy : handles.cam;
    };
    window.showOpenFilePicker = async ({ types }) =>
      [types[0].description === "Whittle CAM document" ? handles.cam : handles.cad];
  });
  await page.goto(url);
  await page.waitForFunction(() => !!window.whittle?.useApp);
  await page.getByRole("button", { name: /Maker & hobbyist/ }).click();
  await page.getByRole("button", { name: /Mounting plate/ }).click();
  await page.waitForFunction(() => {
    const { builtDoc, doc, regen } = window.whittle.useApp.getState();
    return builtDoc === doc && regen?.bodies.length;
  }, null, { timeout: 60_000 });

  const viewport = await page.locator(".viewport canvas").first().elementHandle();
  const manufacturing = page.getByRole("tab", { name: "Manufacturing" });
  const command = (id) => page.evaluate((id) => window.whittle.commands.find((item) => item.id === id).run(), id);
  const name = "manufacturing-source.whittle";
  await command("save");
  await page.waitForFunction((name) => window.camTestFiles.files.has(name), name);
  const source = await page.evaluate(async (name) => Array.from(new Uint8Array(await window.camTestFiles.files.get(name).arrayBuffer())), name);
  await manufacturing.click();
  assert.equal(await page.getByRole("button", { name: "Save CAM", exact: true }).isEnabled(), false);
  await page.getByRole("button", { name: "New CAM Document" }).click();
  await page.waitForFunction(() => {
    const { doc, documentKind } = window.whittle.useApp.getState();
    return documentKind === "cam" && doc.features.length === 0 && doc.manufacturing;
  });
  const chooser = page.waitForEvent("filechooser");
  await page.locator('[data-tour="import"]').click();
  await (await chooser).setFiles({ name, mimeType: "application/vnd.whittle+zip", buffer: Buffer.from(source) });
  await page.waitForFunction(() => {
    const { builtDoc, doc, regen } = window.whittle.useApp.getState();
    return builtDoc === doc && regen?.bodies.length && doc.features.some((f) => f.cadSource);
  }, null, { timeout: 60_000 });
  const verify = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Verify CAD Source" }).click();
  await (await verify).setFiles({ name, mimeType: "application/vnd.whittle+zip", buffer: Buffer.from(source) });
  await page.getByText("The selected CAD file matches the pinned revision.", { exact: true }).waitFor();
  const timeline = page.getByLabel("Manufacturing timeline");
  const setup = page.getByRole("button", { name: "Create setup" });
  assert.equal(await setup.isEnabled(), true);
  const history = timeline.getByRole("list", { name: "Part history" });
  const tiles = history.getByRole("button");
  assert.equal(await tiles.count(), 0);

  await page.evaluate(() => {
    const app = window.whittle.useApp;
    const bodyId = app.getState().regen.bodies[0].id;
    app.setState({ selection: [{ kind: "body", bodyId }] });
  });
  const frames = [
    { id: "cam-main", name: "Main CSYS", position: ["0", "0", "10"], rotation: ["0", "0", "0"] },
    { id: "cam-sub-horizontal", name: "Sub Horizontal CSYS", position: ["10", "20", "1"], rotation: ["0", "0", "90 deg"] },
    { id: "cam-sub-vertical", name: "Sub Vertical CSYS", position: ["0", "0", "0"], rotation: ["90 deg", "0", "0"] },
  ];
  await page.evaluate((frames) => {
    window.whittle.useApp.setState(({ doc }) => ({
      doc: { ...doc, features: [...doc.features, ...frames.map((frame) => ({
        ...frame, type: "csys", mode: "manual", refs: {}, flipZ: false, flipX: false,
      }))] },
    }));
  }, frames);
  await setup.click();
  const properties = page.getByRole("complementary", { name: "Manufacturing properties" });
  await properties.getByRole("heading", { name: "PART1" }).waitFor();

  const setupName = properties.getByLabel("Setup name");
  await setupName.fill("Primary machining");
  await setup.click();
  await setupName.fill("Temporary setup");
  await properties.getByRole("button", { name: "Delete setup" }).click();
  assert.equal(await history.getByRole("button", { name: "Temporary setup" }).count(), 0);

  const contextPicker = properties.getByLabel("Workpiece context", { exact: true });
  const contextList = properties.getByRole("list", { name: "Workpiece contexts" });
  const contextPanel = properties.getByRole("region", { name: "Context properties" });
  const contextName = contextPanel.getByLabel("Context name");
  const contextCsys = contextPanel.getByLabel("Context CSYS");
  const editContext = (name) => contextList.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
  const readContexts = () => page.evaluate(() => window.whittle.useApp.getState().doc.manufacturing.setups[0].contexts);
  assert.equal(await contextPanel.count(), 0);
  assert.equal(await properties.getByRole("button", { name: /Add (transfer|ejection)/i }).count(), 0);
  for (const [index, name] of ["Main", "Sub Horizontal", "Sub Vertical"].entries()) {
    await properties.getByRole("button", { name: "Add Context" }).click();
    assert.equal(await contextPanel.count(), 1);
    await contextName.fill(name);
    await contextCsys.selectOption(frames[index].id);
    const row = contextList.getByRole("listitem").filter({ hasText: name });
    await row.getByText(frames[index].name, { exact: true }).waitFor();
    assert.equal(await row.getByRole("button").getAttribute("aria-expanded"), "true");
  }
  const contextIds = (await readContexts()).map((context) => context.id);
  assert.equal(new Set(contextIds).size, 3);
  const assignedBodies = contextPanel.getByRole("list", { name: "Assigned bodies" });
  const bodyRole = contextPanel.getByLabel("Selected body role");
  const assignBodies = contextPanel.getByRole("button", { name: "Assign selected bodies" });
  await bodyRole.selectOption("fixture");
  await assignBodies.click();
  await assignedBodies.getByText("Fixture", { exact: true }).waitFor();
  await editContext("Sub Horizontal");
  assert.equal(await contextPanel.count(), 1);
  assert.equal(await contextName.inputValue(), "Sub Horizontal");
  assert.equal(await assignedBodies.getByText("Fixture", { exact: true }).count(), 0);
  await bodyRole.selectOption("stock");
  await assignBodies.click();
  await assignedBodies.getByRole("button", { name: /as stock$/ }).click();
  assert.equal(await assignedBodies.getByText("Stock", { exact: true }).count(), 0);
  await assignBodies.click();
  await editContext("Main");
  await contextPanel.getByRole("button", { name: "Done" }).click();
  assert.equal(await contextPanel.count(), 0);

  const addProfile = page.getByRole("button", { name: "Add profile" });
  const setupTile = history.getByRole("button", { name: "Primary machining" });
  const track = properties.getByLabel("Execution track");
  const machiningStage = properties.getByLabel("Machining stage");

  await addProfile.click();
  await properties.getByRole("heading", { name: "Profile 1" }).waitFor();
  assert.equal(await track.inputValue(), "");
  await track.selectOption({ label: "Secondary Track · Channel 2" });
  await properties.getByText("Execution Unit 1", { exact: true }).filter({ visible: true }).waitFor();

  await setupTile.click();
  assert.equal(await contextPanel.count(), 0);
  await addProfile.click();
  await machiningStage.selectOption({ label: "Sub / back-working" });
  await track.selectOption({ label: "Main Track · Channel 1" });
  await setupTile.click();

  const expected = ["Primary machining", "Profile 1 · Main machining", "Profile 2 · Sub / back-working"];
  assert.deepEqual(await tiles.allTextContents(), expected);
  const topPositions = await tiles.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
  assert.equal(new Set(topPositions).size, 1);

  const first = history.getByRole("button", { name: expected[1] });
  await first.focus();
  await first.press("Enter");
  assert.equal(await first.getAttribute("aria-pressed"), "true");
  assert.equal(await track.inputValue(), "unit-1/track-2");
  await track.selectOption({ label: "Unassigned" });
  assert.deepEqual(await tiles.allTextContents(), expected);
  await setupTile.click();
  await first.click();
  assert.equal(await track.inputValue(), "");

  const manufacturingHeight = await timeline.evaluate((bar) => bar.getBoundingClientRect().height);
  await page.getByRole("tab", { name: "Solid" }).click();
  const cadTimeline = page.getByLabel("Timeline", { exact: true });
  await cadTimeline.waitFor();
  assert.equal(await cadTimeline.evaluate((bar) => bar.getBoundingClientRect().height), manufacturingHeight);
  await manufacturing.click();
  await first.waitFor();
  assert.deepEqual(await tiles.allTextContents(), expected);
  assert.equal(await viewport.evaluate((canvas) => canvas === document.querySelector(".viewport canvas")), true);
  console.log("ok  Manufacturing part history, selection, track assignment and native workspace switching");

  await page.evaluate(() => window.whittle.api.run("add_sketch", {
    name: "CAM test circle", plane: "XY", offset: 10,
    shapes: [{ type: "circle", x: 2, y: 3, radius: 8 }],
  }));
  await page.waitForFunction(() => {
    const { doc, builtDoc, regen } = window.whittle.useApp.getState();
    const sketch = doc.features.find((item) => item.name === "CAM test circle");
    return builtDoc === doc && regen?.sketches.some((item) => item.id === sketch?.id);
  });
  await manufacturing.click();
  await addProfile.click();
  await properties.getByRole("heading", { name: "Profile 3" }).waitFor();
  const useSketch = properties.getByRole("button", { name: "Use Selected Sketch" });
  assert.equal(await useSketch.isDisabled(), true);
  const sketchRow = page.getByRole("navigation", { name: "Design browser" })
    .getByRole("button", { name: "CAM test circle", exact: true });
  await sketchRow.click();
  await useSketch.click();
  await properties.getByText("CAM test circle", { exact: true }).waitFor();
  await first.click();
  await page.evaluate(() => window.whittle.useApp.setState({ selection: [] }));
  assert.equal(await useSketch.isDisabled(), true);
  await page.evaluate(() => window.whittle.viewportRef.current.viewTo("top"));
  await page.waitForFunction(() => !window.whittle.viewportRef.current.anim);
  const sketchPoint = await page.evaluate(() => {
    const { doc, regen } = window.whittle.useApp.getState();
    const sketch = doc.features.find((item) => item.name === "CAM test circle");
    const frame = regen.sketches.find((item) => item.id === sketch.id);
    const vp = window.whittle.viewportRef.current;
    const bounds = document.querySelector(".viewport canvas").getBoundingClientRect();
    for (let i = 0; i < 16; i++) {
      const angle = i * Math.PI / 8;
      const world = frame.origin.map((value, axis) => value
        + frame.xDir[axis] * (2 + 8 * Math.cos(angle)) + frame.yDir[axis] * (3 + 8 * Math.sin(angle)));
      const [x, y] = vp.worldToScreen(world);
      const clientX = bounds.left + x * bounds.width / vp.size.x;
      const clientY = bounds.top + y * bounds.height / vp.size.y;
      const pick = vp.pick({ clientX, clientY });
      if (pick?.sketchId === sketch.id) return [clientX, clientY];
    }
  });
  assert.ok(sketchPoint, "The circle can be picked in the 3D view");
  await page.mouse.click(...sketchPoint);
  await useSketch.click();
  await properties.getByText("CAM test circle", { exact: true }).waitFor();
  await history.getByRole("button", { name: "Profile 3 · Main machining" }).click();
  await properties.getByLabel("Flat endmill diameter (mm)").fill("4");
  await properties.getByLabel("Cut depth (mm)").fill("2");
  await properties.getByLabel("Clearance above sketch (mm)").fill("5");
  await properties.getByLabel("Cut feed (mm/min)").fill("200");
  await properties.getByLabel("Plunge feed (mm/min)").fill("50");

  async function exportProfile() {
    await page.waitForFunction(() => {
      const { builtDoc, doc } = window.whittle.useApp.getState();
      return builtDoc === doc;
    });
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 10_000 }),
      properties.getByRole("button", { name: "Export APT-CL" }).click(),
    ]).catch(async (error) => {
      throw new Error(`APT-CL export failed. ${await properties.getByRole("alert").allTextContents()}`, { cause: error });
    });
    assert.match(download.suggestedFilename(), /^profile.*\.apt$/);
    return readFile(await download.path(), "utf8");
  }

  const apt = await exportProfile();
  assert.match(apt, /^FROM\/12,3,5,0,0,1$/m);
  assert.match(apt, /^CIRCLE\/2,3,-2,0,0,1,10$/m);
  assert.equal([...apt.matchAll(/^CIRCLE\//gm)].length, 4);
  assert.match(apt, /^RAPID\nGOTO\/12,3,5,0,0,1\nFINI\n$/m);
  console.log("ok  Manufacturing circular profile and APT-CL download");

  const datumId = frames[1].id;
  await contextPicker.selectOption({ label: "Sub Vertical" });
  const verticalApt = await exportProfile();
  assertCoordinates(verticalApt, "FROM", [12, 15, -3, 0, 1, 0]);
  assert.equal([...verticalApt.matchAll(/^CIRCLE\//gm)].length, 4);
  await contextPicker.selectOption({ label: "Sub Horizontal" });
  const datumApt = await exportProfile();
  function assertCoordinates(apt, record, expectedCoordinates) {
    const line = apt.split("\n").find((item) => item.startsWith(`${record}/`));
    assert.ok(line, `Expected a ${record} record`);
    const actual = line.slice(record.length + 1).split(",").map(Number);
    assert.equal(actual.length, expectedCoordinates.length);
    for (const [index, coordinate] of expectedCoordinates.entries()) {
      assert.ok(Math.abs(actual[index] - coordinate) < 1e-9, `${record} coordinates: ${actual}`);
    }
  }
  assertCoordinates(datumApt, "FROM", [-17, -2, 14, 0, 0, 1]);
  assertCoordinates(datumApt, "CIRCLE", [-17, 8, 7, 0, 0, 1, 10]);
  assert.equal([...datumApt.matchAll(/^CIRCLE\//gm)].length, 4);

  const toolsTab = page.getByRole("group", { name: "Manufacturing browser" }).getByRole("button", { name: "Tools", exact: true });
  await toolsTab.click();
  await properties.getByRole("button", { name: "Add Tool Position" }).click();
  const positions = page.getByRole("region", { name: "Tool positions" });
  const toolId = await page.evaluate(() => window.whittle.useApp.getState().doc.manufacturing.toolPositions[0].id);
  const diameter = properties.getByLabel("Flat endmill diameter (mm)");
  await diameter.fill("4");
  await diameter.press("Tab");
  const third = history.getByRole("button", { name: "Profile 3 · Main machining" });
  const toolPicker = properties.getByLabel("Tool position", { exact: true });
  const spindle = properties.getByLabel("Spindle speed (rpm)");
  await third.click();
  await toolPicker.selectOption(toolId);
  await spindle.fill("-9000");
  await properties.getByRole("alert").getByText(/positive spindle speed/).waitFor();
  await spindle.fill("9000");
  assert.equal(await exportProfile(), datumApt);
  await first.click();
  assert.equal(await toolPicker.inputValue(), "");
  assert.equal(await spindle.inputValue(), "");
  await positions.getByRole("button", { name: "T01 — Tool", exact: true }).click();
  const number = properties.getByLabel("Tool number");
  await number.fill("7");
  await number.press("Tab");
  await third.click();
  assert.equal(await toolPicker.inputValue(), toolId);
  assert.equal(await toolPicker.locator("option:checked").textContent(), "T07 — Tool");

  await page.getByRole("button", { name: "Save CAM", exact: true }).click();
  await page.waitForFunction(() => {
    const { fileName, dirty } = window.whittle.useApp.getState();
    return fileName === "manufacturing-regression.cam" && !dirty;
  });
  await page.getByRole("button", { name: "Save CAM", exact: true }).click();
  await page.waitForFunction(() => window.camTestFiles.writes.length === 3);
  await page.evaluate(() => { window.camTestFiles.wrongSuffix = true; });
  await page.getByRole("button", { name: "Save CAM As", exact: true }).click();
  await page.getByText(/Choose a \.cam filename/).waitFor();
  await page.evaluate(() => { window.camTestFiles.wrongSuffix = false; });
  await page.getByRole("button", { name: "Save CAM As", exact: true }).click();
  await page.waitForFunction(() => window.whittle.useApp.getState().fileName === "manufacturing-copy.cam");
  assert.deepEqual(await page.evaluate(() => window.camTestFiles.writes), [name, "manufacturing-regression.cam", "manufacturing-regression.cam", "manufacturing-copy.cam"]);
  assert.deepEqual(await page.evaluate(async (name) => Array.from(new Uint8Array(await window.camTestFiles.files.get(name).arrayBuffer())), name), source);
  // Change the live project so reopening must restore it from the saved bytes.
  await contextPicker.selectOption({ label: "Main" });
  await page.evaluate(() => window.whittle.useApp.setState({ dirty: false }));
  await page.getByRole("button", { name: "Open CAM", exact: true }).click();
  await page.getByText("Opened manufacturing-regression.cam", { exact: true }).waitFor();
  await manufacturing.click();
  assert.deepEqual(await tiles.allTextContents(), [...expected, "Profile 3 · Main machining"]);
  await history.getByRole("button", { name: "Profile 3 · Main machining" }).click();
  assert.equal(await contextPicker.inputValue(), contextIds[1]);
  assert.equal(await toolPicker.inputValue(), toolId);
  assert.equal(await spindle.inputValue(), "9000");
  assert.equal(await properties.getByLabel("Cut feed (mm/min)").inputValue(), "200");
  assert.equal(await properties.getByLabel("Plunge feed (mm/min)").inputValue(), "50");
  assert.equal(await exportProfile(), datumApt);
  await toolsTab.click();
  await positions.getByRole("button", { name: "T07 — Tool", exact: true }).click();
  await properties.getByRole("button", { name: "Delete Tool", exact: true }).click();
  await third.click();
  assert.equal(await toolPicker.inputValue(), toolId);
  assert.equal(await toolPicker.locator("option:checked").textContent(), "Tool position unavailable");
  await properties.getByRole("alert").getByText(/references a missing tool position/).waitFor();
  const missingToolDownload = () => assert.fail("A missing tool position must not export APT-CL");
  page.on("download", missingToolDownload);
  await properties.getByRole("button", { name: "Export APT-CL" }).click();
  await properties.getByRole("alert").getByText(/references a missing tool position/).last().waitFor();
  page.off("download", missingToolDownload);
  await page.getByRole("button", { name: "Save CAM", exact: true }).click();
  await page.waitForFunction(() => !window.whittle.useApp.getState().dirty);
  await page.getByRole("button", { name: "Open CAM", exact: true }).click();
  await page.waitForFunction(() => window.whittle.useApp.getState().camBrowserTab === "browser");
  await third.click();
  assert.equal(await toolPicker.inputValue(), toolId);
  assert.equal(await spindle.inputValue(), "9000");
  await toolPicker.selectOption({ label: "Unassigned" });
  assert.equal(await properties.getByLabel("Flat endmill diameter (mm)").inputValue(), "4");
  assert.equal(await exportProfile(), datumApt);
  console.log("ok  Operation tool IDs, cutting conditions, deleted tool recovery and deterministic APT-CL");

  const savedContexts = await page.evaluate(() => {
    const { doc } = window.whittle.useApp.getState();
    return doc.manufacturing.setups[0].contexts;
  });
  assert.deepEqual(savedContexts.map((context) => context.id), contextIds);
  assert.equal(new Set(savedContexts.flatMap((context) => context.bodies.map(({ body }) => body.entityId))).size, 1);
  assert.deepEqual(savedContexts.map((context) => context.bodies.map(({ role }) => role)),
    [["workpiece"], ["workpiece", "stock"], ["workpiece", "fixture"]]);
  await setupTile.click();
  assert.equal(await properties.getByRole("button", { name: "Delete setup" }).isDisabled(), true);
  assert.equal(await contextPanel.count(), 0);
  assert.deepEqual(savedContexts.map((context) => context.frame.csysId), frames.map(({ id }) => id));
  await editContext("Sub Horizontal");
  const removeContext = contextPanel.getByRole("button", { name: "Remove Context" });
  assert.equal(await removeContext.isDisabled(), true);
  await contextPanel.getByText("Reassign the operations using this context before removing it.").waitFor();
  await editContext("Sub Vertical");
  const readCad = () => page.evaluate(() => {
    const { doc } = window.whittle.useApp.getState();
    return { bodies: doc.bodies, datums: doc.features.filter((feature) => feature.type === "csys") };
  });
  const cadBeforeRemoval = await readCad();
  await removeContext.click();
  assert.equal(await contextPanel.count(), 0);
  assert.deepEqual(await readContexts(), savedContexts.slice(0, 2));
  assert.deepEqual(await readCad(), cadBeforeRemoval);
  await history.getByRole("button", { name: "Profile 3 · Main machining" }).click();

  await page.evaluate((id) => window.whittle.useApp.setState(({ doc }) => ({
    doc: { ...doc, features: doc.features.map((feature) => feature.id === id
      ? { ...feature, position: ["10", "22", "1"] } : feature) },
  })), datumId);
  assertCoordinates(await exportProfile(), "FROM", [-19, -2, 14, 0, 0, 1]);

  // Keep the reference visible and refuse export if the underlying datum disappears.
  await page.evaluate((id) => window.whittle.useApp.setState(({ doc }) => ({
    doc: { ...doc, features: doc.features.filter((feature) => feature.id !== id) },
  })), datumId);
  assert.equal(await contextPicker.inputValue(), contextIds[1]);
  const unexpectedDownload = () => assert.fail("A missing datum must not export APT-CL");
  page.on("download", unexpectedDownload);
  await properties.getByRole("button", { name: "Export APT-CL" }).click();
  await properties.getByRole("alert").getByText(/context coordinate system is unavailable/).waitFor();
  page.off("download", unexpectedDownload);
  await setupTile.click();
  await platformMissingBody();
  await properties.getByRole("alert").getByText(/unavailable workpiece body/).first().waitFor();
  await command("open");
  await page.getByRole("button", { name: "Discard changes" }).click();
  await page.waitForFunction(() => {
    const { documentKind, doc } = window.whittle.useApp.getState();
    return documentKind === "cad" && !doc.manufacturing && doc.features.length > 0;
  });
  await page.evaluate(() => {
    const app = window.whittle.useApp;
    app.setState(({ doc }) => {
      const body = Object.keys(doc.bodies)[0];
      return { dirty: true, doc: { ...doc, manufacturing: {
        schemaVersion: 1, name: "Legacy CAM",
        setups: [{ id: "legacy-setup", name: "Migrated milling", part: { documentId: doc.id, entityId: body, kind: "body" } }],
        processes: [],
      } } };
    });
  });
  await command("save");
  await page.waitForFunction(() => !window.whittle.useApp.getState().dirty);
  const legacySource = await page.evaluate(async (name) => Array.from(new Uint8Array(await window.camTestFiles.files.get(name).arrayBuffer())), name);
  await manufacturing.click();
  await page.getByRole("button", { name: "Migrate Embedded Manufacturing" }).click();
  await history.getByRole("button", { name: "Migrated milling" }).waitFor();
  await page.getByRole("button", { name: "Save CAM", exact: true }).click();
  await page.waitForFunction(() => !window.whittle.useApp.getState().dirty);
  assert.deepEqual(await page.evaluate(async (name) => Array.from(new Uint8Array(await window.camTestFiles.files.get(name).arrayBuffer())), name), legacySource);
  console.log("ok  Independent CAD/CAM files, migration, source verification, native CSYS, deterministic APT-CL and broken references");

  async function platformMissingBody() {
    await page.evaluate(() => window.whittle.useApp.setState(({ doc }) => ({
      doc: { ...doc, bodies: {} },
    })));
  }
} finally {
  await browser.close();
}
