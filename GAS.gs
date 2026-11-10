const API_KEY = PropertiesService.getScriptProperties().getProperty("GAS_API_KEY");

function authorizeDriveAccess() {
  DriveApp.getRootFolder().getName();
}

function authorizeSpreadsheetAccess() {
  const sheetId = PropertiesService.getScriptProperties().getProperty("SHEET_500_ID");
  if (!sheetId) {
    throw new Error("請先從 Streamlit 呼叫一次產生流程，讓系統記錄試算表 ID。");
  }
  SpreadsheetApp.openById(sheetId).getName();
}

function doPost(e) {
  try {
    const contents = JSON.parse(e.postData.contents);
    
    // 驗證 API Key
    if (contents.apiKey !== API_KEY) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Unauthorized: Invalid API Key" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    const sheetId = contents.sheetId;
    const docTitle = contents.docTitle || "500元光明燈疏文";
    PropertiesService.getScriptProperties().setProperty("SHEET_500_ID", sheetId);
    
    // 執行疏文生成
    const files = generateWordDocument(sheetId, docTitle);
    
    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      wordUrl: files.wordUrl,
      wordDownloadUrl: files.wordDownloadUrl,
    }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function generateWordDocument(sheetId, docTitle) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName("500元光明燈");
  if (!sheet) throw new Error("找不到『500元光明燈』工作表");

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) throw new Error("試算表沒有可產生的資料");

  data.shift();
  if (sheet.getLastColumn() < 9) {
    throw new Error("『500元光明燈』工作表至少需要 A 至 I 欄");
  }

  const columns = {
    light1Number: 0, // A欄：光明燈1號碼
    light2Number: 1, // B欄：光明燈2號碼
    address: 2,      // C欄：住址
    gender: 3,       // D欄：信士女
    name: 4,         // E欄：姓名
    birthDate: 5,    // F欄：出生年月日
    birthTime: 6,    // G欄：生時
    light1Type: 7,   // H欄：光明燈1種類
    light2Type: 8,   // I欄：光明燈2種類
  };

  const timezone = ss.getSpreadsheetTimeZone();
  const groups = [];
  const groupsByAddress = new Map();
  data.forEach(row => {
    const address = normalizeAddress(getCellText(row[columns.address], timezone));
    const member = [
      getCellText(row[columns.light1Number], timezone),
      getCellText(row[columns.light2Number], timezone),
      getCellText(row[columns.gender], timezone),
      getCellText(row[columns.name], timezone),
      getCellText(row[columns.birthDate], timezone, "yyyy年MM月dd日"),
      getCellText(row[columns.birthTime], timezone, "HH:mm"),
      getCellText(row[columns.light1Type], timezone),
      getCellText(row[columns.light2Type], timezone),
    ];
    if (member.every(value => !value)) return;

    const addressKey = address || "未提供地址";
    let group = groupsByAddress.get(addressKey);
    if (!group) {
      group = { address: addressKey, members: [] };
      groupsByAddress.set(addressKey, group);
      groups.push(group);
    }
    group.members.push(member);
  });
  if (groups.length === 0) throw new Error("找不到可產生的光明燈資料");

  const wordFile = createA3PortraitWordFile(groups, docTitle);
  return {
    wordUrl: wordFile.getUrl(),
    wordDownloadUrl: `https://drive.google.com/uc?export=download&id=${wordFile.getId()}`,
  };
}

