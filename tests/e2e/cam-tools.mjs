import assert from "node:assert/strict";
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
  await commit(properties.getByLabel("Flat endmill diameter (mm)"), "6");
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
  assert.equal(tool.cutting.diameter, 6);

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
  const originX = tipPanel.getByLabel("Origin X", { exact: true });
  await originX.fill("5");
  await originX.press("Tab");
  await tipPanel.getByRole("button", { name: "OK", exact: true }).click();
  await position.click();
  await properties.getByText("Move tool", { exact: true }).click();
  const positionX = properties.getByLabel("Tool position X", { exact: true });
  await positionX.fill("25");
  await positionX.press("Tab");
  await page.waitForFunction((id) => {
    const { doc, builtDoc, regen } = window.whittle.useApp.getState();
    return doc === builtDoc && regen?.planes.find((frame) => frame.id === id)?.origin[0] === 30;
  }, tool.tipCsysId);

  await manufacturing.click();
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
  assert.equal((await toolModel()).id, tool.id);
  assert.equal(await page.evaluate((id) => window.whittle.useApp.getState().doc.bodies[id].visible, holderId), false);
  assert.equal(await page.evaluate((id) => window.whittle.useApp.getState().regen.planes.find((frame) => frame.id === id)?.origin[0], tool.tipCsysId), 30);
  assert.equal((await toolModel()).cutting.diameter, 6);
  await manufacturing.click();
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
  console.log("ok  Tool positions, independent component copies, native TIP, whole-tool movement and CAM round trip");
} finally {
  await browser.close();
}
