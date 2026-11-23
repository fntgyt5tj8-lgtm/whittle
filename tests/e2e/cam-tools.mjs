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
    };
    window.camTestFiles = { files, writes };
    window.showSaveFilePicker = async ({ suggestedName }) => {
      if (!suggestedName.endsWith(".cam")) return handles.cad;
      return handles.cam;
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

  const manufacturing = page.getByRole("tab", { name: "Manufacturing" });
  const command = (id) => page.evaluate((id) => window.whittle.commands.find((item) => item.id === id).run(), id);
  const name = "manufacturing-source.whittle";
  await page.evaluate((diameter) => {
    const { useApp } = window.whittle;
    const { doc } = useApp.getState();
    useApp.setState({ doc: { ...doc, parameters: [
      ...doc.parameters,
      { id: "cam-type", name: "TYPE", expr: "0", kind: "number" },
      { id: "cam-diameter", name: "CUTTER_DIAMETER", expr: String(diameter), kind: "length" },
      { id: "cam-shank", name: "CORP_DIAMETER", expr: "6 mm", kind: "length" },
    ] } });
  }, 1);
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
  const ordinaryImport = page.waitForEvent("filechooser");
  await page.locator('[data-tour="import"]').click();
  await (await ordinaryImport).setFiles({ name, mimeType: "application/vnd.whittle+zip", buffer: Buffer.from(source) });
  await page.waitForFunction(() => {
    const { doc, builtDoc, regen } = window.whittle.useApp.getState();
    return doc === builtDoc && regen?.bodies.length > 0;
  }, null, { timeout: 60_000 });
  const browserTabs = page.getByRole("group", { name: "Manufacturing browser" });
  const toolsTab = browserTabs.getByRole("button", { name: "Tools", exact: true });
  const positions = page.getByRole("region", { name: "Tool positions" });
  const properties = page.getByRole("complementary", { name: "Manufacturing properties" });
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  assert.equal(await positions.count(), 0);
  await manufacturing.click();
  await command("csys");
  const fixture = page.getByRole("complementary", { name: /properties/ }).filter({ has: page.getByLabel("Feature name") });
  await fixture.getByLabel("Feature name").fill("Fixture CSYS");
  await fixture.getByRole("button", { name: "OK", exact: true }).click();
  await toolsTab.click();
  await properties.getByRole("button", { name: "Add Tool Position" }).click();
  const position = positions.getByRole("button", { name: "T03 — Finisher", exact: true });
  await positions.getByRole("button", { name: "Expand T01 — Tool" }).click();
  assert.equal(await positions.getByRole("button", { name: "TIP", exact: true }).count(), 1);
  await positions.getByRole("button", { name: "Collapse T01 — Tool" }).click();
  assert.equal(await positions.getByRole("button", { name: "TIP", exact: true }).count(), 0);
  await positions.getByRole("button", { name: "T01 — Tool", exact: true }).click();
  const commit = async (input, text) => {
    await input.fill(text);
    await input.press("Tab");
  };
  await commit(properties.getByLabel("Tool number"), "3");
  await commit(properties.getByLabel("Name", { exact: true }), "Finisher");
  assert.equal(await positions.locator("input, select, button:has-text('Insert Body')").count(), 0);
  const insert = page.waitForEvent("filechooser");
  await properties.getByRole("button", { name: "Insert Body", exact: true }).click();
  await (await insert).setFiles({ name, mimeType: "application/vnd.whittle+zip", buffer: Buffer.from(source) });
  const awaitTool = (componentCount) => page.waitForFunction((count) => {
    const { doc, builtDoc, regen } = window.whittle.useApp.getState();
    const tool = doc.manufacturing?.toolPositions?.[0];
    return tool?.components.length === count && builtDoc === doc
      && tool.components.every(({ bodyId }) => regen.bodies.some(({ id }) => id === bodyId));
  }, componentCount, { timeout: 60_000 });
  await awaitTool(1);
  const toolModel = () => page.evaluate(() => window.whittle.useApp.getState().doc.manufacturing?.toolPositions?.[0]);
  const components = positions.locator(".cam-tool__children button").filter({ hasNotText: /^TIP$/ });
  await components.first().click();
  assert.equal(await properties.getByLabel("Role", { exact: true }).inputValue(), "cutter");
  assert.equal(await properties.getByText("As inserted", { exact: true }).count(), 1);
  await properties.getByRole("button", { name: "Copy", exact: true }).click();
  await awaitTool(2);
  await components.last().click();
  await properties.getByLabel("Role", { exact: true }).selectOption("holder");
  const tool = await toolModel();
  assert.deepEqual(tool.components.map(({ role }) => role), ["cutter", "holder"]);
  assert.notEqual(tool.components[0].bodyId, tool.components[1].bodyId);
  assert.equal(tool.number, 3);
  assert.equal(tool.name, "Finisher");
  await properties.getByText("Noncutting component", { exact: true }).waitFor();
  await components.first().click();
  await properties.getByText("0 · FLAT", { exact: true }).waitFor();
  await properties.getByText("1 mm", { exact: true }).waitFor();
  await properties.getByText("6 mm", { exact: true }).waitFor();
  await components.last().click();

  await properties.getByRole("button", { name: "Move", exact: true }).click();
  const movePanel = page.getByRole("complementary", { name: /Move .*properties/ });
  const translation = movePanel.getByLabel("X", { exact: true });
  await translation.fill("10");
  await translation.press("Tab");
  await movePanel.getByRole("button", { name: "OK", exact: true }).click();

  await page.waitForFunction(([cutterId, holderId]) => {
    const { doc, builtDoc, regen } = window.whittle.useApp.getState();
    const low = (id) => regen?.bodies.find((body) => body.id === id)?.bbox[0][0];
    return doc === builtDoc && Math.abs(low(holderId) - low(cutterId) - 10) < 1e-6;
  }, tool.components.map(({ bodyId }) => bodyId));
  await properties.getByText(/X 10, Y 0, Z 0/).waitFor();
  await properties.getByLabel("Visible", { exact: true }).uncheck();
  const holderId = tool.components[1].bodyId;
  const visibleBodies = () => page.evaluate(() => [...window.whittle.viewportRef.current.bodies]
    .filter(([, view]) => view.visible).map(([id]) => id).sort());
  const checkVisibility = (ids) => page.waitForFunction((ids) => {
    const visible = [...window.whittle.viewportRef.current.bodies]
      .filter(([, view]) => view.visible).map(([id]) => id).sort();
    return JSON.stringify(visible) === JSON.stringify(ids);
  }, ids);
  const bodyIds = tool.components.map(({ bodyId }) => bodyId).sort();
  const beforeIsolation = await visibleBodies();
  assert.ok(beforeIsolation.includes(tool.components[0].bodyId) && !beforeIsolation.includes(holderId));
  assert.ok(beforeIsolation.some((id) => !bodyIds.includes(id)));
  await position.click();
  const isolate = properties.getByRole("button", { name: "Isolate Tool", exact: true });
  const restore = page.getByRole("button", { name: "Restore Visibility", exact: true });
  await isolate.click();
  await checkVisibility(bodyIds);
  assert.equal(await page.evaluate((id) => window.whittle.useApp.getState().doc.bodies[id].visible, holderId), false);
  await restore.click();
  await checkVisibility(beforeIsolation);

  await positions.getByRole("button", { name: "TIP", exact: true }).click();
  const tipPanel = page.getByRole("complementary", { name: "TIP properties" });
  await tipPanel.getByRole("radio", { name: "References", exact: true }).click();
  const pickOrigin = tipPanel.getByRole("button", { name: "Pick Origin", exact: true });
  await pickOrigin.click();
  assert.equal(await pickOrigin.getAttribute("aria-pressed"), "true");
  await browserTabs.getByRole("button", { name: "Browser", exact: true }).click();
  await page.getByRole("navigation", { name: "Design browser" })
    .getByRole("button", { name: "Fixture CSYS", exact: true }).click();
  assert.equal(await tipPanel.getByRole("button", { name: "Replace Origin" }).textContent(), "Fixture CSYS");
  await tipPanel.getByRole("button", { name: "Cancel", exact: true }).click();
  await toolsTab.click();
  await position.click();
  await positions.getByRole("button", { name: "TIP", exact: true }).click();
  await commit(tipPanel.getByLabel("Origin X", { exact: true }), "25");
  await commit(tipPanel.getByLabel("Rotation about Z", { exact: true }), "90");
  await tipPanel.getByRole("button", { name: "OK", exact: true }).click();
  await page.waitForFunction(({ tipCsysId, components }) => {
    const { doc, builtDoc, regen } = window.whittle.useApp.getState();
    const tip = regen?.planes.find((frame) => frame.id === tipCsysId);
    const low = (id) => regen?.bodies.find((body) => body.id === id)?.bbox[0];
    const [cutter, holder] = components.map(({ bodyId }) => low(bodyId));
    return doc === builtDoc && tip?.origin[0] === 25 && Math.abs(tip.xDir[1] - 1) < 1e-6
      && Math.abs(holder[1] - cutter[1] - 10) < 1e-6 && Math.abs(holder[0] - cutter[0]) < 1e-6;
  }, tool);
  await position.click();

  await isolate.click();
  await checkVisibility(bodyIds);
  await manufacturing.click();
  await restore.click();
  await page.evaluate(() => window.whittle.api.run("add_sketch", {
    name: "Finishing contour", plane: "XY", offset: 10,
    shapes: [{ type: "circle", x: 2, y: 3, radius: 8 }],
  }));
  await page.evaluate(() => window.whittle.api.run("add_sketch", {
    name: "Island sketch", plane: "XY", offset: 9,
    shapes: [{ type: "circle", x: 2, y: 3, radius: 2 }],
  }));
  await manufacturing.click();
  await page.getByRole("button", { name: "Create setup", exact: true }).click();
  await properties.getByRole("button", { name: "Add Context", exact: true }).click();
  const fixtureId = await page.evaluate(() => window.whittle.useApp.getState().doc.features
    .find((feature) => feature.name === "Fixture CSYS").id);
  await properties.getByLabel("Context CSYS").selectOption(fixtureId);
  await properties.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Add contour milling", exact: true }).click();
  await properties.getByRole("button", { name: /^(Pick|Replace) Sketch$/ }).click();
  await page.getByRole("navigation", { name: "Design browser" })
    .getByRole("button", { name: "Finishing contour", exact: true }).click();
  const contour = properties.getByRole("region", { name: "Contour milling" });
  const generate = contour.getByRole("button", { name: "Generate toolpath", exact: true });
  const side = contour.getByLabel("Machining side");
  const direction = contour.getByLabel("Travel direction");
  const millingDirection = contour.getByLabel("Milling direction");
  const waitForCamBuild = () => page.waitForFunction(() => {
    const { builtDoc, doc } = window.whittle.useApp.getState();
    return builtDoc === doc;
  });
  async function setAptFeeds() {
    await properties.getByLabel("Cut feed (mm/min)").fill("250");
    await properties.getByLabel("Plunge feed (mm/min)").fill("60");
    await waitForCamBuild();
  }
  async function checkApt(region, hasArcs = false) {
    await setAptFeeds();
    await region.getByRole("button", { name: "Generate toolpath", exact: true }).click();
    await region.getByLabel("Playback timeline").waitFor();
    const expected = await page.evaluate(() => {
      const { path } = window.whittle.useApp.getState().camContourPlayback;
      return { point: path.pointAt(0), axis: path.toolFrame.z };
    });
    const download = page.waitForEvent("download", { timeout: 10000 });
    await properties.getByRole("button", { name: "Export APT-CL", exact: true }).click();
    const apt = await readFile(await (await download).path(), "utf8");
    const from = apt.match(/^FROM\/(.*)$/m)[1].split(",").map(Number);
    assert.equal(from.length, 6);
    [...expected.point, ...expected.axis].forEach((value, i) => assert.ok(Math.abs(from[i] - value) < 1e-8));
    assert.equal(/^CIRCLE\//m.test(apt), hasArcs);
    assert.match(apt, /^FINI$/m);
    return apt;
  }

  await generate.click();
  await contour.getByRole("alert").getByText(/Assign a tool position/).waitFor();
  await properties.getByLabel("Tool position", { exact: true }).selectOption(tool.id);
  await contour.getByLabel("Depth (mm)").fill("1.25");
  await checkApt(contour, true);
  // Drag the seam through a quarter turn. The live marker moves before the operation is saved.
  await page.evaluate(() => window.whittle.viewportRef.current.viewTo("top"));
  await page.waitForFunction(() => {
    const vp = window.whittle.viewportRef.current;
    return !vp.anim && vp.camHandles.length === 1;
  });
  const seamDrag = await page.evaluate(() => {
    const { viewportRef, useApp } = window.whittle;
    const vp = viewportRef.current;
    const { centerline, contourHandles } = useApp.getState().camContourPlayback.path;
    const marker = contourHandles[0];
    const target = centerline[Math.round((centerline.length - 1) / 4)];
    const canvas = vp.renderer.domElement.getBoundingClientRect();
    const toClient = (point) => {
      const [x, y] = vp.worldToScreen(point);
      return [canvas.left + x * canvas.width / vp.size.x, canvas.top + y * canvas.height / vp.size.y];
    };
    return [toClient(marker.position), toClient(target)];
  });
  const seamField = contour.getByLabel("Closed contour seam (0–1)");
  await page.mouse.move(...seamDrag[0]);
  await page.mouse.down();
  await page.mouse.move(...seamDrag[1], { steps: 8 });
  await page.waitForFunction(() => window.whittle.viewportRef.current.camDrag?.value > 0.2);
  assert.equal(await seamField.inputValue(), "0");
  await page.mouse.up();
  await waitForCamBuild();
  assert.ok(Math.abs(Number(await seamField.inputValue()) - 0.25) < 0.015);
  await checkApt(contour, true);
  await seamField.fill("0.625");
  await waitForCamBuild();
  assert.equal(await seamField.inputValue(), "0.625");
  await contour.getByRole("button", { name: "Reset entry and exit" }).click();
  await waitForCamBuild();
  assert.equal(await seamField.inputValue(), "0");

  const preview = () => page.evaluate(() => {
    const { path } = window.whittle.useApp.getState().camContourPlayback;
    return { start: path.centerline[0], next: path.centerline[1], programmed: path.programmed[0] };
  });
  assert.equal(await millingDirection.inputValue(), "climb");
  await millingDirection.selectOption("manual");
  for (const [travel, machiningSide, x, yDirection] of [
    ["forward", "center", 10, 1], ["forward", "left", 9.5, 1],
    ["forward", "right", 10.5, 1], ["reverse", "right", 9.5, -1],
  ]) {
    await direction.selectOption(travel);
    await side.selectOption(machiningSide);
    await waitForCamBuild();
    await generate.click();
    await contour.getByLabel("Playback timeline").waitFor();
    const { start, next, programmed } = await preview();
    assert.ok(Math.abs(start[0] - x) < 1e-6, "Offset uses the Ø1 cutter and ignores the Ø6 shank");
    assert.ok(Math.abs(start[1] - 3) < 1e-6);
    assert.equal(start[2], 8.75);
    assert.equal(programmed[2], 10);
    assert.equal(Math.sign(next[1] - start[1]), yDirection);
  }
  await contour.getByLabel("Maximum stepdown (mm)").fill("0.5");
  // Use an outside cut so the tangent leads stay clear of the programmed circle.
  await side.selectOption("left");
  await contour.getByLabel("Tangent lead-in (mm)").fill("1");
  await contour.getByLabel("Tangent lead-out (mm)").fill("0.75");
  await waitForCamBuild();
  await generate.click();
  await contour.getByLabel("Playback timeline").waitFor();
  const composedLeadFields = [
    ["Tangent arc lead-in (°)", "90"], ["Lead-in arc radius (mm)", "1.5"], ["Normal lead-in (mm)", "1"],
    ["Tangent arc lead-out (°)", "90"], ["Lead-out arc radius (mm)", "2"], ["Normal lead-out (mm)", "1"],
  ];
  for (const [label, value] of composedLeadFields) {
    await contour.getByLabel(label).fill(value);
    await waitForCamBuild();
  }
  const cutcom = contour.getByLabel("Export CUTCOM (machine R=0)");
  await cutcom.check();
  await waitForCamBuild();
  const cutcomApt = await checkApt(contour, true);
  assert.deepEqual(cutcomApt.match(/^CUTCOM\/.*$/gm), [
    "CUTCOM/LEFT", "CUTCOM/OFF", "CUTCOM/LEFT", "CUTCOM/OFF", "CUTCOM/LEFT", "CUTCOM/OFF",
  ]);
  await millingDirection.selectOption("conventional");
  await waitForCamBuild();
  assert.equal(await direction.count(), 0);
  const conventionalApt = await checkApt(contour, true);
  assert.deepEqual(conventionalApt.match(/^CUTCOM\/.*$/gm), [
    "CUTCOM/RIGHT", "CUTCOM/OFF", "CUTCOM/RIGHT", "CUTCOM/OFF", "CUTCOM/RIGHT", "CUTCOM/OFF",
  ]);
  await contour.getByLabel("Spindle rotation (viewed toward the work)").selectOption("ccw");
  await waitForCamBuild();
  const counterclockwiseApt = await checkApt(contour, true);
  assert.deepEqual(counterclockwiseApt.match(/^CUTCOM\/.*$/gm), cutcomApt.match(/^CUTCOM\/.*$/gm));
  const stockAllowance = contour.getByLabel("Starting radial stock allowance (mm)");
  const radialIncrement = contour.getByLabel("Radial pass increment (mm)");
  const finishAllowance = contour.getByLabel("Finish radial stock allowance (mm)");
  for (const [field, value] of [[stockAllowance, "1.15"], [radialIncrement, "0.5"], [finishAllowance, "0.15"]]) {
    await field.fill(value);
    await waitForCamBuild();
  }
  const radialApt = await checkApt(contour, true);
  assert.equal(radialApt.match(/^CUTCOM\/LEFT$/gm).length, 9);
  assert.equal(radialApt.match(/^CUTCOM\/OFF$/gm).length, 9);
  const straightLeadFields = [
    ["Tangent arc lead-in (°)", "90"], ["Tangent arc lead-out (°)", "90"],
    ["Tangent lead-in (mm)", "1"], ["Tangent lead-out (mm)", "0.75"],
  ];
  for (const [label] of straightLeadFields) {
    await contour.getByLabel(label).fill("0");
    await waitForCamBuild();
  }
  const optimiseRetracts = contour.getByLabel("Optimise retracts");
  await optimiseRetracts.check();
  await waitForCamBuild();
  const linkedApt = await checkApt(contour, true);
  await contour.getByRole("status").getByText("6 same-depth feed links.").waitFor();
  assert.equal(linkedApt.match(/^CUTCOM\/OFF$/gm).length, 9);
  assert.equal(linkedApt.match(/^CUTCOM\/LEFT$/gm).length, 9);
  await optimiseRetracts.uncheck();
  await waitForCamBuild();
  for (const [label, value] of straightLeadFields) {
    await contour.getByLabel(label).fill(value);
    await waitForCamBuild();
  }
  for (const field of [finishAllowance, radialIncrement, stockAllowance]) {
    await field.fill("0");
    await waitForCamBuild();
  }
  await millingDirection.selectOption("manual");
  await cutcom.uncheck();
  await waitForCamBuild();
  await generate.click();
  await contour.getByLabel("Playback timeline").waitFor();
  const leadArcs = await page.evaluate(() => {
    const { path } = window.whittle.useApp.getState().camContourPlayback;
    return path.motions.filter((motion) => motion.kind === "arc")
      .map(({ start, center }) => Math.hypot(...start.map((v, i) => v - center[i])));
  });
  assert.ok(Math.abs(leadArcs[0] - 1.5) < 1e-8);
  assert.ok(Math.abs(leadArcs.at(-1) - 2) < 1e-8);
  for (const [label] of composedLeadFields.filter(([label]) => !label.includes("radius"))) {
    await contour.getByLabel(label).fill("0");
    await waitForCamBuild();
  }
  await generate.click();
  await contour.getByLabel("Playback timeline").waitFor();
  const passes = await page.evaluate(() => {
    const { path } = window.whittle.useApp.getState().camContourPlayback;
    return { depths: path.cuttingPasses.map((pass) => pass[0][2]), links: path.linkingMoves };
  });
  assert.deepEqual(passes.depths, [9.5, 9, 8.75]);
  assert.equal(passes.links.length, 8);
  for (const [start, end] of passes.links.filter(([a, b]) => a[0] !== b[0] || a[1] !== b[1])) {
    assert.equal(start[2], 12);
    assert.equal(end[2], 12);
  }
  const snapshot = () => page.evaluate(() => {
    const vp = window.whittle.viewportRef.current;
    const state = window.whittle.useApp.getState();
    const playback = state.camContourPlayback;
    vp.camToolGroup.updateMatrix();
    const tipWorld = vp.camToolGroup.position.clone().set(...playback.tip.origin).applyMatrix4(vp.camToolGroup.matrix);
    return {
      meshes: vp.camToolGroup.children.filter((object) => object.userData.bodyId).map((object) => object.userData.bodyId),
      toolHasEdges: vp.camToolGroup.children.some((object) => object.isLineSegments2),
      paths: vp.camPathGroup.children.length,
      pathOrders: vp.camPathGroup.children.map(({ renderOrder }) => renderOrder),
      depthTested: vp.camPathGroup.children.every(({ material }) => material.depthTest && !material.depthWrite),
      tipError: tipWorld.distanceTo(vp.camToolGroup.position.clone().set(...playback.path.pointAt(state.camContourProgress))),
      progress: state.camContourProgress,
    };
  });
  const displayed = await snapshot();
  assert.deepEqual(displayed.meshes.sort(), tool.components.map(({ bodyId }) => bodyId).sort());
  assert.equal(displayed.toolHasEdges, false);
  assert.equal(displayed.paths, 3);
  assert.equal(displayed.depthTested, true);
  assert.deepEqual(displayed.pathOrders, [20, 21, 22]);
  assert.ok(displayed.tipError < 1e-6);
  await contour.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(() => window.whittle.useApp.getState().camContourProgress > 0.02);
  await contour.getByRole("button", { name: "Pause", exact: true }).click();
  assert.ok((await snapshot()).tipError < 1e-6);
  await contour.getByLabel("Playback timeline").press("End");
  assert.equal((await snapshot()).progress, 1);
  await contour.getByLabel("Show tool centerline").uncheck();
  assert.deepEqual((await snapshot()).pathOrders, [20, 22]);
  assert.equal((await snapshot()).progress, 1);
  await contour.getByLabel("Show tool centerline").check();
  assert.deepEqual((await snapshot()).pathOrders, [20, 21, 22]);
  await contour.getByRole("button", { name: "Reset", exact: true }).click();
  assert.equal((await snapshot()).progress, 0);
  await contour.getByLabel("Show tool assembly").uncheck();
  assert.equal((await snapshot()).meshes.length, 0);
  await contour.getByLabel("Show tool assembly").check();
  assert.equal((await snapshot()).meshes.length, 2);
  console.log("ok  Native contour selection, signed Ø1 compensation, multipass leads and clearance links, complete TIP playback");

  await page.getByRole("button", { name: "Add pocket milling", exact: true }).click();
  await properties.getByRole("button", { name: /^(Pick|Replace) Sketch$/ }).click();
  await page.getByRole("navigation", { name: "Design browser" })
    .getByRole("button", { name: "Finishing contour", exact: true }).click();
  const pocket = properties.getByRole("region", { name: "Pocket milling" });
  const pocketGenerate = pocket.getByRole("button", { name: "Generate toolpath", exact: true });
  await properties.getByLabel("Tool position", { exact: true }).selectOption(tool.id);
  await pocket.getByLabel("Depth (mm)").fill("1.25");
  await pocket.getByLabel("Maximum stepdown (mm)").fill("0.5");
  await pocket.getByLabel("Stepover (% of cutter diameter)").fill("40");
  await waitForCamBuild();
  await pocketGenerate.click();
  await pocket.getByLabel("Playback timeline").waitFor();
  await checkApt(pocket, true);
  const pocketPath = await page.evaluate(() => {
    const { path } = window.whittle.useApp.getState().camContourPlayback;
    return { depths: path.cuttingPasses.map((pass) => pass[0][2]), boundary: path.centerline[0], motions: path.motions.length };
  });
  assert.deepEqual(pocketPath.depths, [9.5, 9, 8.75]);
  assert.deepEqual(pocketPath.boundary, [9.5, 3, 8.75]);
  assert.ok(pocketPath.motions > 100);
  await pocket.getByLabel("Playback timeline").press("End");
  assert.ok((await snapshot()).tipError < 1e-6);

  await properties.getByRole("button", { name: "Add Island Sketch", exact: true }).click();
  await page.getByRole("navigation", { name: "Design browser" })
    .getByRole("button", { name: "Island sketch", exact: true }).click();
  await waitForCamBuild();
  await pocketGenerate.click();
  await pocket.getByLabel("Playback timeline").waitFor();
  const islandPath = await page.evaluate(() => {
    const { path } = window.whittle.useApp.getState().camContourPlayback;
    const moves = path.cuttingPasses.flat();
    return {
      boundaries: path.programmedPaths.length,
      depths: [...new Set(moves.map((p) => p[2]))],
      minRadius: moves.reduce((min, [x, y]) => Math.min(min, Math.hypot(x - 2, y - 3)), Infinity),
      lateralAtClearance: path.linkingMoves.every(([a, b]) => (a[0] === b[0] && a[1] === b[1]) || (a[2] === 12 && b[2] === 12)),
    };
  });
  assert.equal(islandPath.boundaries, 2);
  assert.deepEqual(islandPath.depths, [9.5, 9, 8.75]);
  assert.ok(islandPath.minRadius >= 2.5 - 1e-8 && islandPath.minRadius < 2.51);
  assert.ok(islandPath.lateralAtClearance);
  await pocket.getByLabel("Playback timeline").press("End");
  assert.ok((await snapshot()).tipError < 1e-6);

  await page.getByRole("button", { name: "Add adaptive clearing", exact: true }).click();
  await properties.getByRole("button", { name: /^(Pick|Replace) Sketch$/ }).click();
  await page.getByRole("navigation", { name: "Design browser" })
    .getByRole("button", { name: "Finishing contour", exact: true }).click();
  const adaptive = properties.getByRole("region", { name: "Adaptive clearing" });
  await properties.getByLabel("Tool position", { exact: true }).selectOption(tool.id);
  await adaptive.getByLabel("Depth (mm)").fill("1");
  await adaptive.getByLabel("Maximum stepdown (mm)").fill("0.5");
  const engagement = adaptive.getByLabel("Target radial engagement (% of cutter diameter)");
  await engagement.fill("30");
  await waitForCamBuild();
  const adaptiveGenerate = adaptive.getByRole("button", { name: "Generate toolpath", exact: true });
  await adaptiveGenerate.click();
  await adaptive.getByLabel("Playback timeline").waitFor();
  await checkApt(adaptive, true);
  const adaptivePath = await page.evaluate(() => {
    const { path } = window.whittle.useApp.getState().camContourPlayback;
    return { depths: path.cuttingPasses.map((pass) => pass[0][2]), boundary: path.centerline[0],
      arcs: path.motions.filter((motion) => motion.kind === "arc").length };
  });
  assert.deepEqual(adaptivePath.depths, [9.5, 9]);
  assert.deepEqual(adaptivePath.boundary, [9.5, 3, 9]);
  assert.ok(adaptivePath.arcs > 40);
  await adaptive.getByLabel("Playback timeline").press("End");
  assert.ok((await snapshot()).tipError < 1e-6);

  await properties.getByRole("button", { name: "Add Island Sketch", exact: true }).click();
  await page.getByRole("navigation", { name: "Design browser" })
    .getByRole("button", { name: "Island sketch", exact: true }).click();
  await adaptive.getByLabel("Entry", { exact: true }).selectOption("helix");
  await adaptive.getByLabel("Stock-aware linking").check();
  await adaptive.getByLabel("Helix orbit diameter (mm)").fill("0.5");
  await adaptive.getByLabel("Maximum ramp angle (°)").fill("5");
  await waitForCamBuild();
  await adaptiveGenerate.click();
  await adaptive.getByLabel("Playback timeline").waitFor();
  await adaptive.getByText(/cuts? per depth may exceed target engagement/).waitFor();
  const adaptiveIsland = await page.evaluate(() => {
    const { path } = window.whittle.useApp.getState().camContourPlayback;
    return {
      boundaries: path.programmedPaths.length,
      stayDown: path.stayDownLinkCount > 0 && path.stayDownCutLinkCount > 0,
      depths: [...new Set(path.cuttingPasses.map((pass) => pass[0][2]))],
      avoidsIsland: [...path.cuttingPasses, ...path.entryPaths].flat().every(([x, y]) => Math.hypot(x - 2, y - 3) >= 2.5 - 1e-8),
      helical: path.entryPaths.length + path.stayDownLinkCount === path.cuttingPasses.length && path.motions.some((move) => move.helical && move.start[2] > move.end[2]),
      lateralAtClearance: path.motions.every((move) => move.kind !== "line" || move.mode !== "rapid"
        || (move.start[0] === move.end[0] && move.start[1] === move.end[1])
        || (move.start[2] === 12 && move.end[2] === 12)),
    };
  });
  assert.deepEqual(adaptiveIsland, { boundaries: 2, stayDown: true, depths: [9.5, 9], avoidsIsland: true, helical: true, lateralAtClearance: true });

  await page.getByRole("button", { name: "Add pocket milling", exact: true }).click();
  const edgePocket = properties.getByRole("region", { name: "Pocket milling" });
  const model = await page.evaluate(() => {
    const { useApp } = window.whittle;
    const body = useApp.getState().regen.bodies.find((item) => item.bbox[1][0] - item.bbox[0][0] > 30);
    const planes = body.faces.map((face, index) => ({ face, index })).filter(({ face }) =>
      face.surface === "PLANE" && Math.abs(face.normal[2]) > 0.999).sort((a, b) => b.face.center[2] - a.face.center[2]);
    const top = planes[0], bottom = planes.at(-1);
    const edgeIndices = body.faceEdges[top.index];
    const isClosed = (edge) => edge.curve === "CIRCLE" && edge.ends?.[0].every((v, i) => Math.abs(v - edge.ends[1][i]) < 1e-6);
    return { bodyId: body.id, outer: edgeIndices.filter((index) => !isClosed(body.edges[index])),
      inner: edgeIndices.filter((index) => isClosed(body.edges[index])),
      floor: bottom.index, z: bottom.face.center[2], top: top.face.center[2] };
  });
  assert.ok(model.outer.length >= 4 && model.inner.length >= 1 && model.top > model.z);
  const selectModel = (kind, indices) => page.evaluate(({ kind, indices, bodyId }) => {
    window.whittle.useApp.setState({ selection: indices.map((index) => ({ kind, bodyId, index })) });
  }, { kind, indices, bodyId: model.bodyId });
  await properties.getByLabel("Tool position", { exact: true }).selectOption(tool.id);
  await waitForCamBuild();
  await selectModel("edge", model.outer.slice(0, 2));
  await edgePocket.getByRole("button", { name: "Add selected boundary edges" }).click();
  await waitForCamBuild();
  await selectModel("edge", model.outer.slice(2));
  await edgePocket.getByRole("button", { name: "Add selected boundary edges" }).click();
  await waitForCamBuild();
  await selectModel("edge", model.inner);
  await edgePocket.getByRole("button", { name: "Add selected island edges" }).click();
  await waitForCamBuild();
  await selectModel("face", [model.floor]);
  await edgePocket.getByRole("button", { name: "Use selected face as floor" }).click();
  await waitForCamBuild();
  assert.ok(Math.abs(Number(await edgePocket.getByLabel("Depth (mm)").inputValue()) - (model.top - model.z)) < 1e-6);
  await edgePocket.getByRole("button", { name: "Generate toolpath" }).click();
  assert.equal(await edgePocket.getByRole("alert").count(), 0, (await edgePocket.getByRole("alert").allTextContents()).join("\n"));
  await setAptFeeds();
  await edgePocket.getByRole("button", { name: "Generate toolpath" }).click();
  await edgePocket.getByLabel("Playback timeline").waitFor();
  const edgePath = await page.evaluate(() => {
    const { path } = window.whittle.useApp.getState().camContourPlayback;
    return { loops: path.programmedPaths.length, z: path.centerline[0][2] };
  });
  assert.ok(edgePath.loops >= model.inner.length + 1);
  assert.ok(Math.abs(edgePath.z - model.z) < 1e-6);
  console.log("ok  Accumulated model boundary and island edges, and selected floor depth");

  await page.evaluate(() => window.whittle.api.run("add_sketch", {
    name: "Side contour", plane: "YZ", offset: 10,
    shapes: [{ type: "circle", x: 4, y: 6, radius: 3 }],
  }));
  await manufacturing.click();
  await page.getByRole("button", { name: "Add contour milling", exact: true }).click();
  await properties.getByRole("button", { name: /^(Pick|Replace) Sketch$/ }).click();
  await page.getByRole("navigation", { name: "Design browser" })
    .getByRole("button", { name: "Side contour", exact: true }).click();
  const orientation = properties.getByLabel("Machining orientation");
  const flipTool = properties.getByLabel("Flip tool direction");
  await properties.getByLabel("Tool position", { exact: true }).selectOption(tool.id);
  await contour.getByLabel("Depth (mm)").fill("1");
  await waitForCamBuild();
  await generate.click();
  await contour.getByRole("alert").getByText(/perpendicular to the operation tool axis/).waitFor();
  const sideFace = await page.evaluate((bodyId) => {
    const { regen } = window.whittle.useApp.getState();
    const faces = regen.bodies.find(({ id }) => id === bodyId).faces;
    const index = faces.findIndex(({ surface, normal }) => surface === "PLANE" && Math.abs(normal[0]) > 0.999);
    return { index, sign: Math.sign(faces[index].normal[0]), center: faces[index].center };
  }, model.bodyId);
  await page.evaluate((sign) => {
    const { useApp, viewportRef } = window.whittle;
    useApp.setState({ selection: [], pickPriority: "body" });
    viewportRef.current.viewTo(sign > 0 ? "right" : "left");
  }, sideFace.sign);
  await page.waitForFunction(() => !window.whittle.viewportRef.current.anim);

  await orientation.selectOption("pick-face");
  await properties.getByRole("status").getByText("Click a flat workpiece face in the 3D view.").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await orientation.inputValue(), "setup");
  await orientation.selectOption("pick-face");
  await page.waitForFunction(() => window.whittle.viewportRef.current.filter.faces);
  const xy = await page.evaluate((world) => {
    const vp = window.whittle.viewportRef.current;
    const [x, y] = vp.worldToScreen(world);
    const bounds = document.querySelector(".viewport canvas").getBoundingClientRect();
    return [bounds.left + x * bounds.width / vp.size.x, bounds.top + y * bounds.height / vp.size.y];
  }, sideFace.center);
  await page.mouse.click(...xy);
  await page.waitForFunction(() => document.querySelector("#cam-orientation").value === "face");
  assert.equal(await page.evaluate(() => window.whittle.useApp.getState().pickPriority), "body");
  await page.evaluate(() => window.whittle.useApp.setState({ pickPriority: "all" }));
  await waitForCamBuild();

  async function checkSidePath(sign) {
    await generate.click();
    await contour.getByLabel("Playback timeline").waitFor();
    const actual = await page.evaluate(() => {
      const vp = window.whittle.viewportRef.current;
      const { camContourPlayback, camContourProgress } = window.whittle.useApp.getState();
      const { path, tip } = camContourPlayback;
      vp.camToolGroup.updateMatrix();
      const worldTip = vp.camToolGroup.position.clone().set(...tip.origin).applyMatrix4(vp.camToolGroup.matrix);
      const worldAxis = worldTip.clone().set(...tip.z).transformDirection(vp.camToolGroup.matrix);
      return {
        axis: worldAxis.toArray(), ijk: path.motions[0].toolAxis, start: path.pointAt(0),
        boundary: path.programmed[0][0], depth: path.centerline[0][0],
        tipError: worldTip.distanceTo(worldTip.clone().set(...path.pointAt(camContourProgress))),
        components: vp.camToolGroup.children.length,
      };
    });
    for (const vector of [actual.axis, actual.ijk]) {
      assert.ok(Math.hypot(vector[0] - sign, vector[1], vector[2]) < 1e-6);
    }
    assert.ok(Math.abs(actual.start[0] - actual.boundary - 2 * sign) < 1e-6);
    assert.ok(Math.abs(actual.depth - actual.boundary + sign) < 1e-6);
    assert.ok(actual.tipError < 1e-6);
    assert.equal(actual.components, 2);
  }

  await checkSidePath(sideFace.sign);
  await flipTool.check();
  await waitForCamBuild();
  await checkSidePath(-sideFace.sign);
  await checkApt(contour, true);
  console.log("ok  Side face machining, reversed IJK and physical TIP alignment");

  await page.getByRole("button", { name: "Add facing milling", exact: true }).click();
  const facing = properties.getByRole("region", { name: "Facing milling" });
  await properties.getByRole("button", { name: "Pick Facing Face", exact: true }).click();
  await page.waitForFunction(() => window.whittle.viewportRef.current.filter.faces);
  await page.mouse.click(...xy);
  await properties.getByText("Selected planar face", { exact: true }).waitFor();
  await waitForCamBuild();
  await orientation.selectOption("pick-face");
  await page.waitForFunction(() => window.whittle.viewportRef.current.filter.faces);
  await page.mouse.click(...xy);
  await page.waitForFunction(() => document.querySelector("#cam-orientation").value === "face");
  await properties.getByLabel("Tool position", { exact: true }).selectOption(tool.id);
  await facing.getByLabel("Raster strategy").selectOption("one-way");
  await facing.getByLabel("Top height (mm)").fill("1");
  await facing.getByLabel("Final height (mm)").fill("0");
  await facing.getByLabel("Maximum stepdown (mm)").fill("0.5");
  await facing.getByLabel("Stepover (% of cutter diameter)").fill("75");
  await waitForCamBuild();

  async function checkFacingPath() {
    await facing.getByRole("button", { name: "Generate toolpath" }).click();
    assert.equal(await facing.getByRole("alert").count(), 0, (await facing.getByRole("alert").allTextContents()).join("\n"));
    await facing.getByLabel("Playback timeline").waitFor();
    const actual = await page.evaluate(() => {
      const { viewportRef, useApp } = window.whittle;
      const { path, tip } = useApp.getState().camContourPlayback;
      const group = viewportRef.current.camToolGroup;
      group.updateMatrix();
      const worldTip = group.position.clone().set(...tip.origin).applyMatrix4(group.matrix);
      const error = worldTip.distanceTo(worldTip.clone().set(...path.pointAt(0)));
      const axis = path.motions[0].toolAxis;
      const depths = [...new Set(path.motions.filter((motion) => motion.mode === "feed").map((motion) =>
        Math.round((motion.start[0] - path.programmed[0][0]) * axis[0] * 1000) / 1000))];
      return { axis, depths, error, meshes: group.children.length, passes: path.cuttingPasses.length };
    });
    assert.ok(Math.hypot(actual.axis[0] - sideFace.sign, actual.axis[1], actual.axis[2]) < 1e-6);
    assert.deepEqual(actual.depths, [0.5, 0]);
    assert.ok(actual.error < 1e-6);
    assert.equal(actual.meshes, 2);
    assert.ok(actual.passes > 2);
  }

  await checkFacingPath();
  await checkApt(facing);
  await facing.getByRole("button", { name: "Play", exact: true }).click();
  await facing.getByRole("button", { name: "Pause", exact: true }).click();

  await page.getByRole("button", { name: "Timeline setup", exact: true }).click();
  await page.getByRole("listbox", { name: "Timeline setup" }).getByRole("option", { selected: true }).click();
  const [setupDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 10000 }),
    properties.getByRole("button", { name: "Export setup APT-CL", exact: true }).click(),
  ]).catch(async (error) => {
    throw new Error(`Setup export failed. ${await properties.getByRole("alert").allTextContents()}`, { cause: error });
  });
  const setupApt = await readFile(await setupDownload.path(), "utf8");
  assert.deepEqual([...setupApt.matchAll(/^\$\$ OPERATION (.+)$/gm)].map((match) => match[1]),
    ["Contour 1", "Pocket 2", "Adaptive 3", "Pocket 4", "Contour 5", "Facing 6"]);
  assert.equal([...setupApt.matchAll(/^FROM\//gm)].length, 6);
  assert.equal([...setupApt.matchAll(/^FINI$/gm)].length, 1);


  await page.getByRole("button", { name: "Save CAM", exact: true }).click();
  await page.waitForFunction(() => !window.whittle.useApp.getState().dirty);
  assert.deepEqual(await page.evaluate(async (name) => Array.from(new Uint8Array(await window.camTestFiles.files.get(name).arrayBuffer())), name), source);
  assert.deepEqual(await page.evaluate(() => window.camTestFiles.writes), [name, "manufacturing-regression.cam"]);
  await page.getByRole("button", { name: "New CAM Document" }).click();
  await page.waitForFunction(() => {
    const { doc } = window.whittle.useApp.getState();
    return !!doc.manufacturing && doc.features.length === 0;
  });
  await page.getByRole("button", { name: "Open CAM", exact: true }).click();
  await page.waitForFunction(() => window.whittle.useApp.getState().fileName === "manufacturing-regression.cam");
  await awaitTool(2);
  await checkVisibility(beforeIsolation);
  assert.equal(await restore.count(), 0);
  assert.equal((await toolModel()).id, tool.id);
  assert.equal(await page.evaluate((id) => window.whittle.useApp.getState().doc.bodies[id].visible, holderId), false);
  assert.equal(await page.evaluate((id) => window.whittle.useApp.getState().regen.planes.find((frame) => frame.id === id)?.origin[0], tool.tipCsysId), 25);
  assert.deepEqual((await toolModel()).components, tool.components);
  await manufacturing.click();
  await page.getByRole("button", { name: "Facing 6 · Main machining", exact: true }).click();
  assert.equal(await facing.getByLabel("Raster strategy").inputValue(), "one-way");
  assert.equal(await properties.getByLabel("Cut feed (mm/min)").inputValue(), "250");
  assert.equal(await facing.getByLabel("Top height (mm)").inputValue(), "1");
  assert.equal(await facing.getByLabel("Stepover (% of cutter diameter)").inputValue(), "75");
  await checkFacingPath();
  console.log("ok  Facing side face selection, one-way raster, multibody TIP and CAM round trip");
  await page.getByRole("button", { name: "Contour 5 · Main machining", exact: true }).click();
  assert.equal(await orientation.inputValue(), "face");
  assert.equal(await flipTool.isChecked(), true);
  await checkSidePath(-sideFace.sign);
  await page.getByRole("button", { name: "Contour 1 · Main machining", exact: true }).click();
  assert.equal(await side.inputValue(), "left");
  assert.equal(await direction.inputValue(), "reverse");
  assert.equal(await contour.getByLabel("Depth (mm)").inputValue(), "1.25");
  assert.equal(await contour.getByLabel("Maximum stepdown (mm)").inputValue(), "0.5");
  assert.equal(await contour.getByLabel("Tangent lead-in (mm)").inputValue(), "1");
  assert.equal(await contour.getByLabel("Tangent lead-out (mm)").inputValue(), "0.75");
  assert.equal(await properties.getByLabel("Tool position", { exact: true }).inputValue(), tool.id);
  assert.equal(await contour.getByLabel("Playback timeline").count(), 0);
  await generate.click();
  await contour.getByLabel("Playback timeline").waitFor();
  assert.equal((await snapshot()).meshes.length, 2);
  await page.getByRole("button", { name: "Pocket 2 · Main machining", exact: true }).click();
  assert.equal(await pocket.getByLabel("Stepover (% of cutter diameter)").inputValue(), "40");
  assert.equal(await pocket.getByLabel("Maximum stepdown (mm)").inputValue(), "0.5");
  await pocketGenerate.click();
  await pocket.getByLabel("Playback timeline").waitFor();
  assert.equal((await snapshot()).meshes.length, 2);
  assert.equal(await page.evaluate(() => window.whittle.useApp.getState().camContourPlayback.path.programmedPaths.length), 2);
  console.log("ok  Pocket and island sketch, Ø1 tool envelope, depth passes, TIP playback and CAM round trip");
  await page.getByRole("button", { name: "Adaptive 3 · Main machining", exact: true }).click();
  assert.equal(await engagement.inputValue(), "30");
  assert.equal(await adaptive.getByLabel("Entry", { exact: true }).inputValue(), "helix");
  assert.equal(await adaptive.getByLabel("Stock-aware linking").isChecked(), true);
  assert.equal(await adaptive.getByLabel("Helix orbit diameter (mm)").inputValue(), "0.5");
  assert.equal(await adaptive.getByLabel("Maximum ramp angle (°)").inputValue(), "5");
  await adaptiveGenerate.click();
  await adaptive.getByLabel("Playback timeline").waitFor();
  assert.equal((await snapshot()).meshes.length, 2);
  assert.equal(await page.evaluate(() => window.whittle.useApp.getState().camContourPlayback.path.programmedPaths.length), 2);
  console.log("ok  Circular and island adaptive clearing, fitted helical entry, stock-aware links, TIP playback and CAM round trip");
  await page.getByRole("button", { name: "Pocket 4 · Main machining", exact: true }).click();
  await edgePocket.getByText(`${model.outer.length} boundary edges · ${model.inner.length} island edges`).waitFor();
  assert.ok(Math.abs(Number(await edgePocket.getByLabel("Depth (mm)").inputValue()) - (model.top - model.z)) < 1e-6);
  await toolsTab.click();
  await position.click();
  await components.last().click();
  assert.equal(await properties.getByLabel("Role", { exact: true }).inputValue(), "holder");
  assert.equal(await properties.getByLabel("Visible", { exact: true }).isChecked(), false);
  await properties.getByRole("button", { name: "Remove", exact: true }).click();
  await awaitTool(1);
  await browserTabs.getByRole("button", { name: "Browser", exact: true }).click();
  assert.equal(await positions.count(), 0);
  await toolsTab.click();
  await position.click();
  await properties.getByRole("button", { name: "Delete Tool", exact: true }).click();
  await page.waitForFunction(({ bodyIds, tipId }) => {
    const { doc, builtDoc, regen } = window.whittle.useApp.getState();
    return doc === builtDoc && doc.manufacturing.toolPositions.length === 0
      && !regen.planes.some(({ id }) => id === tipId)
      && !regen.bodies.some(({ id }) => bodyIds.includes(id)) && regen.bodies.length > 0;
  }, { bodyIds: tool.components.map(({ bodyId }) => bodyId), tipId: tool.tipCsysId });
  console.log("ok  Tool positions, independent component copies, native TIP, inherited cutting parameters, whole-tool movement and CAM round trip");
} finally {
  await browser.close();
}
