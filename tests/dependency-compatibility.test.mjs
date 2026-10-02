import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import JSZip from "jszip";

test("ExcelJS extended conditional formatting keeps UUID generation and XLSX round trips", async () => {
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet("Synthetic");
  sheet.addRows([[10], [20], [30]]);
  sheet.addConditionalFormatting({
    ref: "A1:A3",
    rules: [
      {
        type: "iconSet",
        iconSet: "3Stars",
        cfvo: [
          { type: "percent", value: 0 },
          { type: "percent", value: 33 },
          { type: "percent", value: 67 },
        ],
      },
    ],
  });
  const bytes = await book.xlsx.writeBuffer(),
    zip = await JSZip.loadAsync(bytes);
  assert.match(
    await zip.file("xl/worksheets/sheet1.xml").async("string"),
    /id="\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}"/,
  );
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  assert.equal(restored.getWorksheet("Synthetic").getCell("A2").value, 20);
  assert.equal(
    restored.getWorksheet("Synthetic").conditionalFormattings[0].rules[0]
      .iconSet,
    "3Stars",
  );
});

test("Transformers image operations remain compatible with the patched native Sharp runtime", async () => {
  const { RawImage } = await import("@huggingface/transformers");
  const image = new RawImage(
    new Uint8ClampedArray([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]),
    2,
    2,
    3,
  );
  const resized = await image.resize(4, 4);
  assert.equal(resized.width, 4);
  assert.equal(resized.height, 4);
  assert.equal(resized.data.length, 48);
  assert.ok(resized.data.some((value) => value > 0));
});