function buildWordDocumentXml(groups) {
  const pageCapacity = 1077.17;
  const contentWidth = 728.51;
  let usedHeight = 0;
  let breakBeforeNextGroup = false;
  const content = [];

  groups.forEach(group => {
    if (breakBeforeNextGroup) {
      content.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      usedHeight = 0;
      breakBeforeNextGroup = false;
    }

    group.fontSize = getAddressGroupFontSize(group, pageCapacity, contentWidth);
    const height = estimateAddressGroupHeight(group, group.fontSize, contentWidth);
    const groupGap = usedHeight > 0 ? 2.5 : 0;
    if (usedHeight > 0 && (height > pageCapacity || usedHeight + groupGap + height > pageCapacity)) {
      content.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      usedHeight = 0;
    } else if (groupGap > 0) {
      content.push(
        '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="50" w:lineRule="exact"/>' +
        '</w:pPr><w:r><w:rPr><w:sz w:val="2"/></w:rPr><w:t xml:space="preserve"> </w:t></w:r></w:p>'
      );
    }

    const memberWidths = Array(8).fill(Math.floor(14570 / 8));
    memberWidths[7] += 14570 - memberWidths.reduce((total, width) => total + width, 0);
    content.push(buildWordAddressGroupTable(group, memberWidths));

    if (height > pageCapacity) {
      breakBeforeNextGroup = true;
    } else {
      usedHeight += height + (usedHeight > 0 ? groupGap : 0);
    }
  });

  const section = [
    '<w:sectPr>',
    '<w:pgSz w:w="16838" w:h="23811"/>',
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="0" w:footer="0" w:gutter="0"/>',
    '</w:sectPr>',
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${content.join("")}${section}</w:body></w:document>`;
}

function getAddressGroupFontSize(group, pageCapacity, contentWidth) {
  // * 11092332 預設字體16 pt，資料欄相鄰間距 3 pt
  for (let fontSize = 16; fontSize >= 8; fontSize--) {
    if (estimateAddressGroupHeight(group, fontSize, contentWidth) <= pageCapacity) {
      return fontSize;
    }
  }
  return 8;
}

function estimateAddressGroupHeight(group, fontSize, contentWidth) {
  const addressLines = estimateWrappedLines(group.address, contentWidth, fontSize);
  const fieldWidth = contentWidth / 8;
  const rowsHeight = group.members.reduce((total, member, rowIndex) => {
    const lineCount = Math.max(...member.map((value, index) => {
      return index < 2 || index === 4 ? 1 : estimateWrappedLines(value, fieldWidth, fontSize);
    }));
    const topGap = rowIndex === 0 ? 0 : 2.5;
    const bottomGap = rowIndex === group.members.length - 1 ? 0 : 2.5;
    return total + lineCount * fontSize * 1.2 + topGap + bottomGap;
  }, 0);
  return addressLines * fontSize * 1.2 + 2.5 + rowsHeight;
}

function estimateWrappedLines(value, width, fontSize) {
  const textWidth = Array.from(value || "").reduce((total, character) => {
    return total + (/[^\u0000-\u00ff]/.test(character) ? fontSize : fontSize * 0.55);
  }, 0);
  return Math.max(1, Math.ceil(textWidth / width));
}

function normalizeAddress(address) {
  return String(address || "").replace(/[\s\u3000]+/g, "").trim();
}

// * 11100852 修正住址排和資料排間距
function buildWordAddressGroupTable(group, columnWidths) {
  const totalWidth = columnWidths.reduce((total, width) => total + width, 0);
  const borders = ["top", "left", "bottom", "right", "insideH", "insideV"]
    .map(edge => `<w:${edge} w:val="nil"/>`).join("");
  const grid = columnWidths.map(width => `<w:gridCol w:w="${width}"/>`).join("");
  const addressCell =
    `<w:tc><w:tcPr><w:tcW w:w="${totalWidth}" w:type="dxa"/>` +
    `<w:gridSpan w:val="${columnWidths.length}"/>` +
    '<w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="30" w:type="dxa"/>' +
    '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="30" w:type="dxa"/></w:tcMar>' +
    '<w:textDirection w:val="btLr"/><w:vAlign w:val="center"/></w:tcPr>' +
    '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>' +
    `<w:r><w:rPr><w:b/><w:sz w:val="${group.fontSize * 2}"/>` +
    `</w:rPr><w:t xml:space="preserve">${escapeXml(group.address)}</w:t></w:r></w:p></w:tc>`;
  const addressRow = `<w:tr><w:trPr><w:cantSplit/></w:trPr>${addressCell}</w:tr>`;
  const memberRows = group.members.map((member, rowIndex) => {
    const cells = member.map((value, index) => {
      const width = columnWidths[index];
      // * 11100911 修正號碼文字顯示為橫向
      const direction = index < 2 ? "lrTb" : "btLr";
      const keepTogether = index < 2 || index === 4;
      const noWrap = keepTogether ? "<w:noWrap/>" : "";
      const fitText = keepTogether ? "<w:tcFitText/>" : "";
      const runDirection = index < 2 ? '<w:vert w:val="vert270"/>' : "";
      return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>` +
        `${noWrap}${fitText}<w:tcMar><w:top w:w="0" w:type="dxa"/>` +
        '<w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/>' +
        '<w:right w:w="0" w:type="dxa"/></w:tcMar>' +
        `<w:textDirection w:val="${direction}"/><w:vAlign w:val="center"/></w:tcPr>` +
        '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>' +
        `<w:r><w:rPr>${runDirection}<w:sz w:val="${group.fontSize * 2}"/>` +
        `</w:rPr><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:p></w:tc>`;
    }).join("");
    const row = `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cells}</w:tr>`;
    return rowIndex === 0 ? row : buildWordSpacerRow(columnWidths, 100) + row;
  }).join("");
  const addressGap = buildWordSpacerRow(columnWidths, 50);
  return `<w:tbl><w:tblPr><w:tblW w:w="${totalWidth}" w:type="dxa"/>` +
    `<w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/>` +
    '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>' +
    '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>' +
    `</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${addressRow}${addressGap}${memberRows}</w:tbl>`;
}

function buildWordSpacerRow(columnWidths, height) {
  const totalWidth = columnWidths.reduce((total, width) => total + width, 0);
  const cell =
    `<w:tc><w:tcPr><w:tcW w:w="${totalWidth}" w:type="dxa"/>` +
    `<w:gridSpan w:val="${columnWidths.length}"/>` +
    '<w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>' +
    '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar>' +
    '</w:tcPr><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>' +
    '</w:pPr></w:p></w:tc>';
  return `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${height}" w:hRule="exact"/></w:trPr>${cell}</w:tr>`;
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getCellText(value, timezone, datePattern) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, timezone, datePattern || "yyyy年MM月dd日");
  }
  return value == null ? "" : String(value).trim();
}

// * 11092304 Word 文字270 度旋轉，A3直向
function createA3PortraitWordFile(groups, docTitle) {
  const files = [
    Utilities.newBlob(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
      "application/xml",
      "[Content_Types].xml"
    ),
    Utilities.newBlob(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
      "application/xml",
      "_rels/.rels"
    ),
    Utilities.newBlob(buildWordDocumentXml(groups), "application/xml", "word/document.xml"),
  ];
  const docxBlob = Utilities.zip(files, `${docTitle}_A3直式.docx`)
    .setContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  return DriveApp.createFile(docxBlob);
}
