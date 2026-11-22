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
    let file;
    const handle = {
      name: "manufacturing-regression.whittle",
      createWritable: async () => ({
        write: async (bytes) => { file = new File([bytes], handle.name); },
        close: async () => {},
      }),
      getFile: async () => file,
    };
    window.showSaveFilePicker = async () => handle;
    window.showOpenFilePicker = async () => [handle];
  });
  await page.goto(url);
  await page.getByRole("button", { name: /Maker & hobbyist/ }).click();
  await page.getByRole("button", { name: /Mounting plate/ }).click();
  await page.waitForFunction(() => {
    const { builtDoc, doc, regen } = window.whittle.useApp.getState();
    return builtDoc === doc && regen?.bodies.length;
  }, null, { timeout: 60_000 });

  const viewport = await page.locator(".viewport canvas").first().elementHandle();
  const manufacturing = page.getByRole("tab", { name: "Manufacturing" });
  await manufacturing.click();
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
  await properties.getByRole("heading", { name: "Setup 1" }).waitFor();

  const setupName = properties.getByLabel("Setup name");
  await setupName.fill("Primary machining");
  await setup.click();
  await setupName.fill("Temporary setup");
  await properties.getByRole("button", { name: "Delete setup" }).click();
  assert.equal(await history.getByRole("button", { name: "Temporary setup" }).count(), 0);

  const contextPicker = properties.getByLabel("Workpiece context");
  for (const [index, name] of ["Main", "Sub Horizontal", "Sub Vertical"].entries()) {
    await properties.getByLabel("New context CSYS").selectOption(frames[index].id);
    await properties.getByRole("button", { name: "Add context" }).click();
    await properties.getByLabel("Context name").fill(name);
  }
  const contextIds = await contextPicker.locator("option").evaluateAll((options) => options.map((option) => option.value));
  assert.equal(new Set(contextIds).size, 3);
  await properties.getByLabel("Selected body role").selectOption("fixture");
  await properties.getByRole("button", { name: "Assign selected bodies" }).click();
  await properties.getByRole("list", { name: "Assigned bodies" }).getByText(/fixture/).waitFor();
  await contextPicker.selectOption({ label: "Sub Horizontal" });
  await properties.getByLabel("Selected body role").selectOption("stock");
  await properties.getByRole("button", { name: "Assign selected bodies" }).click();
  await contextPicker.selectOption({ label: "Main" });

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
  await properties.getByRole("button", { name: "Add transfer" }).click();
  await properties.getByRole("heading", { name: "Transfer" }).waitFor();
  assert.equal(await track.count(), 0);

  await addProfile.click();
  await machiningStage.selectOption({ label: "Sub / back-working" });
  await track.selectOption({ label: "Main Track · Channel 1" });
  await setupTile.click();
  await properties.getByRole("button", { name: "Add ejection" }).click();
  await properties.getByRole("heading", { name: "Ejection" }).waitFor();

  const expected = ["Primary machining", "Profile 1 · Main machining", "Transfer", "Profile 2 · Sub / back-working", "Ejection"];
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
  await history.getByRole("button", { name: "Transfer" }).click();
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
  await page.evaluate(() => {
    const app = window.whittle.useApp;
    const sketch = app.getState().doc.features.find((item) => item.name === "CAM test circle");
    app.setState({ selection: [{ kind: "sketch", sketchId: sketch.id }] });
  });
  await manufacturing.click();
  await addProfile.click();
  await properties.getByRole("heading", { name: "Profile 3" }).waitFor();
  await properties.getByLabel("Flat endmill diameter (mm)").fill("4");
  await properties.getByLabel("Cut depth (mm)").fill("2");
  await properties.getByLabel("Clearance above sketch (mm)").fill("5");
  await properties.getByLabel("Cut feed (mm/min)").fill("200");
  await properties.getByLabel("Plunge feed (mm/min)").fill("50");

  async function exportProfile() {
    const downloadPromise = page.waitForEvent("download");
    await properties.getByRole("button", { name: "Export APT-CL" }).click();
    const download = await downloadPromise;
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

  const command = (id) => page.evaluate((id) => window.whittle.commands.find((item) => item.id === id).run(), id);
  await command("save");
  await page.waitForFunction(() => {
    const { fileName, dirty } = window.whittle.useApp.getState();
    return fileName === "manufacturing-regression.whittle" && !dirty;
  });
  // Change the live project so reopening must restore it from the saved bytes.
  await contextPicker.selectOption({ label: "Main" });
  await page.evaluate(() => window.whittle.useApp.setState({ dirty: false }));
  await command("open");
  await page.getByText("Opened manufacturing-regression.whittle", { exact: true }).waitFor();
  await manufacturing.click();
  assert.deepEqual(await tiles.allTextContents(), [...expected, "Profile 3 · Main machining"]);
  await history.getByRole("button", { name: "Profile 3 · Main machining" }).click();
  assert.equal(await contextPicker.inputValue(), contextIds[1]);
  assert.equal(await properties.getByLabel("Flat endmill diameter (mm)").inputValue(), "4");
  assert.equal(await exportProfile(), datumApt);

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
  await contextPicker.selectOption({ label: "Sub Horizontal" });
  assert.equal(await properties.getByRole("button", { name: "Delete context" }).isDisabled(), true);
  await contextPicker.selectOption({ label: "Sub Vertical" });
  await properties.getByRole("button", { name: "Delete context" }).click();
  assert.equal(await contextPicker.locator("option").count(), 2);
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
  console.log("ok  Multiple workpiece contexts, shared roles, native CSYS transforms, save/reopen and broken references");

  async function platformMissingBody() {
    await page.evaluate(() => window.whittle.useApp.setState(({ doc }) => ({
      doc: { ...doc, bodies: {} },
    })));
  }
} finally {
  await browser.close();
}
